// The autopilot daemon on an anvil fork of Mantle Sepolia (DESIGN §7.3, §9.1 items 3, 6, 7): the
// human sets up with the published `mantle-aa` CLI, then `mantle-meme autopilot start` runs the
// detached daemon from the exported agent home against the deployed MemeLaunchpad, CaliburEntry +
// AgentPolicyHook and a local sponsor; a market EOA creates and pumps tokens, chain time is moved
// with `evm_increaseTime` for the max hold, and a real `mantle-aa session revoke` ends it. Telegram
// is a local mock of the Bot API.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentPolicyHookAbi, mantleSepolia, PolicyViolationError } from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  approveCall,
  buyCall,
  createTokenCall,
  loadDeployments,
  openAgentSession,
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
const HOOK = book.agentPolicyHook;
const mUSD = (n: number) => parseUnits(String(n), 6);

const MNEMONIC = "test test test test test test test test test test test junk";
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 3 });
const RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);
const ROOT_PASSWORD = "root-password";
const AGENT_PASSWORD = "agent-password";
const TG_TOKEN = "987654:AUTOPILOT-SECRET-TOKEN";
const TAG = Math.random().toString(36).slice(2, 6).toUpperCase();

/** 4 mUSD per token against a 10 mUSD limit: two buys, then budget_exhausted. */
const STRATEGY = {
  entry: {
    amountPerToken: "4",
    maxAgeSeconds: 60,
    keywords: ["moon"],
    excludeOwn: true,
    maxOpenPositions: 10,
    maxEntryPriceMultiple: 2,
  },
  exit: {
    takeProfitPercent: 50,
    takeProfitSellPercent: 50,
    maxHoldMinutes: 1,
    stopLossPercent: null,
  },
  slippagePercent: 3,
};

