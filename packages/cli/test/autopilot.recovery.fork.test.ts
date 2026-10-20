// The autopilot daemon on an anvil fork of Mantle Sepolia (DESIGN §7.3, D33): a trade it confirmed
// is never lost from its managed positions nor repeated, whatever fails after the confirmation.
// The daemon's RPC goes through a local JSON-RPC proxy that can fail every read of a block by
// number; a crash right after a confirmed trade is the daemon's SIGKILL of itself at that point
// (`CRASH_ENV`, a test-only setting), the earliest a crash can come after the journal append.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mantleSepolia } from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  approveCall,
  buyCall,
  createTokenCall,
  loadDeployments,
  predictTokenAddress,
  randomSalt,
  readJournal,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  isAddressEqual,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFork } from "../../../e2e/launchpad/fork.js";
import { type AutopilotEvent, autopilotFiles, CRASH_ENV, readEvents } from "../src/autopilot.js";
import { mantleAa, mantleMeme, type Ran } from "./helpers.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const PAD = book.memeLaunchpad as Address;
const USD = book.mockUsd;
const mUSD = (n: number) => parseUnits(String(n), 6);

const MNEMONIC = "test test test test test test test test test test test junk";
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
const RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);
const ROOT_PASSWORD = "root-password";
const AGENT_PASSWORD = "agent-password";
const TAG = Math.random().toString(36).slice(2, 6).toUpperCase();

/** 3 mUSD per token against a 20 mUSD limit. */
const STRATEGY = {
  entry: { amountPerToken: "3", maxAgeSeconds: 60, keywords: [TAG] },
  exit: { takeProfitPercent: 50, takeProfitSellPercent: 50, maxHoldMinutes: 1 },
};

interface Position {
  token: Address;
  openedAt: number | null;
  status: string;
  takeProfitDone: boolean;
}

