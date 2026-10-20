// The autopilot daemon on an anvil fork of Mantle Sepolia (DESIGN §7.3): `maxAgeSeconds` is checked
// against a new token's age when the watcher observed it, not when a busy daemon processes it.
// The daemon's RPC and sponsor go through local proxies: the sponsor proxy holds every relay to
// keep a buy pending, the RPC proxy holds every `eth_getLogs` to keep the watcher from seeing a
// token; chain time is moved with `evm_increaseTime` meanwhile.
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
  createTokenCall,
  loadDeployments,
  predictTokenAddress,
  randomSalt,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  type Hex,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFork } from "../../../e2e/launchpad/fork.js";
import { type AutopilotEvent, autopilotFiles, readEvents } from "../src/autopilot.js";
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
const MAX_AGE = 60;
/** Chain time moved past `maxAgeSeconds` while an event waits (twice: under the AA SDK's 120 s). */
const ADVANCE = 75;

const STRATEGY = {
  entry: { amountPerToken: "3", maxAgeSeconds: MAX_AGE, keywords: [TAG] },
  exit: { takeProfitPercent: 50, takeProfitSellPercent: 50, maxHoldMinutes: 60 },
};

/** A gate requests wait at while it is closed. */
function gate() {
  let open = Promise.resolve();
  let release = () => {};
  let held = 0;
  return {
    close() {
      open = new Promise<void>((r) => {
        release = r;
      });
      held = 0;
    },
    open: () => release(),
    get held() {
      return held;
    },
    async pass(hold: boolean) {
      if (!hold) return;
      held++;
      await open;
    },
  };
}