describe.skipIf(!rpcUrl)("mantle-meme autopilot daemon (fork)", { timeout: 180_000 }, () => {
  let stopFork: (() => void) | undefined;
  let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
  let forkUrl: string;
  let client: ReturnType<typeof publicClient>;
  const rootKey = generatePrivateKey();
  const me = privateKeyToAddress(rootKey);
  const dir = mkdtempSync(join(tmpdir(), "meme-autopilot-fork-"));
  const rootHome = join(dir, "root");
  const agentHome = join(dir, "agent");
  const strategyFile = join(dir, "strategy.json");
  const files = autopilotFiles(agentHome);
  let rootEnv: Record<string, string>;
  let agentEnv: Record<string, string>;
  let keyHash: Hex;
  /** Every daemon pid this test started, killed in afterAll if still alive. */
  const pids: number[] = [];
  /** Every `--json` output of an autopilot command, checked for the bot token. */
  const outputs: string[] = [];
  const pushed: { url: string; text: string }[] = [];
  const tg = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    pushed.push({ url: req.url ?? "", text: JSON.parse(body).text });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });

  const publicClient = (url: string) =>
    createPublicClient({ chain: mantleSepolia, transport: http(url), pollingInterval: 50 });

  const meme = async (...args: string[]) => {
    const r = await mantleMeme([...args, "--json"], agentEnv);
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  const aa = (args: string[], env = rootEnv, input?: string) =>
    mantleAa([...args, "--json"], env, input);

  function ok(r: Ran, command: string) {
    expect(r.code, r.stderr || r.stdout).toBe(0);
    expect(r.json).toMatchObject({ ok: true, command });
    return r.json.result;
  }

  const hookRead = (fn: "inventory" | "remainingLimit", t: Address) =>
    client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: fn as "inventory",
      args: [keyHash, me, t],
    });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

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

  async function marketToken(name: string, symbol: string): Promise<Address> {
    const salt = randomSalt();
    await market(createTokenCall(PAD, { name, symbol, salt }));
    return predictTokenAddress(PAD, MARKET.address, salt, name, symbol);
  }

  const marketBuy = async (token: Address, amount: number) =>
    market(
      buyCall(PAD, {
        token,
        amount: mUSD(amount),
        minOut: 0n,
        deadline: (await client.getBlock()).timestamp + 300n,
        recipient: MARKET.address,
      }),
    );

  beforeAll(async () => {
    await new Promise<void>((r) => tg.listen(0, "127.0.0.1", r));
    const fork = await startFork(rpcUrl as string);
    stopFork = fork.stop;
    forkUrl = fork.url;
    client = publicClient(fork.url);
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
        allowlist: [me],
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
    const chain = { MANTLE_AA_RPC_URL: fork.url, MANTLE_AA_SPONSOR_URL: sponsor.url };
    rootEnv = { ...chain, MANTLE_AA_HOME: rootHome, MANTLE_AA_KEYSTORE_PASSWORD: ROOT_PASSWORD };
    agentEnv = {
      ...chain,
      MANTLE_AA_HOME: agentHome,
      MANTLE_AA_KEYSTORE_PASSWORD: AGENT_PASSWORD,
      MANTLE_MEME_TG_BOT_TOKEN: TG_TOKEN,
      MANTLE_MEME_TG_CHAT_ID: "4242",
      MANTLE_MEME_TG_API_URL: `http://127.0.0.1:${(tg.address() as AddressInfo).port}`,
      MANTLE_MEME_AUTOPILOT_TICK_MS: "300",
      MANTLE_MEME_AUTOPILOT_POLL_MS: "200",
    };

    // The human (DESIGN §8.1): a 10 mUSD limit and 10 mUSD minted to the account.
    ok(await aa(["keys", "import", "--name", "owner"], rootEnv, rootKey), "keys import");
    const policy = await mantleMeme(
      [
        "policy",
        "init",
        "--total",
        "10",
        "--per-day",
        "10",
        "--out",
        join(dir, "policy.json"),
        "--json",
      ],
      rootEnv,
    );
    const next: string[] = ok(policy, "policy init").next;
    const init = ok(
      await aa(["account", "init", "--grant", join(dir, "policy.json"), "--agent", "trader"]),
      "account init",
    );
    keyHash = init.session.keyHash;
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
    tg.close();
    await sponsor?.close();
    stopFork?.();
  }, 30_000);

  let moon: Address;

  it("start detaches the daemon; a second start is exit 44", async () => {
    const r = ok(await meme("autopilot", "start", "--strategy", strategyFile), "autopilot start");
    pids.push(r.pid);
    expect(r).toMatchObject({
      pid: expect.any(Number),
      account: me,
      keyHash,
      fromBlock: expect.any(String),
      strategy: STRATEGY,
      files: { dir: files.dir, events: files.events },
    });
    expect(alive(r.pid)).toBe(true);
    expect(readFileSync(files.pid, "utf8")).toBe(String(r.pid));
    const status = ok(await meme("autopilot", "status"), "autopilot status");
    expect(status).toMatchObject({
      running: true,
      pid: r.pid,
      strategy: STRATEGY,
      state: { status: "running", account: me, budgetExhausted: false, positions: [] },
    });
    const again = await meme("autopilot", "start", "--strategy", strategyFile);
    expect(again.code).toBe(44);
    expect(again.json.error).toMatchObject({
      code: "AUTOPILOT_STATE",
      message: `Autopilot is already running (pid ${r.pid})`,
    });
    expect(readEvents(agentHome).filter((e) => e.event === "started")).toHaveLength(1);
  });

  it("buys a new matching token within maxAgeSeconds; skips one the keywords miss", async () => {
    const plain = await marketToken(`Plain ${TAG}`, `PLN${TAG}`);
    moon = await marketToken(`Moon ${TAG}`, `MOON${TAG}`);
    const skipped = await event((e) => e.event === "skipped" && e.token === plain);
    expect(skipped).toMatchObject({ reason: "keywords", symbol: `PLN${TAG}` });
    const bought = await event((e) => e.event === "bought" && e.token === moon);
    expect(bought).toMatchObject({
      symbol: `MOON${TAG}`,
      hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      explorer: expect.stringContaining("/tx/0x"),
      spent: { human: "4", base: "4000000" },
      fee: { human: "0.04", base: "40000" },
    });
    expect(Number(bought.ageSeconds)).toBeLessThanOrEqual(60);
    const inventory = await hookRead("inventory", moon);
    expect(inventory).toBe(BigInt((bought.tokens as { base: string }).base));
    expect(readJournal(agentHome).map((r) => [r.token, r.side])).toEqual([[moon, "buy"]]);
    expect(await hookRead("remainingLimit", USD)).toBe(mUSD(6));
  });

  it("a pump triggers take-profit once: sells takeProfitSellPercent of the inventory", async () => {
    const before = await hookRead("inventory", moon);
    await marketBuy(moon, 100);
    const sold = await event((e) => e.event === "sold" && e.token === moon);
    expect(sold).toMatchObject({ reason: "take_profit", sold: { base: (before / 2n).toString() } });
    const received = BigInt((sold.received as { base: string }).base);
    const cost = BigInt((sold.costBasis as { base: string }).base);
    expect(received * 100n).toBeGreaterThanOrEqual(cost * 150n);
    expect(await hookRead("inventory", moon)).toBe(before - before / 2n);
    // Pumped further, no second take-profit.
    await marketBuy(moon, 50);
    await sleep(1_500);
    expect(readEvents(agentHome).filter((e) => e.event === "sold")).toHaveLength(1);
  });

  it("max hold (chain time) sells the rest of the inventory", async () => {
    await client.request({ method: "evm_increaseTime" as never, params: [61] as never });
    await client.request({ method: "evm_mine" as never, params: [] as never });
    const sold = await event(
      (e) => e.event === "sold" && e.token === moon && e.reason === "max_hold",
    );
    expect(sold.sold).toBeDefined();
    expect(await hookRead("inventory", moon)).toBe(0n);
    const status = ok(await meme("autopilot", "status"), "autopilot status");
    expect(status.state.positions).toEqual([
      expect.objectContaining({ token: moon, status: "closed", takeProfitDone: true }),
    ]);
  });

  it("budget_exhausted once the remaining limit is below amountPerToken", async () => {
    const second = await marketToken(`Moon two ${TAG}`, `MTWO${TAG}`);
    await event((e) => e.event === "bought" && e.token === second);
    expect(await hookRead("remainingLimit", USD)).toBe(mUSD(2));
    const third = await marketToken(`Moon three ${TAG}`, `MTHR${TAG}`);
    const exhausted = await event((e) => e.event === "budget_exhausted");
    expect(exhausted).toMatchObject({
      needed: { base: "4000000" },
      remainingLimit: { base: "2000000" },
    });
    await marketToken(`Moon four ${TAG}`, `MFOU${TAG}`);
    await sleep(1_000);
    expect(readEvents(agentHome).filter((e) => e.event === "budget_exhausted")).toHaveLength(1);
    expect(readEvents(agentHome).some((e) => e.event === "bought" && e.token === third)).toBe(
      false,
    );
  });

  it("stop ends the daemon after its step; a restart manages the open positions again", async () => {
    const { pid } = ok(await meme("autopilot", "status"), "autopilot status");
    const stopped = ok(await meme("autopilot", "stop"), "autopilot stop");
    expect(stopped).toEqual({ pid, stopped: true, forced: false });
    expect(alive(pid)).toBe(false);
    expect(existsSync(files.pid)).toBe(false);
    expect(readEvents(agentHome).at(-1)).toMatchObject({ event: "stopped", reason: "stop" });
    const after = ok(await meme("autopilot", "status"), "autopilot status");
    expect(after).toMatchObject({ running: false, pid: null, state: { status: "stopped" } });

    const r = ok(await meme("autopilot", "start", "--strategy", strategyFile), "autopilot start");
    pids.push(r.pid);
    const status = ok(await meme("autopilot", "status"), "autopilot status");
    expect(status.state).toMatchObject({ status: "running", pid: r.pid, budgetExhausted: false });
    expect(status.state.positions).toEqual([
      expect.objectContaining({ symbol: `MTWO${TAG}`, status: "open" }),
    ]);
  });

  it("revoke: the idle daemon emits session_ended and exits; the agent's next command is exit 13", async () => {
    const { pid } = ok(await meme("autopilot", "status"), "autopilot status");
    ok(await aa(["session", "revoke", "--agent", "trader"]), "session revoke");
    const ended = await event((e) => e.event === "session_ended");
    expect(ended).toMatchObject({
      exitCode: 13,
      code: "KEY_EXPIRED_OR_REVOKED",
      message: expect.stringMatching(/Session key is not registered on the account/),
    });
    for (const until = Date.now() + 30_000; alive(pid); await sleep(100)) {
      if (Date.now() > until) throw new Error(`daemon ${pid} still running after session_ended`);
    }
    expect(existsSync(files.pid)).toBe(false);
    expect(readEvents(agentHome).at(-1)).toMatchObject({
      event: "stopped",
      reason: "session_ended",
    });
    const status = ok(await meme("autopilot", "status"), "autopilot status");
    expect(status).toMatchObject({ running: false, pid: null, state: { status: "session_ended" } });
    expect((await meme("autopilot", "stop")).code).toBe(44);

    // Premise (measured): after `session revoke`, the AA SDK refuses at simulate, before any send.
    const session = openAgentSession({
      home: agentHome,
      password: AGENT_PASSWORD,
      client,
      addresses: book,
    });
    const err = await session.simulate([]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PolicyViolationError);
    expect((err as PolicyViolationError).reason).toBe(
      "Session key is not registered on the account",
    );
    const buy = await meme("buy", moon, "--amount", "1");
    expect(buy.code).toBe(13);
    expect(buy.json.error.code).toBe("KEY_EXPIRED_OR_REVOKED");
  });

  it("Telegram: every pushed event reached the mock; the token is in no file or output", async () => {
    await sleep(500);
    for (const p of pushed) expect(p.url).toBe(`/bot${TG_TOKEN}/sendMessage`);
    const texts = pushed.map((p) => p.text);
    expect(texts[0]).toMatch(/^Autopilot started: 4 mUSD per new token/);
    expect(texts.filter((t) => t.startsWith(`Bought MOON${TAG}`))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("Bought MTWO"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith(`Sold MOON${TAG} (take-profit)`))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith(`Sold MOON${TAG} (max hold)`))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("Budget exhausted"))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("Session ended"))).toHaveLength(1);
    expect(texts.filter((t) => t === "Autopilot stopped (stop).")).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith("Autopilot started"))).toHaveLength(2);
    expect(texts.at(-1)).toBe("Autopilot stopped (session_ended).");
    expect(texts.some((t) => t.includes("PLN"))).toBe(false);
    for (const file of [files.events, files.state, files.strategy, files.log]) {
      if (existsSync(file)) expect(readFileSync(file, "utf8")).not.toContain("SECRET");
    }
    for (const o of outputs) expect(o).not.toContain("SECRET");
  });
});