describe.skipIf(!rpcUrl)(
  "autopilot: confirmed trades reach the daemon state (fork)",
  {
    timeout: 180_000,
  },
  () => {
    let stopFork: (() => void) | undefined;
    let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
    let forkUrl: string;
    let client: ReturnType<typeof createPublicClient>;
    const rootKey = generatePrivateKey();
    const dir = mkdtempSync(join(tmpdir(), "meme-autopilot-recovery-"));
    const rootHome = join(dir, "root");
    const agentHome = join(dir, "agent");
    const strategyFile = join(dir, "strategy.json");
    const files = autopilotFiles(agentHome);
    let rootEnv: Record<string, string>;
    let agentEnv: Record<string, string>;
    /** Every daemon pid this test started, killed in afterAll if still alive. */
    const pids: number[] = [];
    /** The positions the tests below open, sold by the last one. */
    const tokens: Address[] = [];

    /** The daemon's RPC: forwards to the fork, or fails a read of a block by number. */
    let failBlockReads = false;
    let failedBlockReads = 0;
    const proxy = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const msg = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (
        failBlockReads &&
        msg.method === "eth_getBlockByNumber" &&
        String(msg.params?.[0]).startsWith("0x")
      ) {
        failedBlockReads++;
        const error = { code: -32603, message: "injected: block read failed" };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error }));
        return;
      }
      const upstream = await fetch(forkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res.end(await upstream.text());
    });

    const aa = (args: string[], env = rootEnv, input?: string) =>
      mantleAa([...args, "--json"], env, input);
    const meme = (args: string[], env = agentEnv) => mantleMeme([...args, "--json"], env);

    function ok(r: Ran, command: string) {
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.json).toMatchObject({ ok: true, command });
      return r.json.result;
    }

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    async function start(env: Record<string, string> = {}): Promise<number> {
      const r = ok(
        await meme(["autopilot", "start", "--strategy", strategyFile], { ...agentEnv, ...env }),
        "autopilot start",
      );
      pids.push(r.pid);
      return r.pid;
    }

    async function stop() {
      ok(await meme(["autopilot", "stop"]), "autopilot stop");
    }

    async function dead(pid: number) {
      for (const until = Date.now() + 60_000; alive(pid); await sleep(100)) {
        if (Date.now() > until) throw new Error(`daemon ${pid} still running`);
      }
    }

    const state = () => JSON.parse(readFileSync(files.state, "utf8"));
    const positionsOf = (token: Address): Position[] =>
      state().positions.filter((p: Position) => isAddressEqual(p.token, token));
    const recordsOf = (token: Address) =>
      readJournal(agentHome).filter((r) => isAddressEqual(r.token, token));
    const journalOf = (token: Address) => recordsOf(token).map((r) => r.side);

    /** Waits for the first event matching `match`; fails with the log so far. */
    async function event(match: (e: AutopilotEvent) => boolean, timeoutMs = 60_000) {
      for (const until = Date.now() + timeoutMs; ; await sleep(100)) {
        const found = readEvents(agentHome).find(match);
        if (found) return found;
        if (Date.now() > until) {
          throw new Error(
            `no such event within ${timeoutMs} ms:\n${readEvents(agentHome)
              .map((e) => JSON.stringify(e))
              .join("\n")}`,
          );
        }
      }
    }
    const sold = (token: Address, reason: string) =>
      event((e) => e.event === "sold" && e.token === token && e.reason === reason);

    /** Waits until a whole step of the daemon began and ended after now. */
    async function aStepLater() {
      const since = Date.now();
      const seen = new Set<string>();
      for (const until = since + 30_000; seen.size < 2; await sleep(20)) {
        const at = state().updatedAt as string;
        if (Date.parse(at) > since) seen.add(at);
        if (Date.now() > until) throw new Error("the daemon ran no step");
      }
    }

    async function market(call: { to: Address; data: Hex }) {
      const wallet = createWalletClient({
        account: MARKET,
        chain: mantleSepolia,
        transport: http(forkUrl),
      });
      const hash = await wallet.sendTransaction(call);
      for (const until = Date.now() + 30_000; ; await sleep(50)) {
        const r = await client.getTransactionReceipt({ hash }).catch(() => undefined);
        if (r) {
          expect(r.status).toBe("success");
          return r;
        }
        if (Date.now() > until) throw new Error(`no receipt for ${hash}`);
      }
    }

    async function marketToken(symbol: string): Promise<Address> {
      const salt = randomSalt();
      const name = `Recovery ${symbol}`;
      await market(createTokenCall(PAD, { name, symbol, salt }));
      return predictTokenAddress(PAD, MARKET.address, salt, name, symbol);
    }

    const pump = async (token: Address) =>
      market(
        buyCall(PAD, {
          token,
          amount: mUSD(100),
          minOut: 0n,
          deadline: (await client.getBlock()).timestamp + 300n,
          recipient: MARKET.address,
        }),
      );

    beforeAll(async () => {
      const fork = await startFork(rpcUrl as string);
      stopFork = fork.stop;
      forkUrl = fork.url;
      client = createPublicClient({
        chain: mantleSepolia,
        transport: http(fork.url),
        pollingInterval: 50,
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const config: SponsorConfig = {
        chainId: book.chainId,
        rpcUrl: fork.url,
        listen: { host: "127.0.0.1", port: 0 },
        database: ":memory:",
        relayer: RELAYER.address,
        relayerKeyEnv: "E2E_RELAYER_KEY",
        settleTimeoutSeconds: 30,
        addresses: book,
        maxRequestValiditySeconds: 300,
        policy: {
          allowlist: [privateKeyToAddress(rootKey)],
          accountDailyGas: 1_000_000_000n,
          maxFeePerRequest: parseEther("0.5"),
          dailyBudget: parseEther("5"),
          managementReserve: parseEther("1"),
        },
      };
      sponsor = await startSponsor(config, {
        env: { E2E_RELAYER_KEY: RELAYER_KEY },
        pollIntervalMs: 100,
      });
      rootEnv = {
        MANTLE_AA_RPC_URL: fork.url,
        MANTLE_AA_SPONSOR_URL: sponsor.url,
        MANTLE_AA_HOME: rootHome,
        MANTLE_AA_KEYSTORE_PASSWORD: ROOT_PASSWORD,
      };
      agentEnv = {
        MANTLE_AA_RPC_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        MANTLE_AA_SPONSOR_URL: sponsor.url,
        MANTLE_AA_HOME: agentHome,
        MANTLE_AA_KEYSTORE_PASSWORD: AGENT_PASSWORD,
        MANTLE_MEME_AUTOPILOT_TICK_MS: "300",
        MANTLE_MEME_AUTOPILOT_POLL_MS: "200",
      };

      // The human (DESIGN §8.1): a 20 mUSD limit and 20 mUSD minted to the account.
      ok(await aa(["keys", "import", "--name", "owner"], rootEnv, rootKey), "keys import");
      const policyFile = join(dir, "policy.json");
      const policy = await mantleMeme(
        ["policy", "init", "--total", "20", "--per-day", "20", "--out", policyFile, "--json"],
        rootEnv,
      );
      const next: string[] = ok(policy, "policy init").next;
      ok(await aa(["account", "init", "--grant", policyFile, "--agent", "trader"]), "account init");
      ok(
        await aa(["session", "export", "--agent", "trader", "--out", agentHome], {
          ...rootEnv,
          MANTLE_AA_EXPORT_PASSWORD: AGENT_PASSWORD,
        }),
        "session export",
      );
      const calls = /^mantle-aa account exec --calls '(.*)'$/.exec(next[2] as string)?.[1];
      ok(await aa(["account", "exec", "--calls", calls as string]), "account exec");

      const mint = parseAbi(["function mint(address to, uint256 amount)"]);
      await market({
        to: USD,
        data: encodeFunctionData({ abi: mint, args: [MARKET.address, mUSD(10_000)] }),
      });
      await market(approveCall(USD, PAD, maxUint256));
      writeFileSync(strategyFile, JSON.stringify(STRATEGY));
    }, 300_000);

    afterAll(async () => {
      // A daemon left running on a shared machine is a defect: kill every pid this test started.
      const fromFile = Number(
        existsSync(files.pid) ? readFileSync(files.pid, "utf8").trim() : Number.NaN,
      );
      for (const pid of [...pids, fromFile]) {
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      }
      proxy.close();
      await sponsor?.close();
      stopFork?.();
    }, 30_000);

    it("a block read failing after a confirmed buy: the position stays managed and is sold later", async () => {
      await start();
      failBlockReads = true;
      const token = await marketToken(`A${TAG}`);
      try {
        await event((e) => e.event === "bought" && e.token === token);
        // Bought while every read of a block by number fails: the position is managed regardless.
        expect(positionsOf(token)).toEqual([
          expect.objectContaining({ status: "open", openedAt: null, takeProfitDone: false }),
        ]);
        await event((e) => e.event === "error" && e.source === "step");
        expect(failedBlockReads).toBeGreaterThan(0);
      } finally {
        failBlockReads = false;
      }

      await pump(token);
      await sold(token, "take_profit");
      const [buy] = readJournal(agentHome).filter((r) => isAddressEqual(r.token, token));
      const block = await client.getBlock({ blockNumber: buy?.blockNumber as bigint });
      expect(positionsOf(token)).toEqual([
        expect.objectContaining({ openedAt: Number(block.timestamp), takeProfitDone: true }),
      ]);
      tokens.push(token);
    });

    it("a crash right after a confirmed buy: the restart manages the position once and sells it", async () => {
      await stop();
      const crashing = await start({ [CRASH_ENV]: "buy" });
      const token = await marketToken(`B${TAG}`);
      await dead(crashing);
      expect(journalOf(token)).toEqual(["buy"]);
      expect(positionsOf(token)).toEqual([]); // the crash came before the position was recorded
      // The checkpointed trade id reached that trade's own journal record through `execute`.
      expect(state().pending).toMatchObject({ token, reason: "buy" });
      expect(recordsOf(token).map((r) => r.correlationId)).toEqual([state().pending.id]);

      await start();
      expect(positionsOf(token)).toEqual([
        expect.objectContaining({ status: "open", takeProfitDone: false }),
      ]);
      expect(state().pending).toBeNull();
      await pump(token);
      await sold(token, "take_profit");
      expect(positionsOf(token)).toEqual([
        expect.objectContaining({ status: "open", takeProfitDone: true }),
      ]);
      tokens.push(token);
    });

    it("a crash right after a confirmed take-profit: the restart does not take profit again", async () => {
      const token = await marketToken(`C${TAG}`);
      await event((e) => e.event === "bought" && e.token === token);
      await stop();
      const crashing = await start({ [CRASH_ENV]: "take_profit" });
      await pump(token);
      await dead(crashing);
      expect(journalOf(token)).toEqual(["buy", "sell"]);
      expect(positionsOf(token)).toEqual([expect.objectContaining({ takeProfitDone: false })]);
      expect(state().pending).toMatchObject({ token, reason: "take_profit" });
      expect(recordsOf(token)[1]?.correlationId).toBe(state().pending.id);

      await start();
      expect(positionsOf(token)).toEqual([
        expect.objectContaining({ status: "open", takeProfitDone: true }),
      ]);
      // Pumped again, and a whole step later still no second take-profit.
      await pump(token);
      await aStepLater();
      expect(journalOf(token)).toEqual(["buy", "sell"]);
      expect(readEvents(agentHome).some((e) => e.event === "sold" && e.token === token)).toBe(
        false,
      );
      tokens.push(token);
    });

    it("max hold (chain time) sells the rest of each of these positions", async () => {
      // Once only: the AA SDK signs a request valid for 120 s of wall-clock time.
      await client.request({ method: "evm_increaseTime" as never, params: [61] as never });
      await client.request({ method: "evm_mine" as never, params: [] as never });
      expect(tokens).toHaveLength(3);
      for (const token of tokens) {
        await sold(token, "max_hold");
        expect(positionsOf(token)).toEqual([
          expect.objectContaining({ status: "closed", takeProfitDone: true }),
        ]);
        expect(journalOf(token)).toEqual(["buy", "sell", "sell"]);
      }
    });
  },
);