describe.skipIf(!rpcUrl)(
  "autopilot: a new token's age is its age when the watcher saw it (fork)",
  { timeout: 180_000 },
  () => {
    let stopFork: (() => void) | undefined;
    let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
    let forkUrl: string;
    let client: ReturnType<typeof createPublicClient>;
    const rootKey = generatePrivateKey();
    const dir = mkdtempSync(join(tmpdir(), "meme-autopilot-age-"));
    const rootHome = join(dir, "root");
    const agentHome = join(dir, "agent");
    const strategyFile = join(dir, "strategy.json");
    const files = autopilotFiles(agentHome);
    let rootEnv: Record<string, string>;
    let agentEnv: Record<string, string>;
    const pids: number[] = [];

    const relays = gate();
    let holdRelays = false;
    const sponsorProxy = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      await relays.pass(holdRelays);
      const bodyless = req.method === "GET" || req.method === "HEAD";
      const upstream = await fetch(new URL(req.url ?? "/", sponsor?.url), {
        method: req.method ?? "GET",
        headers: { "content-type": req.headers["content-type"] ?? "application/json" },
        ...(bodyless ? {} : { body }),
      });
      res.statusCode = upstream.status;
      res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
      res.end(await upstream.text());
    });

    const logReads = gate();
    let holdLogs = false;
    /** Every `eth_getLogs` answer the daemon got. */
    const logAnswers: string[] = [];
    const rpcProxy = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const getLogs = body.includes('"eth_getLogs"');
      if (getLogs) await logReads.pass(holdLogs);
      const upstream = await fetch(forkUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const text = await upstream.text();
      if (getLogs) logAnswers.push(text.toLowerCase());
      res.setHeader("content-type", "application/json");
      res.end(text);
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

    async function until(what: string, done: () => boolean, timeoutMs = 60_000) {
      for (const end = Date.now() + timeoutMs; !done(); await sleep(50)) {
        if (Date.now() > end) {
          const log = readEvents(agentHome).map((e) => JSON.stringify(e));
          throw new Error(`${what}: not within ${timeoutMs} ms:\n${log.join("\n")}`);
        }
      }
    }

    /** The daemon's verdict on a new token: bought or skipped. */
    async function verdict(token: Address): Promise<AutopilotEvent> {
      const of = () =>
        readEvents(agentHome).find(
          (e) => e.token === token && (e.event === "bought" || e.event === "skipped"),
        );
      await until(`a verdict on ${token}`, () => of() !== undefined);
      return of() as AutopilotEvent;
    }

    async function market(call: { to: Address; data: Hex }) {
      const wallet = createWalletClient({
        account: MARKET,
        chain: mantleSepolia,
        transport: http(forkUrl),
      });
      const hash = await wallet.sendTransaction(call);
      for (const end = Date.now() + 30_000; ; await sleep(50)) {
        const r = await client.getTransactionReceipt({ hash }).catch(() => undefined);
        if (r) {
          expect(r.status).toBe("success");
          return r;
        }
        if (Date.now() > end) throw new Error(`no receipt for ${hash}`);
      }
    }

    async function marketToken(symbol: string) {
      const salt = randomSalt();
      const name = `Age ${symbol}`;
      const r = await market(createTokenCall(PAD, { name, symbol, salt }));
      return {
        token: predictTokenAddress(PAD, MARKET.address, salt, name, symbol),
        tx: r.transactionHash.toLowerCase(),
      };
    }

    async function advance(seconds: number) {
      await client.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
      await client.request({ method: "evm_mine" as never, params: [] as never });
    }

    beforeAll(async () => {
      const fork = await startFork(rpcUrl as string);
      stopFork = fork.stop;
      forkUrl = fork.url;
      client = createPublicClient({
        chain: mantleSepolia,
        transport: http(fork.url),
        pollingInterval: 50,
      });
      await new Promise<void>((r) => rpcProxy.listen(0, "127.0.0.1", r));
      await new Promise<void>((r) => sponsorProxy.listen(0, "127.0.0.1", r));
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
      const port = (s: typeof rpcProxy) => (s.address() as AddressInfo).port;
      rootEnv = {
        MANTLE_AA_RPC_URL: fork.url,
        MANTLE_AA_SPONSOR_URL: sponsor.url,
        MANTLE_AA_HOME: rootHome,
        MANTLE_AA_KEYSTORE_PASSWORD: ROOT_PASSWORD,
      };
      agentEnv = {
        MANTLE_AA_RPC_URL: `http://127.0.0.1:${port(rpcProxy)}`,
        MANTLE_AA_SPONSOR_URL: `http://127.0.0.1:${port(sponsorProxy)}`,
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
      const r = ok(
        await meme(["autopilot", "start", "--strategy", strategyFile]),
        "autopilot start",
      );
      pids.push(r.pid);
    }, 300_000);

    afterAll(async () => {
      holdRelays = false;
      holdLogs = false;
      relays.open();
      logReads.open();
      // A daemon left running on a shared machine is a defect: kill every pid this test started.
      const fromFile = Number(
        existsSync(files.pid) ? readFileSync(files.pid, "utf8").trim() : Number.NaN,
      );
      for (const pid of [...pids, fromFile]) {
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) process.kill(pid, "SIGKILL");
      }
      rpcProxy.close();
      sponsorProxy.close();
      await sponsor?.close();
      stopFork?.();
    }, 30_000);

    it("a token observed young, queued behind a pending buy while chain time passes maxAgeSeconds, is bought", async () => {
      relays.close();
      holdRelays = true;
      const a = await marketToken(`A${TAG}`);
      try {
        await until("the buy of A at the sponsor", () => relays.held > 0);
        const b = await marketToken(`B${TAG}`);
        // The watcher saw B (and read the head right after) while the buy of A is still pending.
        await until("the watcher seeing B", () => logAnswers.some((t) => t.includes(b.tx)));
        await sleep(1_000);
        expect(readEvents(agentHome).some((e) => e.token === a.token)).toBe(false);
        await advance(ADVANCE);
        holdRelays = false;
        relays.open();

        expect(await verdict(a.token)).toMatchObject({ event: "bought" });
        const vb = await verdict(b.token);
        expect([vb.event, vb.reason]).toEqual(["bought", undefined]);
        expect(Number(vb.ageSeconds)).toBeLessThan(MAX_AGE);
      } finally {
        holdRelays = false;
        relays.open();
      }
    });

    it("a token already older than maxAgeSeconds when the watcher sees it is skipped too_old", async () => {
      logReads.close();
      holdLogs = true;
      try {
        await until("the watcher polling", () => logReads.held > 0);
        const c = await marketToken(`C${TAG}`);
        await advance(ADVANCE);
        holdLogs = false;
        logReads.open();
        expect(await verdict(c.token)).toMatchObject({ event: "skipped", reason: "too_old" });
      } finally {
        holdLogs = false;
        logReads.open();
      }
    });
  },
);
