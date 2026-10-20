// DESIGN §9.1 items 1–8 as one ordered flow through the real binaries: the human sets up with
// `mantle-meme policy init` and the published `mantle-aa`, the agent runs `mantle-meme` (and the
// autopilot daemon) from the exported agent home alone, `tools/market-sim` EOAs are the market, and
// a `mantle-aa sponsor serve` process relays every transaction of the account. The same flow runs
// on an anvil fork in CI (`acceptance.fork.test.ts`) and once on Mantle Sepolia (`sepolia.ts`);
// only the clock differs: on a fork `evm_increaseTime` moves chain time, on Sepolia the flow waits.
//
// Local JSON-RPC proxies sit in front of the chain and the sponsor. They change nothing they
// forward; they record every transaction the market-sim EOAs and the sponsor's relayer send (the
// run's transaction list), every sponsor reply (no `SPONSOR_BUSY` may appear), and they hold one
// reply to make a race deterministic (item 6 slippage, item 8 concurrency).
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentPolicyHookAbi, mantleSepolia, readProfiles } from "@0xwh1sker/mantle-aa-sdk";
import {
  approveCall,
  buyCall,
  curveState,
  loadDeployments,
  memeLaunchpadAbi,
  quoteBuy,
  quoteSell,
  readJournal,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  type Hex,
  http,
  type LocalAccount,
  maxUint256,
  type PublicClient,
  parseAbi,
  parseEventLogs,
  parseUnits,
  type TransactionReceipt,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import {
  type AutopilotEvent,
  autopilotFiles,
  readEvents,
} from "../../packages/cli/src/autopilot.js";
import { CURVE_COMPLETED_TEXT } from "../../packages/cli/src/errors.js";
import {
  AA_BIN,
  mantleAa,
  mantleMeme,
  memeArgs,
  type Ran,
} from "../../packages/cli/test/helpers.js";
import { MarketSim, type SimEvent } from "../../tools/market-sim/src/sim.js";

export interface FlowConfig {
  /** `fork`: an anvil fork (chain time is moved); `sepolia`: the real chain (the flow waits). */
  mode: "fork" | "sepolia";
  /** The chain's JSON-RPC URL. Never printed. */
  rpcUrl: string;
  /** The sponsor's relayer hot wallet, handed to `mantle-aa sponsor serve` through its env. */
  relayerKey: Hex;
  /** Three market-sim EOAs holding MNT for their own gas. */
  sim: readonly LocalAccount[];
  /** Homes, the sponsor's config, database and log. */
  dir: string;
  /** The autopilot's tick and watcher poll (`MANTLE_MEME_AUTOPILOT_TICK_MS` / `_POLL_MS`). */
  tickMs: number;
  pollMs: number;
  /** Plain-text secrets (keys, mnemonic) that must appear in no output or file of the run. */
  secrets: readonly string[];
  log: (line: string) => void;
}

/** One §9.1 step; the fork suite runs each as a test, the Sepolia script in order. */
export interface Step {
  item: string;
  name: string;
  run: (a: Acceptance) => Promise<void>;
}

/** A transaction of the run: what sent it and why. */
export interface RunTx {
  hash: Hex;
  item: string;
  what: string;
}

const book = loadDeployments();
const PAD = book.memeLaunchpad as Address;
const USD = book.mockUsd;
const HOOK = book.agentPolicyHook;
export const mUSD = (n: number) => parseUnits(String(n), 6);
const human = (base: bigint) => formatUnits(base, 6);
const CURVE_TOKENS = parseUnits("800000000", 18);
const mockUsdAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const QUOTE_BUY = encodeFunctionData({
  abi: memeLaunchpadAbi,
  functionName: "quoteBuy",
  args: [PAD, 0n],
}).slice(0, 10);

/** The policy (DESIGN §8.1): every spend below is exact, so the limit runs out on schedule. */
const TOTAL = 16; // create --dev-buy 5, buy 2, autopilot 3 + 3, manual 1 → 2 left (< 3: exhausted)
/** Chain time; on Sepolia the flow waits it out, so it is short. */
const MAX_HOLD_MINUTES = 2;
const MAX_HOLD = BigInt(MAX_HOLD_MINUTES * 60);
const strategy = (tag: string) => ({
  entry: {
    amountPerToken: "3",
    maxAgeSeconds: 60,
    keywords: [`MOON${tag}`],
    excludeOwn: true,
    maxOpenPositions: 10,
    maxEntryPriceMultiple: 2,
  },
  exit: {
    takeProfitPercent: 50,
    takeProfitSellPercent: 50,
    maxHoldMinutes: MAX_HOLD_MINUTES,
    stopLossPercent: null,
  },
  slippagePercent: 3,
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls `check` until it returns a value other than `undefined` / `false`. */
async function until<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs: number,
  what: string,
  everyMs = 100,
): Promise<T> {
  for (const end = Date.now() + timeoutMs; ; await sleep(everyMs)) {
    const v = await check();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
  }
}

// ---- JSON-RPC proxy ---------------------------------------------------------------------------

interface Message {
  id?: unknown;
  method?: string;
  params?: unknown[];
}

interface Exchange {
  start: number;
  end: number;
  methods: string[];
  reply: string;
}

/**
 * Forwards every request to `target` unchanged. Records each JSON-RPC exchange and the hash of
 * every `eth_sendRawTransaction` it relayed. `before` runs before forwarding; `after` runs once the
 * target answered, before the reply goes back.
 */
class RpcProxy {
  url = "";
  readonly exchanges: Exchange[] = [];
  readonly sent: Hex[] = [];
  /** Called with the hash of every transaction relayed. */
  onSent: ((hash: Hex) => void) | undefined;
  /** Called with every failed exchange: an HTTP error, a JSON-RPC error, or no answer at all. */
  onError: ((methods: string[], detail: string) => void) | undefined;
  before: ((msgs: Message[]) => Promise<void>) | undefined;
  after: ((msgs: Message[]) => Promise<void>) | undefined;
  private readonly server = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const start = Date.now();
      let msgs: Message[] = [];
      try {
        msgs = [JSON.parse(body)].flat();
      } catch {}
      await this.before?.(msgs);
      const upstream = await this.forward(req.method ?? "POST", req.url ?? "/", body);
      const reply = upstream.text;
      if (msgs.length && (upstream.status !== 200 || reply.includes('"error"'))) {
        this.onError?.(
          msgs.map((m) => m.method ?? ""),
          `HTTP ${upstream.status} ${reply.slice(0, 300)}`,
        );
      }
      await this.after?.(msgs);
      if (msgs.length) {
        this.exchanges.push({
          start,
          end: Date.now(),
          methods: msgs.map((m) => m.method ?? ""),
          reply,
        });
        try {
          const replies = [JSON.parse(reply)].flat() as { id?: unknown; result?: unknown }[];
          for (const m of msgs) {
            const r = replies.find((x) => x.id === m.id);
            if (m.method === "eth_sendRawTransaction" && typeof r?.result === "string") {
              this.sent.push(r.result as Hex);
              this.onSent?.(r.result as Hex);
            }
          }
        } catch {}
      }
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(reply);
    } catch (e) {
      this.onError?.([], `no answer: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(502).end();
    }
  });

  /** Upstream answers of HTTP 429 (a public RPC's per-IP rate limit), each retried. */
  throttled = 0;

  constructor(private readonly target: string) {}

  /**
   * One upstream request. A rate-limited answer (HTTP 429) or no answer is retried with backoff
   * (≤ 8 times): the public RPC limits requests per IP, which is the infrastructure, not the product.
   */
  private async forward(method: string, path: string, body: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetch(`${this.target.replace(/\/$/, "")}${path}`, {
          method,
          headers: { "content-type": "application/json" },
          ...(method === "GET" ? {} : { body }),
        });
        const text = await r.text();
        if (r.status !== 429 || attempt === 8) return { status: r.status, text };
        this.throttled++;
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await sleep(Math.min(250 * 2 ** attempt, 8_000));
    }
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close() {
    this.server.closeAllConnections();
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

const isQuoteBuy = (msgs: Message[]) =>
  msgs.some(
    (m) =>
      m.method === "eth_call" &&
      (m.params?.[0] as { data?: string; input?: string } | undefined)?.data?.startsWith(QUOTE_BUY),
  );

// ---- the run ----------------------------------------------------------------------------------

export class Acceptance {
  readonly tag = Math.random().toString(36).slice(2, 7).toUpperCase();
  readonly rootKey = generatePrivateKey();
  readonly me = privateKeyToAddress(this.rootKey);
  readonly relayer: Address;
  private readonly rootPassword = generatePrivateKey().slice(2, 26);
  private readonly agentPassword = generatePrivateKey().slice(2, 26);
  readonly rootHome: string;
  readonly agentHome: string;
  client!: PublicClient;
  sim!: MarketSim;
  /** Every transaction of the run, by hash, as the flow labelled it. */
  readonly labels = new Map<Hex, RunTx>();
  /** The account's transactions (sent by the relayer). */
  private readonly accountTxs = new Set<Hex>();
  /** Every CLI output and error message, scanned for secrets at the end. */
  private readonly outputs: string[] = [];
  private readonly pids: number[] = [];
  private sponsor: ChildProcess | undefined;
  /** In front of the chain: the market-sim EOAs, the sponsor, the agent's commands. */
  private simRpc!: RpcProxy;
  private sponsorRpc!: RpcProxy;
  private agentRpc!: RpcProxy;
  /** In front of the chain: the human's commands, the daemon, this flow's own reads. */
  private chainRpc!: RpcProxy;
  /** In front of the sponsor: the human's and the agent's commands; the autopilot daemon. */
  private sponsorFront!: RpcProxy;
  private sponsorDaemon!: RpcProxy;
  private rootEnv!: Record<string, string>;
  private agentEnv!: Record<string, string>;
  private daemonEnv!: Record<string, string>;
  private simEvents: SimEvent[] = [];

  /** The §9.1 item of the running step: the label of every transaction sent meanwhile. */
  item = "";
  /** Every transaction sent, with the item of the step that sent it. */
  private readonly sentIn = new Map<Hex, string>();

  // State carried between the steps.
  keyHash!: Hex;
  agentKey!: Address;
  daemonPid = 0;
  /** The agent's own token; a market token the autopilot skips, bought by hand, then filled. */
  gate!: Address;
  gateBlock = 0n;
  plain!: Address;
  moon: Address[] = [];
  /** The agent's buys and sells of `gate`, from chain receipts. */
  private readonly ledger: { quote: bigint; tokens: bigint; side: "buy" | "sell" }[] = [];

  constructor(readonly cfg: FlowConfig) {
    assert.equal(cfg.sim.length, 3, "three market-sim EOAs");
    this.relayer = privateKeyToAccount(cfg.relayerKey).address;
    this.rootHome = join(cfg.dir, "root");
    this.agentHome = join(cfg.dir, "agent");
  }

  get files() {
    return autopilotFiles(this.agentHome);
  }

  /** Every secret of the run: the configured ones, the root key, the keystore passwords. */
  get secrets(): string[] {
    return [
      ...this.cfg.secrets,
      this.cfg.relayerKey,
      this.rootKey,
      this.rootPassword,
      this.agentPassword,
    ]
      .map((s) => s.replace(/^0x/, "").toLowerCase())
      .filter((s) => s.length >= 8);
  }

  private log(line: string) {
    this.cfg.log(line);
  }

  async start() {
    this.simRpc = await new RpcProxy(this.cfg.rpcUrl).listen();
    this.sponsorRpc = await new RpcProxy(this.cfg.rpcUrl).listen();
    this.agentRpc = await new RpcProxy(this.cfg.rpcUrl).listen();
    this.chainRpc = await new RpcProxy(this.cfg.rpcUrl).listen();
    this.client = createPublicClient({
      chain: mantleSepolia,
      transport: http(this.chainRpc.url, { timeout: 60_000, retryCount: 5 }),
      pollingInterval: this.cfg.mode === "fork" ? 50 : 1_000,
    });
    for (const p of [this.simRpc, this.sponsorRpc]) {
      p.onSent = (hash) => this.sentIn.set(hash, this.item);
    }
    // Evidence for a failure a client reports without its cause (an eth_call that reverts is one
    // too: the agent's CLI diagnoses refusals that way).
    for (const [name, p] of [
      ["market-sim", this.simRpc],
      ["sponsor", this.sponsorRpc],
      ["agent", this.agentRpc],
      ["chain", this.chainRpc],
    ] as const) {
      p.onError = (methods, detail) =>
        this.log(`${name} rpc: ${methods.join(",")} → ${this.scrub(detail)}`);
    }
    this.sim = new MarketSim({
      rpcUrl: this.simRpc.url,
      accounts: this.cfg.sim,
      seed: 7,
      pollingIntervalMs: this.cfg.mode === "fork" ? 50 : 1_000,
      receiptTimeoutMs: 180_000,
      log: (e) => {
        this.simEvents.push(e);
        if ("tx" in e) {
          const what =
            e.kind === "create"
              ? `market-sim createToken ${e.symbol}`
              : e.kind === "mint"
                ? "market-sim mints MockUSD"
                : e.kind === "pump"
                  ? `market-sim pump (+${e.percent}%)`
                  : `market-sim ${e.kind} ${human(e.quoteAmount)} mUSD${e.completed ? ", completes the curve" : ""}`;
          if (!this.labels.has(e.tx)) this.label(e.tx, this.item, what);
        }
      },
    });
    const url = await this.serveSponsor();
    this.sponsorFront = await new RpcProxy(url).listen();
    this.sponsorDaemon = await new RpcProxy(url).listen();
    const common = { MANTLE_AA_SPONSOR_URL: this.sponsorFront.url };
    this.rootEnv = {
      ...common,
      MANTLE_AA_RPC_URL: this.chainRpc.url,
      MANTLE_AA_HOME: this.rootHome,
      MANTLE_AA_KEYSTORE_PASSWORD: this.rootPassword,
    };
    this.agentEnv = {
      ...common,
      MANTLE_AA_RPC_URL: this.agentRpc.url,
      MANTLE_AA_HOME: this.agentHome,
      MANTLE_AA_KEYSTORE_PASSWORD: this.agentPassword,
    };
    this.daemonEnv = {
      ...this.agentEnv,
      MANTLE_AA_RPC_URL: this.chainRpc.url,
      MANTLE_AA_SPONSOR_URL: this.sponsorDaemon.url,
      MANTLE_MEME_AUTOPILOT_TICK_MS: String(this.cfg.tickMs),
      MANTLE_MEME_AUTOPILOT_POLL_MS: String(this.cfg.pollMs),
    };
    this.log(`root (account) ${this.me}, relayer ${this.relayer}, run tag ${this.tag}`);
  }

  /** `mantle-aa sponsor serve`: the relayer key comes from its environment, never the file. */
  private async serveSponsor(): Promise<string> {
    const config = join(this.cfg.dir, "sponsor.yaml");
    writeFileSync(
      config,
      [
        `chainId: ${book.chainId}`,
        `rpcUrl: ${this.sponsorRpc.url}`,
        "listen: { host: 127.0.0.1, port: 0 }",
        `database: ${join(this.cfg.dir, "sponsor.sqlite")}`,
        `relayer: "${this.relayer}"`,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the config's ${VAR} reference
        "relayerKey: ${ACCEPTANCE_RELAYER_KEY}",
        "settleTimeoutSeconds: 60",
        "policy:",
        `  allowlist: ["${this.me}"]`,
        "  accountDailyGas: 2000000000",
        '  maxFeePerRequestMnt: "0.3"',
        '  dailyBudgetMnt: "2"',
        '  managementReserveMnt: "0.5"',
        "",
      ].join("\n"),
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("MANTLE_AA_")),
    );
    const child = spawn(
      process.execPath,
      [AA_BIN, "sponsor", "serve", "--config", config, "--json"],
      {
        env: { ...env, ACCEPTANCE_RELAYER_KEY: this.cfg.relayerKey },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.sponsor = child;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    const served = await until(
      () => {
        if (child.exitCode !== null) throw new Error(`sponsor serve exited: ${this.scrub(err)}`);
        const line = out.split("\n")[0];
        return out.includes("\n") && line ? JSON.parse(line).result : undefined;
      },
      60_000,
      "sponsor serve",
    );
    assert.equal(getAddress(served.relayer), this.relayer);
    // From here on its stderr goes to the run's log, scrubbed.
    child.stderr.removeAllListeners("data");
    child.stderr.on("data", (d) => this.log(`sponsor: ${this.scrub(String(d)).trim()}`));
    this.log(`sponsor serve listening (relayer ${this.relayer})`);
    return served.url as string;
  }

  /** Stops every process the run started; safe to call twice. */
  async stop() {
    for (const pid of [...this.pids, this.daemonPid].filter((p) => p > 0)) {
      if (!alive(pid)) continue;
      process.kill(pid, "SIGTERM");
      await until(() => !alive(pid), 10_000, `pid ${pid} to exit`).catch(() =>
        process.kill(pid, "SIGKILL"),
      );
    }
    const sponsor = this.sponsor;
    if (sponsor && sponsor.exitCode === null) {
      const exited = new Promise((r) => sponsor.once("exit", r));
      sponsor.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000)]);
      if (sponsor.exitCode === null) sponsor.kill("SIGKILL");
    }
    const proxies = {
      "market-sim": this.simRpc,
      sponsor: this.sponsorRpc,
      agent: this.agentRpc,
      chain: this.chainRpc,
      "sponsor (front)": this.sponsorFront,
      "sponsor (daemon)": this.sponsorDaemon,
    };
    const throttled = Object.entries(proxies).filter(([, p]) => p?.throttled);
    if (throttled.length) {
      this.log(
        `rate-limited upstream answers (HTTP 429) retried by the proxies: ${throttled
          .map(([n, p]) => `${n} ${p?.throttled}`)
          .join(", ")}`,
      );
    }
    for (const p of Object.values(proxies)) await p?.close();
  }

  /** `text` with every secret and the RPC URL replaced. */
  scrub(text: string): string {
    let t = text.replaceAll(this.cfg.rpcUrl, "<rpc-url>");
    for (const s of this.secrets) t = t.replace(new RegExp(s, "gi"), "<redacted>");
    return t;
  }

  /**
   * Every transaction sent during the run (by the market-sim EOAs and the relayer), labelled; one
   * the flow did not label (market-sim's own approve) carries the item of the step that sent it.
   */
  transactions(): RunTx[] {
    return [...new Set([...this.simRpc.sent, ...this.sponsorRpc.sent])].map(
      (hash) => this.labels.get(hash) ?? { hash, item: this.sentIn.get(hash) ?? "", what: "" },
    );
  }

  private label(hash: Hex, item: string, what: string) {
    this.labels.set(hash, { hash, item, what });
    this.log(`tx ${hash} [item ${item}] ${what}`);
  }

  // ---- chain helpers ----------------------------------------------------------------------------

  private hookRead(fn: "inventory" | "remainingLimit", t: Address) {
    return this.client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: fn as "inventory",
      args: [this.keyHash, this.me, t],
    });
  }

  private balanceOf(t: Address, who: Address = this.me) {
    return this.client.readContract({
      address: t,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who],
    });
  }

  private padRead(functionName: "creatorFees" | "protocolFees", args: Address[] = []) {
    return this.client.readContract({
      address: PAD,
      abi: memeLaunchpadAbi,
      functionName,
      args,
    } as never) as Promise<bigint>;
  }

  /**
   * The mined receipt (bounded wait). On Sepolia, also waits until the head is two blocks past it:
   * the public RPC is load-balanced over nodes up to a block apart, and the next command must see it.
   */
  async receipt(hash: Hex): Promise<TransactionReceipt> {
    const r = await until(
      () => this.client.getTransactionReceipt({ hash }).catch(() => undefined),
      180_000,
      `the receipt of ${hash}`,
      this.cfg.mode === "fork" ? 50 : 1_000,
    );
    if (this.cfg.mode === "sepolia") {
      await until(
        async () => (await this.client.getBlockNumber({ cacheTime: 0 })) >= r.blockNumber + 2n,
        120_000,
        "two blocks past the transaction",
        1_000,
      );
    }
    return r;
  }

  /** Labels a transaction of the account (sent by the sponsor's relayer) and checks it. */
  private async relayed(hash: Hex, item: string, what: string) {
    this.label(hash, item, what);
    this.accountTxs.add(hash);
    const r = await this.receipt(hash);
    assert.equal(r.status, "success", `${what}: ${hash} reverted`);
    assert.equal(getAddress(r.from), this.relayer, `${what}: not sent by the relayer`);
    return r;
  }

  /** The launchpad `Trade` logs of the account in a receipt. */
  private trades(r: TransactionReceipt) {
    return parseEventLogs({ abi: memeLaunchpadAbi, eventName: "Trade", logs: r.logs }).filter(
      (l) => getAddress(l.address) === PAD && getAddress(l.args.trader) === this.me,
    );
  }

  /** A plain-EOA transaction from market-sim wallet `i` (its own gas), through `simRpc`. */
  private async eoa(i: number, call: { to: Address; data: Hex }, item: string, what: string) {
    const wallet = createWalletClient({
      account: this.cfg.sim[i] as LocalAccount,
      chain: mantleSepolia,
      transport: http(this.simRpc.url, { timeout: 30_000 }),
    });
    const hash = await wallet.sendTransaction(call);
    this.label(hash, item, what);
    const r = await this.receipt(hash);
    assert.equal(r.status, "success", `${what}: ${hash} reverted`);
    return r;
  }

  /** Moves chain time to at least `timestamp`: anvil's clock on a fork, waiting on Sepolia. */
  private async chainTimeAtLeast(timestamp: bigint) {
    const now = (await this.client.getBlock({ blockTag: "latest" })).timestamp;
    if (now >= timestamp) return;
    if (this.cfg.mode === "fork") {
      await this.client.request({
        method: "evm_increaseTime" as never,
        params: [Number(timestamp - now)] as never,
      });
      await this.client.request({ method: "evm_mine" as never, params: [] as never });
      return;
    }
    this.log(`waiting ${timestamp - now} s of chain time`);
    await until(
      async () => (await this.client.getBlock({ blockTag: "latest" })).timestamp >= timestamp,
      Number(timestamp - now) * 1_000 + 120_000,
      `chain time ${timestamp}`,
      2_000,
    );
  }

  private get eventTimeoutMs() {
    return this.cfg.mode === "fork" ? 60_000 : 300_000;
  }

  /** Waits for the first autopilot event matching `match`; fails with the log so far. */
  private async event(match: (e: AutopilotEvent) => boolean, what: string) {
    return until(
      () => readEvents(this.agentHome).find(match),
      this.eventTimeoutMs,
      `autopilot event: ${what}\n${readEvents(this.agentHome)
        .map((e) => JSON.stringify(e))
        .join("\n")}`,
      200,
    );
  }

  // ---- CLI helpers ------------------------------------------------------------------------------

  private keep(r: Ran): Ran {
    this.outputs.push(r.stdout, r.stderr);
    return r;
  }

  /**
   * Runs a CLI command again (twice at most, logged) when it failed for a reason outside the
   * product that left nothing sent: a read-only command (`quote`, `info`, `list`, `portfolio`,
   * `autopilot status`) on an RPC failure, or any command the sponsor refused with
   * `FEE_UNBOUNDED` (its gas price oracle read failed; nothing was submitted).
   */
  private async retried(what: string, run: () => Promise<Ran>): Promise<Ran> {
    for (let attempt = 1; ; attempt++) {
      const r = this.keep(await run());
      const e = r.json?.error;
      const readOnly = /^(quote|info|list|portfolio|autopilot status)$/.test(r.json?.command ?? "");
      const why =
        r.code === 20 && e?.reason === "FEE_UNBOUNDED"
          ? e.message
          : r.code === 1 &&
              readOnly &&
              /RPC Request failed|HTTP request failed|took too long|fetch failed/i.test(
                e?.message ?? "",
              )
            ? e.message
            : undefined;
      if (!why || attempt === 3) return r;
      this.log(
        `retrying ${what} (attempt ${attempt} failed outside the product: ${this.scrub(why)})`,
      );
      await sleep(3_000);
    }
  }

  private meme(...args: string[]) {
    return this.retried(`mantle-meme ${args[0]}`, () =>
      mantleMeme([...args, "--json"], this.agentEnv),
    );
  }

  private aa(args: string[], env = this.rootEnv, input?: string) {
    return this.retried(`mantle-aa ${args[0]} ${args[1]}`, () =>
      mantleAa([...args, "--json"], env, input),
    );
  }

  private ok(r: Ran, command: string) {
    assert.equal(r.code, 0, `${command}: ${this.scrub(r.stderr || r.stdout)}`);
    assert.equal(r.json?.ok, true, command);
    assert.equal(r.json.command, command);
    return r.json.result;
  }

  private fails(r: Ran, command: string, exitCode: number, code: string) {
    assert.equal(r.code, exitCode, `${command}: ${this.scrub(r.stderr || r.stdout)}`);
    assert.equal(r.json?.ok, false);
    assert.equal(r.json.command, command);
    assert.equal(r.json.exitCode, exitCode);
    assert.equal(r.json.error?.code, code);
    return r.json.error;
  }

  /** What a refusal must leave untouched (the autopilot does not trade `token` meanwhile). */
  private async snapshot(token: Address) {
    return {
      limit: await this.hookRead("remainingLimit", USD),
      inventory: await this.hookRead("inventory", token),
      tokens: await this.balanceOf(token),
      journal: readJournal(this.agentHome).filter((j) => j.token === token).length,
    };
  }

  private async mnt(who: Address) {
    return this.client.getBalance({ address: who });
  }

  // ---- §9.1 item 1 ------------------------------------------------------------------------------

  async humanSetup() {
    assert.equal(await this.mnt(this.me), 0n, "the human holds 0 MNT before the setup");
    this.ok(
      await this.aa(["keys", "import", "--name", "owner"], this.rootEnv, this.rootKey),
      "keys import",
    );
    const policyFile = join(this.cfg.dir, "policy.json");
    const policy = this.ok(
      this.keep(
        await mantleMeme(
          [
            "policy",
            "init",
            "--total",
            String(TOTAL),
            "--per-day",
            String(TOTAL),
            "--expiry",
            "24h",
            "--out",
            policyFile,
            "--json",
          ],
          this.rootEnv,
        ),
      ),
      "policy init",
    );
    const init = this.ok(
      await this.aa(["account", "init", "--grant", policyFile, "--agent", "trader"]),
      "account init",
    );
    assert.equal(getAddress(init.account), this.me);
    assert.equal(init.state, "INITIALIZED");
    this.keyHash = init.session.keyHash;
    await this.relayed(init.hash, "1", "account init --grant (7702 delegation + session grant)");
    const exported = this.ok(
      await this.aa(["session", "export", "--agent", "trader", "--out", this.agentHome], {
        ...this.rootEnv,
        MANTLE_AA_EXPORT_PASSWORD: this.agentPassword,
      }),
      "session export",
    );
    assert.equal(exported.role, "agent");
    const calls = /^mantle-aa account exec --calls '(.*)'$/.exec(policy.next[2] as string)?.[1];
    assert.ok(calls, "policy init prints the MockUSD mint");
    const minted = this.ok(await this.aa(["account", "exec", "--calls", calls]), "account exec");
    await this.relayed(minted.hash, "1", `account exec: mint ${TOTAL} mUSD to the account`);
    assert.equal(await this.balanceOf(USD), mUSD(TOTAL));
    assert.equal(await this.hookRead("remainingLimit", USD), mUSD(TOTAL));
    this.agentKey = this.assertNoRootKeyInAgentHome();
    assert.equal(await this.mnt(this.me), 0n, "the human holds 0 MNT");
    assert.equal(await this.mnt(this.agentKey), 0n, "the agent holds 0 MNT");
    this.fails(await this.aa(["account", "status"], this.agentEnv), "account status", 1, "USAGE");
    this.log(`agent key ${this.agentKey}; keyHash ${this.keyHash}`);
  }

  /** The agent home: the agent's keystore and profile only, nothing of the root's. */
  private assertNoRootKeyInAgentHome(): Address {
    const profiles = Object.values(readProfiles({ home: this.agentHome }));
    assert.deepEqual(
      profiles.map((p) => p.role),
      ["agent"],
    );
    assert.deepEqual(readdirSync(join(this.agentHome, "keys")), ["trader.json"]);
    const keystore = JSON.parse(readFileSync(join(this.agentHome, "keys", "trader.json"), "utf8"));
    const agentKey = getAddress(`0x${keystore.address}`);
    assert.notEqual(agentKey, this.me);
    const rootCipher = JSON.parse(readFileSync(join(this.rootHome, "keys", "owner.json"), "utf8"))
      .crypto.ciphertext as string;
    for (const f of filesUnder(this.agentHome)) {
      const text = readFileSync(f, "utf8").toLowerCase();
      assert.ok(!text.includes(this.rootKey.slice(2).toLowerCase()), `root key in ${f}`);
      assert.ok(!text.includes(rootCipher.toLowerCase()), `root keystore in ${f}`);
    }
    return agentKey;
  }

  // ---- §9.1 item 2 ------------------------------------------------------------------------------

  async createAndTrade() {
    const symbol = `GATE${this.tag}`;
    const created = this.ok(
      await this.meme("create", "--name", `Gate ${this.tag}`, "--symbol", symbol, "--dev-buy", "5"),
      "create",
    );
    this.gate = getAddress(created.token);
    const rc = await this.relayed(created.hash, "2", `create ${symbol} --dev-buy 5`);
    this.gateBlock = rc.blockNumber;
    const [dev] = this.trades(rc);
    assert.ok(dev, "the dev buy's Trade");
    assert.equal(getAddress(dev.args.token), this.gate);
    assert.equal(dev.args.quoteAmount, mUSD(5));
    assert.equal(created.devBuy.spent.base, "5000000");
    assert.equal(created.devBuy.tokens.base, dev.args.tokenAmount.toString());
    assert.equal((await curveState(this.client, PAD, this.gate)).creator, this.me);
    assert.equal(await this.hookRead("inventory", this.gate), dev.args.tokenAmount);
    assert.equal(await this.hookRead("remainingLimit", USD), mUSD(TOTAL - 5));
    this.ledger.push({ side: "buy", quote: dev.args.quoteAmount, tokens: dev.args.tokenAmount });

    const bought = this.ok(await this.meme("buy", symbol, "--amount", "2"), "buy");
    const [buy] = this.trades(await this.relayed(bought.hash, "2", `buy ${symbol} 2 mUSD`));
    assert.ok(buy);
    assert.equal(bought.spent.base, "2000000");
    assert.equal(bought.tokens.base, buy.args.tokenAmount.toString());
    assert.ok(BigInt(bought.tokens.base) >= BigInt(bought.minOut.base));
    assert.equal(await this.hookRead("remainingLimit", USD), mUSD(TOTAL - 7));
    this.ledger.push({ side: "buy", quote: mUSD(2), tokens: buy.args.tokenAmount });
    const held = await this.hookRead("inventory", this.gate);
    assert.equal(held, dev.args.tokenAmount + buy.args.tokenAmount);

    const sold = this.ok(await this.meme("sell", symbol, "--percent", "50"), "sell");
    const [sell] = this.trades(await this.relayed(sold.hash, "2", `sell ${symbol} --percent 50`));
    assert.ok(sell);
    assert.equal(sell.args.isBuy, false);
    assert.equal(sell.args.tokenAmount, held / 2n);
    assert.equal(sold.received.base, sell.args.quoteAmount.toString());
    assert.equal(await this.hookRead("inventory", this.gate), held - held / 2n);
    this.ledger.push({ side: "sell", quote: sell.args.quoteAmount, tokens: held / 2n });
  }

  async readCommands() {
    const symbol = `GATE${this.tag}`;
    const qb = await quoteBuy(this.client, PAD, this.gate, mUSD(3));
    const quote = this.ok(await this.meme("quote", symbol, "--buy", "3"), "quote");
    assert.equal(quote.side, "buy");
    assert.equal(quote.amountIn.base, qb.amountInUsed.toString());
    assert.equal(quote.amountOut.base, qb.amountOut.toString());
    assert.equal(quote.fee.base, qb.feeUsed.toString());
    const qs = await quoteSell(this.client, PAD, this.gate, parseUnits("1000", 18));
    const sq = this.ok(await this.meme("quote", this.gate, "--sell", "1000"), "quote");
    assert.equal(sq.amountOut.base, qs.amountOut.toString());
    assert.equal(sq.fee.base, qs.fee.toString());

    const s = await curveState(this.client, PAD, this.gate);
    const info = this.ok(await this.meme("info", symbol), "info");
    assert.equal(getAddress(info.address), this.gate);
    assert.equal(info.symbol, symbol);
    assert.equal(info.status, "trading");
    assert.equal(getAddress(info.creator), this.me);
    assert.equal(info.price.priceE18, s.priceE18.toString());
    assert.equal(info.sold.base, s.sold.toString());
    assert.equal(info.raised.base, s.realQuote.toString());
    assert.equal(
      info.creatorFees.base,
      (await this.padRead("creatorFees", [this.gate])).toString(),
    );
    const list = this.ok(await this.meme("list", "--limit", "5"), "list");
    const listed = list.tokens.find(
      (t: { address: string }) => getAddress(t.address) === this.gate,
    );
    assert.ok(listed, "list shows the agent's token");
    assert.equal(listed.sold.base, s.sold.toString());
    assert.equal(listed.status, "trading");

    // Portfolio: chain state; cost basis from the agent's own Trade logs, not from the journal.
    const portfolio = this.ok(await this.meme("portfolio"), "portfolio");
    const inventory = await this.hookRead("inventory", this.gate);
    let held = 0n;
    let cost = 0n;
    for (const x of this.ledger) {
      if (x.side === "buy") [held, cost] = [held + x.tokens, cost + x.quote];
      else [held, cost] = [held - x.tokens, cost - (cost * x.tokens) / held];
    }
    assert.equal(held, inventory);
    const sellValue = (await quoteSell(this.client, PAD, this.gate, inventory)).amountOut;
    assert.equal(getAddress(portfolio.account), this.me);
    assert.equal(portfolio.keyHash, this.keyHash);
    assert.deepEqual(
      [portfolio.session.initialized, portfolio.session.active, portfolio.session.revoked],
      [true, true, false],
    );
    assert.equal(portfolio.quote.balance.base, (await this.balanceOf(USD)).toString());
    assert.equal(
      portfolio.quote.remainingLimit.base,
      (await this.hookRead("remainingLimit", USD)).toString(),
    );
    assert.equal(portfolio.positions.length, 1);
    const p = portfolio.positions[0];
    assert.equal(getAddress(p.token), this.gate);
    assert.equal(p.status, "trading");
    assert.equal(p.balance.base, (await this.balanceOf(this.gate)).toString());
    assert.equal(p.inventory.base, inventory.toString());
    assert.equal(p.costBasis.base, cost.toString());
    assert.equal(p.sellValue.base, sellValue.toString());
    assert.equal(p.unrealisedPnl.base, (sellValue - cost).toString());
    // The journal holds exactly the agent's trades, as the chain recorded them.
    assert.deepEqual(
      readJournal(this.agentHome).map((j) => ({
        side: j.side,
        quote: j.quotePulled,
        tokens: j.tokens,
      })),
      this.ledger,
    );
  }

  // ---- §9.1 item 6 (10, 11, 12, 41, 42; 44 is in `autopilotStart`) -----------------------------

  async refusals() {
    const symbol = `GATE${this.tag}`;
    const before = await this.snapshot(this.gate);
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [this.cfg.sim[0]?.address as Address, mUSD(1)],
    });
    this.fails(
      await this.aa(
        [
          "agent",
          "exec",
          "--agent",
          "trader",
          "--calls",
          JSON.stringify([{ to: USD, data: transfer }]),
        ],
        this.agentEnv,
      ),
      "agent exec",
      10,
      "POLICY_VIOLATION",
    );
    const err12 = this.fails(
      await this.meme("sell", symbol, "--amount", formatUnits(before.inventory + 1n, 18)),
      "sell",
      12,
      "INVENTORY_EXCEEDED",
    );
    assert.equal(err12.held, before.inventory.toString());
    this.fails(
      await this.meme("buy", `NOPE${this.tag}`, "--amount", "1"),
      "buy",
      42,
      "UNKNOWN_TOKEN",
    );
    this.fails(
      await this.meme("buy", "0x000000000000000000000000000000000000dEaD", "--amount", "1"),
      "buy",
      42,
      "UNKNOWN_TOKEN",
    );
    const err11 = this.fails(
      await this.meme("buy", symbol, "--amount", human(before.limit + mUSD(1))),
      "buy",
      11,
      "LIMIT_EXCEEDED",
    );
    assert.equal(err11.remaining, before.limit.toString());
    assert.deepEqual(await this.snapshot(this.gate), before);
  }

  /**
   * Exit 41: another trader (market-sim wallet 1) buys 50 mUSD of the agent's token right after
   * the CLI read its quote: the proxy in front of the agent's RPC holds the quote's reply until
   * that buy is mined, so the price moves between the CLI's quote and its send.
   */
  async slippage() {
    const symbol = `GATE${this.tag}`;
    const w1 = this.cfg.sim[1]?.address as Address;
    await this.eoa(
      1,
      { to: USD, data: encodeFunctionData({ abi: mockUsdAbi, args: [w1, mUSD(100)] }) },
      "6",
      "market-sim wallet 1 mints 100 mUSD (for the race buy)",
    );
    await this.eoa(
      1,
      approveCall(USD, PAD, maxUint256),
      "6",
      "market-sim wallet 1 approves the launchpad",
    );
    const before = await this.snapshot(this.gate);
    // Signed in advance, so that between the CLI's quote and its send the hook only broadcasts it
    // and waits for it to be mined: the CLI's RPC client gives up on a reply after 10 s.
    const wallet = createWalletClient({
      account: this.cfg.sim[1] as LocalAccount,
      chain: mantleSepolia,
      transport: http(this.simRpc.url, { timeout: 30_000 }),
    });
    const deadline = (await this.client.getBlock()).timestamp + 600n;
    const call = buyCall(PAD, {
      token: this.gate,
      amount: mUSD(50),
      minOut: 0n,
      deadline,
      recipient: w1,
    });
    const prepared = await wallet.prepareTransactionRequest({ to: call.to, data: call.data });
    const raw = await wallet.signTransaction({
      ...prepared,
      gas: (prepared.gas * 13n) / 10n,
    } as never);
    let fired = 0;
    let moved: Hex | undefined;
    this.agentRpc.after = async (msgs) => {
      if (fired || !isQuoteBuy(msgs)) return;
      fired++;
      const quotedAt = Date.now();
      const hash = await this.client.sendRawTransaction({ serializedTransaction: raw });
      this.label(
        hash,
        "6",
        `market-sim wallet 1 buys 50 mUSD of ${symbol} between the CLI's quote and its send`,
      );
      const r = await until(
        () => this.client.getTransactionReceipt({ hash }).catch(() => undefined),
        30_000,
        "the race buy",
        200,
      );
      assert.equal(r.status, "success");
      // The public RPC is load-balanced: let the next reads see the block (bounded, ≤ 2 s).
      await until(
        async () => (await this.client.getBlockNumber({ cacheTime: 0 })) >= r.blockNumber,
        2_000,
        "the race buy's block",
        200,
      ).catch(() => undefined);
      this.log(`race buy mined ${Date.now() - quotedAt} ms after the CLI's quote`);
      moved = hash;
    };
    try {
      // Not retried: the race is armed once.
      const r = this.keep(
        await mantleMeme(
          ["buy", symbol, "--amount", "1", "--slippage", "1", "--json"],
          this.agentEnv,
        ),
      );
      assert.equal(fired, 1, "the race buy ran between the quote and the send");
      assert.ok(moved);
      this.fails(r, "buy", 41, "SLIPPAGE");
    } finally {
      this.agentRpc.after = undefined;
    }
    assert.deepEqual(await this.snapshot(this.gate), before);
  }

  // ---- §9.1 item 3 (and 6: 44) ------------------------------------------------------------------

  async autopilotStart() {
    const file = join(this.cfg.dir, "strategy.json");
    writeFileSync(file, JSON.stringify(strategy(this.tag)));
    const start = (env: Record<string, string>) =>
      mantleMeme(["autopilot", "start", "--strategy", file, "--json"], env).then((r) =>
        this.keep(r),
      );
    const r = this.ok(await start(this.daemonEnv), "autopilot start");
    this.daemonPid = r.pid;
    this.pids.push(r.pid);
    assert.ok(alive(r.pid), "the daemon runs");
    assert.equal(getAddress(r.account), this.me);
    assert.equal(r.keyHash, this.keyHash);
    assert.deepEqual(r.strategy, strategy(this.tag));
    const status = this.ok(await this.meme("autopilot", "status"), "autopilot status");
    assert.equal(status.running, true);
    assert.equal(status.pid, r.pid);
    assert.equal(status.state.status, "running");
    // A second start while it runs: exit 44, and the running daemon is untouched.
    const again = this.fails(await start(this.daemonEnv), "autopilot start", 44, "AUTOPILOT_STATE");
    assert.equal(again.message, `Autopilot is already running (pid ${r.pid})`);
    assert.ok(alive(r.pid));
    assert.equal(readEvents(this.agentHome).filter((e) => e.event === "started").length, 1);
    this.log(`autopilot daemon pid ${r.pid}, watching from block ${r.fromBlock}`);
  }

  private async bought(token: Address, item = "3") {
    const e = await this.event((x) => x.event === "bought" && x.token === token, `bought ${token}`);
    await this.relayed(e.hash as Hex, item, `autopilot buys ${e.symbol} (3 mUSD)`);
    return e;
  }

  async autopilotBuys() {
    this.plain = (
      await this.sim.createToken({ wallet: 0, name: `Plain ${this.tag}`, symbol: `PLN${this.tag}` })
    ).token;
    const created = await this.sim.createToken({
      wallet: 0,
      name: `Moon ${this.tag} A`,
      symbol: `MOON${this.tag}A`,
    });
    const moon = created.token;
    this.moon.push(moon);
    const skipped = await this.event(
      (e) => e.event === "skipped" && e.token === this.plain,
      "skipped (keywords)",
    );
    assert.equal(skipped.reason, "keywords");
    const e = await this.bought(moon);
    assert.equal((e.spent as { base: string }).base, "3000000");
    assert.ok(Number(e.ageSeconds) <= 60, `observed age ${e.ageSeconds} s ≤ maxAgeSeconds`);
    const rc = await this.receipt(e.hash as Hex);
    const boughtAt = (await this.client.getBlock({ blockNumber: rc.blockNumber })).timestamp;
    const createdAt = (await curveState(this.client, PAD, moon)).createdAt;
    this.log(`MOON${this.tag}A: created ${createdAt}, bought ${boughtAt} (chain time)`);
    assert.ok(boughtAt - createdAt <= 60n, "bought within maxAgeSeconds of its creation");
    const [trade] = this.trades(rc);
    assert.equal(trade?.args.tokenAmount, BigInt((e.tokens as { base: string }).base));
    assert.equal(await this.hookRead("inventory", moon), trade?.args.tokenAmount);
    assert.equal(await this.hookRead("remainingLimit", USD), mUSD(TOTAL - 10));
  }

  async takeProfit() {
    const moon = this.moon[0] as Address;
    const before = await this.hookRead("inventory", moon);
    const pump = await this.sim.pump(moon, { wallet: 2 });
    assert.ok(pump.priceAfter >= pump.priceBefore * 2n, "the pump doubled the spot price");
    assert.equal(pump.completed, false);
    const sold = await this.event(
      (e) => e.event === "sold" && e.token === moon,
      "sold (take-profit)",
    );
    assert.equal(sold.reason, "take_profit");
    await this.relayed(sold.hash as Hex, "3", `autopilot take-profit sells half of ${sold.symbol}`);
    assert.equal((sold.sold as { base: string }).base, (before / 2n).toString());
    const received = BigInt((sold.received as { base: string }).base);
    const cost = BigInt((sold.costBasis as { base: string }).base);
    assert.ok(received * 100n >= cost * 150n, "sold at +50% or better over its cost basis");
    assert.equal(await this.hookRead("inventory", moon), before - before / 2n);
  }

  async maxHold() {
    const moon = this.moon[0] as Address;
    const status = this.ok(await this.meme("autopilot", "status"), "autopilot status");
    const position = status.state.positions.find(
      (p: { token: string }) => getAddress(p.token) === moon,
    );
    assert.ok(position, "the autopilot holds the position");
    await this.chainTimeAtLeast(BigInt(position.openedAt) + MAX_HOLD + 1n);
    const sold = await this.event(
      (e) => e.event === "sold" && e.token === moon && e.reason === "max_hold",
      "sold (max hold)",
    );
    const rc = await this.relayed(
      sold.hash as Hex,
      "3",
      `autopilot max-hold sells the rest of ${sold.symbol}`,
    );
    const at = (await this.client.getBlock({ blockNumber: rc.blockNumber })).timestamp;
    assert.ok(
      at >= BigInt(position.openedAt) + MAX_HOLD,
      "sold after maxHoldMinutes of chain time",
    );
    assert.equal(await this.hookRead("inventory", moon), 0n);
    const after = this.ok(await this.meme("autopilot", "status"), "autopilot status");
    const closed = after.state.positions.find(
      (p: { token: string }) => getAddress(p.token) === moon,
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.takeProfitDone, true);
  }

  async budgetExhausted() {
    const third = await this.sim.createToken({
      wallet: 0,
      name: `Moon ${this.tag} C`,
      symbol: `MOON${this.tag}C`,
    });
    const exhausted = await this.event((e) => e.event === "budget_exhausted", "budget_exhausted");
    assert.equal((exhausted.needed as { base: string }).base, "3000000");
    assert.equal((exhausted.remainingLimit as { base: string }).base, mUSD(2).toString());
    assert.equal(await this.hookRead("remainingLimit", USD), mUSD(2));
    // It enters nothing more: no buy of that token, one budget_exhausted only.
    await sleep(this.cfg.pollMs * 3 + this.cfg.tickMs);
    const events = readEvents(this.agentHome);
    assert.equal(events.filter((e) => e.event === "budget_exhausted").length, 1);
    assert.ok(!events.some((e) => e.event === "bought" && e.token === third.token));
    const status = this.ok(await this.meme("autopilot", "status"), "autopilot status");
    assert.equal(status.state.budgetExhausted, true);
  }

  // ---- §9.1 item 8 ------------------------------------------------------------------------------

  /**
   * An autopilot buy and a manual `mantle-meme buy` at the same moment. The proxy in front of the
   * sponsor holds the daemon's `sponsor_relay` (it already holds the send lock) until the manual
   * buy has quoted, so the manual buy is mid-flight while the daemon sends: it then waits at the
   * lock, and sends only after the daemon's transaction settled. Both complete; the sponsor never
   * answers `SPONSOR_BUSY`, and the user sees none.
   */
  async concurrentBuys() {
    const since = Date.now();
    const lockFile = join(this.agentHome, "meme", "send.lock");
    const holders: { at: number; pid: number | null }[] = [];
    let watching = true;
    const watcher = (async () => {
      let last: number | null | undefined;
      while (watching) {
        let pid: number | null = null;
        try {
          pid = Number(readFileSync(lockFile, "utf8").trim()) || null;
        } catch {}
        if (pid !== last) holders.push({ at: Date.now(), pid });
        last = pid;
        await sleep(5);
      }
    })();

    let open: () => void = () => {};
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const fallback = setTimeout(() => open(), 60_000);
    let daemonHeldFrom = 0;
    this.sponsorDaemon.before = async (msgs) => {
      if (!msgs.some((m) => m.method === "sponsor_relay")) return;
      daemonHeldFrom ||= Date.now();
      await gate;
    };
    let manualQuotedAt = 0;
    this.agentRpc.after = async (msgs) => {
      if (manualQuotedAt || !isQuoteBuy(msgs)) return;
      manualQuotedAt = Date.now();
      // Give the manual buy time to reach the send lock (it spins on it every 100 ms).
      setTimeout(() => open(), 1_000);
    };

    let manual: { pid: number; startedAt: number; done: Promise<Ran> } | undefined;
    try {
      const created = await this.sim.createToken({
        wallet: 0,
        name: `Moon ${this.tag} B`,
        symbol: `MOON${this.tag}B`,
      });
      const moon = created.token;
      this.moon.push(moon);
      // The daemon took the lock for its buy: start the manual buy now.
      await until(
        () => holders.at(-1)?.pid === this.daemonPid,
        this.eventTimeoutMs,
        "the daemon to hold the send lock",
        5,
      );
      manual = this.spawnMeme(["buy", this.plain, "--amount", "1", "--json"], this.agentEnv);
      const r = this.keep(await manual.done);
      const e = await this.bought(moon, "8");
      watching = false;
      await watcher;

      const result = this.ok(r, "buy");
      assert.equal(result.spent.base, "1000000");
      const rc = await this.relayed(
        result.hash,
        "8",
        `manual buy PLN${this.tag} 1 mUSD, concurrent with the autopilot`,
      );
      const daemonRc = await this.receipt(e.hash as Hex);
      assert.notEqual(result.hash, e.hash);
      assert.ok(rc.blockNumber >= daemonRc.blockNumber);

      // The lock: the daemon held it, then the manual buy, never both; the manual buy started and
      // quoted while the daemon held it.
      const daemonFrom = holders.find((h) => h.pid === this.daemonPid);
      const daemonUntil = holders.find(
        (h) => daemonFrom && h.at > daemonFrom.at && h.pid !== this.daemonPid,
      );
      const manualFrom = holders.find((h) => h.pid === manual?.pid);
      assert.ok(
        daemonFrom && daemonUntil && manualFrom,
        `lock holders: ${JSON.stringify(holders)}`,
      );
      assert.ok(
        manualFrom.at >= daemonUntil.at,
        "the manual buy took the lock after the daemon released it",
      );
      assert.ok(
        manual.startedAt < daemonUntil.at,
        "the manual buy started while the daemon held the lock",
      );
      assert.ok(
        manualQuotedAt > 0 && manualQuotedAt < daemonUntil.at,
        "the manual buy quoted while the daemon held the lock",
      );

      // The sponsor: the daemon's relay settled before the manual buy's first relay; no BUSY.
      const relays = (p: RpcProxy) =>
        p.exchanges.filter((x) => x.start >= since && x.methods.includes("sponsor_relay"));
      const daemonRelays = relays(this.sponsorDaemon);
      const manualRelays = relays(this.sponsorFront);
      assert.ok(daemonRelays.length > 0 && manualRelays.length > 0);
      const daemonLast = Math.max(...daemonRelays.map((x) => x.end));
      const manualFirst = Math.min(...manualRelays.map((x) => x.start));
      assert.ok(manualFirst >= daemonLast, "the sends did not overlap at the sponsor");
      for (const x of [...daemonRelays, ...manualRelays]) {
        assert.ok(!x.reply.includes("SPONSOR_BUSY"), "the sponsor answered SPONSOR_BUSY");
      }
      assert.ok(!`${r.stdout}${r.stderr}`.includes("SPONSOR_BUSY"));
      const errors = readEvents(this.agentHome, since).filter(
        (x) => x.event === "error" && (x.source === "buy" || x.source === "sell"),
      );
      assert.deepEqual(errors, [], "the autopilot's trades reported no error");
      assert.equal(await this.hookRead("remainingLimit", USD), mUSD(2));
      this.log(
        `item 8 timeline (ms from the daemon taking the lock): daemon relay held ${daemonHeldFrom - daemonFrom.at}, ` +
          `manual started ${manual.startedAt - daemonFrom.at}, manual quoted ${manualQuotedAt - daemonFrom.at}, ` +
          `daemon released the lock ${daemonUntil.at - daemonFrom.at}, manual took it ${manualFrom.at - daemonFrom.at}, ` +
          `daemon relay settled ${daemonLast - daemonFrom.at}, manual first relay ${manualFirst - daemonFrom.at}`,
      );
    } finally {
      watching = false;
      clearTimeout(fallback);
      open();
      this.sponsorDaemon.before = undefined;
      this.agentRpc.after = undefined;
      await manual?.done.catch(() => undefined);
    }
  }

  /** `mantle-meme` as a child whose pid is known (it is the pid in the send lock). */
  private spawnMeme(args: string[], env: Record<string, string>) {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("MANTLE_AA_")),
    );
    const startedAt = Date.now();
    const proc = spawn(process.execPath, memeArgs(args), {
      env: { ...base, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = proc.pid as number;
    this.pids.push(pid);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const done = new Promise<Ran>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code) => {
        let json: unknown;
        try {
          json = JSON.parse(stdout);
        } catch {}
        resolve({ code, stdout, stderr, json });
      });
    });
    return { pid, startedAt, done };
  }

  // ---- §9.1 item 4 ------------------------------------------------------------------------------

  /** market-sim fills the curve of a token the agent holds through on-chain truncation. */
  async curveCompleted() {
    const token = this.plain;
    const want = mUSD(1_000);
    const q = await quoteBuy(this.client, PAD, token, want);
    assert.equal(q.completes, true);
    assert.ok(q.amountInUsed < want);
    const before = await this.snapshot(token);
    assert.ok(before.inventory > 0n, "the agent holds the token");
    const fill = await this.sim.buy(token, want, { wallet: 2 });
    assert.equal(fill.completed, true);
    assert.equal(fill.quoteAmount, q.amountInUsed, "only amountInUsed was pulled");
    const rc = await this.receipt(fill.tx);
    assert.deepEqual(
      parseEventLogs({ abi: memeLaunchpadAbi, eventName: "CurveCompleted", logs: rc.logs }).map(
        (l) => getAddress(l.args.token),
      ),
      [token],
    );
    const s = await curveState(this.client, PAD, token);
    assert.equal(s.status, "completed");
    assert.equal(s.sold, CURVE_TOKENS);
    for (const r of [
      await this.meme("buy", token, "--amount", "1"),
      await this.meme("sell", token, "--all"),
    ]) {
      const err = this.fails(r, r.json?.command, 40, "CURVE_COMPLETED");
      assert.equal(err.message, CURVE_COMPLETED_TEXT);
    }
    const info = this.ok(await this.meme("info", token), "info");
    assert.equal(info.status, "completed");
    assert.equal(info.notice, CURVE_COMPLETED_TEXT);
    assert.deepEqual(await this.snapshot(token), before);
  }

  // ---- §9.1 item 2, clamp case ------------------------------------------------------------------

  /** Remaining limit strictly between amountInUsed and the requested amount on a completing buy. */
  async clamp() {
    const symbol = `CLMP${this.tag}`;
    const created = await this.sim.createToken({ wallet: 0, name: `Clamp ${this.tag}`, symbol });
    const token = created.token;
    await this.receipt(created.tx);
    const full = await quoteBuy(this.client, PAD, token, mUSD(1_000));
    // A market buy leaves about 1.5 mUSD to completion.
    await this.receipt(
      (await this.sim.buy(token, full.amountInUsed - mUSD(1.5), { wallet: 1 })).tx,
    );
    const limit = await this.hookRead("remainingLimit", USD);
    const requested = limit + mUSD(1);
    const q = await quoteBuy(this.client, PAD, token, requested);
    assert.equal(q.completes, true);
    assert.ok(q.amountInUsed < limit && limit < requested, "the premise of the clamp case");
    const remaining = CURVE_TOKENS - (await curveState(this.client, PAD, token)).sold;
    const r = this.ok(await this.meme("buy", symbol, "--amount", human(requested)), "buy");
    assert.equal(r.requested.base, requested.toString());
    assert.equal(r.spent.base, q.amountInUsed.toString());
    assert.equal(r.tokens.base, remaining.toString());
    assert.equal(r.completes, true);
    const rc = await this.relayed(r.hash, "2", `clamped completing buy of ${symbol}`);
    const [trade] = this.trades(rc);
    assert.equal(trade?.args.quoteAmount, q.amountInUsed, "charged exactly amountInUsed");
    assert.equal(
      parseEventLogs({ abi: memeLaunchpadAbi, eventName: "CurveCompleted", logs: rc.logs }).length,
      1,
    );
    assert.equal(await this.hookRead("remainingLimit", USD), limit - q.amountInUsed);
    assert.equal(await this.hookRead("inventory", token), remaining);
    assert.equal((await curveState(this.client, PAD, token)).status, "completed");
  }

  // ---- §9.1 item 5 ------------------------------------------------------------------------------

  async fees() {
    const logs = await this.client.getContractEvents({
      address: PAD,
      abi: memeLaunchpadAbi,
      eventName: "Trade",
      args: { token: this.gate },
      fromBlock: this.gateBlock,
    });
    // The agent's three trades and the race buy.
    assert.equal(logs.length, this.ledger.length + 1);
    const share = logs.reduce((s, l) => s + (l.args.fee as bigint) / 2n, 0n);
    assert.equal(await this.padRead("creatorFees", [this.gate]), share);
    const r = this.ok(await this.meme("claim", `GATE${this.tag}`), "claim");
    assert.equal(r.total.base, share.toString());
    const rc = await this.relayed(r.hash, "5", `claim GATE${this.tag} (creator fees)`);
    const [claimed] = parseEventLogs({
      abi: memeLaunchpadAbi,
      eventName: "CreatorFeesClaimed",
      logs: rc.logs,
    });
    assert.equal(claimed?.args.amount, share);
    assert.equal(getAddress(claimed?.args.creator as Address), this.me);
    assert.equal(await this.padRead("creatorFees", [this.gate]), 0n);

    const due = await this.padRead("protocolFees");
    const treasury = await this.client.readContract({
      address: PAD,
      abi: memeLaunchpadAbi,
      functionName: "treasury",
    });
    const before = await this.balanceOf(USD, treasury);
    const prc = await this.eoa(
      0,
      {
        to: PAD,
        data: encodeFunctionData({ abi: memeLaunchpadAbi, functionName: "claimProtocolFees" }),
      },
      "5",
      "claimProtocolFees (anyone may call; pays the treasury)",
    );
    const [paid] = parseEventLogs({
      abi: memeLaunchpadAbi,
      eventName: "ProtocolFeesClaimed",
      logs: prc.logs,
    });
    assert.ok(paid && paid.args.amount >= due && due > 0n);
    assert.equal(await this.balanceOf(USD, treasury), before + paid.args.amount);
  }

  // ---- §9.1 item 7 ------------------------------------------------------------------------------

  async revoke() {
    const pid = this.daemonPid;
    assert.ok(alive(pid), "the daemon runs before the revoke");
    const r = this.ok(await this.aa(["session", "revoke", "--agent", "trader"]), "session revoke");
    await this.relayed(r.hash, "7", "session revoke --agent trader (the human)");
    const ended = await this.event((e) => e.event === "session_ended", "session_ended");
    assert.equal(ended.exitCode, 13);
    assert.equal(ended.code, "KEY_EXPIRED_OR_REVOKED");
    await until(() => !alive(pid), 60_000, "the daemon to exit");
    const last = readEvents(this.agentHome).at(-1);
    assert.equal(last?.event, "stopped");
    assert.equal(last?.reason, "session_ended");
    const status = this.ok(await this.meme("autopilot", "status"), "autopilot status");
    assert.equal(status.running, false);
    assert.equal(status.state.status, "session_ended");
    this.fails(
      await this.meme("buy", `GATE${this.tag}`, "--amount", "1"),
      "buy",
      13,
      "KEY_EXPIRED_OR_REVOKED",
    );
    this.fails(await this.meme("autopilot", "stop"), "autopilot stop", 44, "AUTOPILOT_STATE");
  }

  // ---- §9.1 item 1, end of the run --------------------------------------------------------------

  async endOfRun() {
    assert.equal(this.assertNoRootKeyInAgentHome(), this.agentKey);
    assert.equal(await this.mnt(this.me), 0n, "the human held 0 MNT");
    assert.equal(await this.mnt(this.agentKey), 0n, "the agent held 0 MNT");
    // Every transaction of the account went through the sponsor's relayer, the CLI and the daemon
    // alike, and the sponsor never answered SPONSOR_BUSY.
    for (const j of readJournal(this.agentHome)) {
      assert.equal(getAddress((await this.receipt(j.txHash)).from), this.relayer);
    }
    for (const x of [...this.sponsorFront.exchanges, ...this.sponsorDaemon.exchanges]) {
      assert.ok(!x.reply.includes("SPONSOR_BUSY"), "the sponsor answered SPONSOR_BUSY");
    }
    const relayed = new Set(this.sponsorRpc.sent);
    for (const hash of this.accountTxs) {
      assert.ok(relayed.has(hash), `${this.labels.get(hash)?.what} was sent by the relayer`);
    }
    // No secret in any output of the CLIs, the daemon's files or the agent home.
    const texts = [
      ...this.outputs,
      ...[this.files.events, this.files.state, this.files.strategy, this.files.log]
        .filter((f) => existsSync(f))
        .map((f) => readFileSync(f, "utf8")),
    ];
    for (const t of texts) {
      const lower = t.toLowerCase();
      for (const s of this.secrets) assert.ok(!lower.includes(s), "a secret in an output");
    }
  }
}

/** Every file under `dir`, recursively. */
export const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

/** Runs one step, labelling what it sends with its item. */
export function runStep(a: Acceptance, step: Step): Promise<void> {
  a.item = step.item;
  return step.run(a);
}

export const STEPS: Step[] = [
  {
    item: "1",
    name: "item 1: policy init → account init --grant → session export → mint; 0 MNT; no root key in the agent home",
    run: (a) => a.humanSetup(),
  },
  {
    item: "2",
    name: "item 2: create --dev-buy, buy, sell --percent 50 from the agent home",
    run: (a) => a.createAndTrade(),
  },
  {
    item: "2",
    name: "item 2: quote, info, list, portfolio agree with the chain and the journal",
    run: (a) => a.readCommands(),
  },
  {
    item: "6",
    name: "item 6: transfer (10), sell over inventory (12), unknown token (42), over the limit (11)",
    run: (a) => a.refusals(),
  },
  {
    item: "6",
    name: "item 6: the price moving between quote and send is exit 41",
    run: (a) => a.slippage(),
  },
  {
    item: "3",
    name: "items 3 + 6: autopilot start detaches the daemon; a second start is exit 44",
    run: (a) => a.autopilotStart(),
  },
  {
    item: "3",
    name: "item 3: market-sim creates a token; the autopilot buys it within maxAgeSeconds",
    run: (a) => a.autopilotBuys(),
  },
  { item: "3", name: "item 3: market-sim pump → take-profit sell", run: (a) => a.takeProfit() },
  { item: "3", name: "item 3: max hold (chain time) sells the rest", run: (a) => a.maxHold() },
  {
    item: "8",
    name: "item 8: an autopilot buy and a manual buy at the same moment both complete through the send lock",
    run: (a) => a.concurrentBuys(),
  },
  {
    item: "3",
    name: "item 3: budget_exhausted when the limit runs out",
    run: (a) => a.budgetExhausted(),
  },
  {
    item: "4",
    name: "item 4: market-sim fills a curve through truncation → Completed; buy and sell are exit 40",
    run: (a) => a.curveCompleted(),
  },
  {
    item: "2",
    name: "item 2 (clamp): a completing buy over the limit is charged exactly amountInUsed",
    run: (a) => a.clamp(),
  },
  {
    item: "5",
    name: "item 5: claim pays the creator share; claimProtocolFees pays the treasury",
    run: (a) => a.fees(),
  },
  {
    item: "7",
    name: "item 7: the human revokes → the autopilot emits session_ended and exits; the agent gets exit 13",
    run: (a) => a.revoke(),
  },
  {
    item: "1",
    name: "item 1 (end): the human and the agent held 0 MNT; every send relayed; no secret in any output",
    run: (a) => a.endOfRun(),
  },
];
