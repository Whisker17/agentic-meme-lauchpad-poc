import { setTimeout as sleep } from "node:timers/promises";
import {
  approveCall,
  buyCall,
  type CurveParams,
  createTokenCall,
  curveState,
  loadDeployments,
  memeLaunchpadAbi,
  minOutFor,
  priceE18,
  quoteBuy,
  quoteSell,
  type Reserves,
  randomSalt,
  readCurveParams,
  scanTokens,
  sellCall,
  simulateBuy,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  type Chain,
  type Client,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  type HttpTransport,
  http,
  type LocalAccount,
  type PublicActions,
  parseAbi,
  parseEventLogs,
  publicActions,
  type TransactionReceipt,
  type WalletActions,
  type WalletRpcSchema,
} from "viem";
import { mantleSepoliaTestnet } from "viem/chains";

/** 1 mUSD in base units (MockUSD has 6 decimals). */
export const mUSD = 10n ** 6n;

export interface CreateEvent {
  kind: "create";
  wallet: Address;
  token: Address;
  name: string;
  symbol: string;
  tx: Hex;
}

export interface TradeEvent {
  kind: "buy" | "sell";
  wallet: Address;
  token: Address;
  /** Buy: quote pulled, fee included (below the request when it completed the curve). Sell: quote paid out. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  /** This trade completed the curve (`CurveCompleted`). */
  completed: boolean;
  tx: Hex;
}

export interface PumpEvent {
  kind: "pump";
  wallet: Address;
  token: Address;
  percent: number;
  /** `curveState.priceE18` right before and after the pump. */
  priceBefore: bigint;
  priceAfter: bigint;
  quoteAmount: bigint;
  completed: boolean;
  tx: Hex;
}

/** What one simulator action did; the CLI prints these as JSON lines. Never carries a key. */
export type SimEvent =
  | CreateEvent
  | TradeEvent
  | PumpEvent
  | { kind: "mint"; wallet: Address; amount: bigint; tx: Hex }
  | { kind: "skip"; reason: string; token?: Address }
  | { kind: "error"; action: string; message: string };

export interface MarketSimConfig {
  /** Anvil fork or Mantle Sepolia RPC. */
  rpcUrl: string;
  /** The trading EOAs; they pay their own gas (MNT) and mint their own MockUSD. */
  accounts: readonly LocalAccount[];
  /** Default: the shipped Mantle Sepolia address book. */
  launchpad?: Address;
  quoteToken?: Address;
  /** Seeds every random choice (wallet, action, size, names); default 1. */
  seed?: number;
  /** Receives every event; default: none. */
  log?: (event: SimEvent) => void;
  /** Receipt polling; defaults 250 ms / 60 s. */
  pollingIntervalMs?: number;
  receiptTimeoutMs?: number;
}

export interface RunOptions {
  signal?: AbortSignal;
  /** Delay between creates, drawn uniformly from [min, max] ms; default 2–5 min (DESIGN §8.3). */
  createIntervalMs?: readonly [number, number];
  /** Delay between random trades, drawn uniformly from [min, max] ms; default 10–30 s. */
  tradeIntervalMs?: readonly [number, number];
}

export interface RunSummary {
  creates: number;
  buys: number;
  sells: number;
  mints: number;
  skips: number;
  errors: number;
}

const mockUsdAbi = parseAbi(["function mint(address to, uint256 amount)"]);
/** Minted on top of a shortfall so an EOA does not mint before every buy. */
const MINT_BUFFER = 1_000n * mUSD;
const WORDS = [
  "Pepe",
  "Doge",
  "Frog",
  "Moon",
  "Mantle",
  "Cat",
  "Rocket",
  "Wojak",
  "Shiba",
  "Turbo",
];

/** Deterministic PRNG (mulberry32): the same seed replays the same choices. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

export interface PumpPlan {
  /** Quote to spend, fee included; never more than what completes the curve. */
  amountIn: bigint;
  priceBefore: bigint;
  /** `priceE18` after the buy, by the local curve model. */
  priceAfter: bigint;
  /** The buy completes the curve: the target was beyond the curve end, so the price stops there. */
  completes: boolean;
}

/**
 * The smallest buy (to 0.1%) that lifts the spot price `priceE18` to at least `(1 + percent/100)`
 * times its current value. The price is `vQ²/k` up to rounding, so the target reserve is
 * `sqrt(m · k · vQ / vT)`; the estimate is then checked (and nudged up) with the contract's own
 * arithmetic (`simulateBuy`). A target beyond the curve end is capped at the completing amount,
 * so a pump never pays for tokens the curve no longer has.
 */
export function planPump(p: CurveParams, r: Reserves, percent: number): PumpPlan {
  if (!(percent > 0) || !Number.isFinite(percent)) {
    throw new RangeError(`percent must be a positive number, got ${percent}`);
  }
  const bps = BigInt(Math.ceil(percent * 100));
  const priceBefore = priceE18(r);
  const target = (priceBefore * (10_000n + bps)) / 10_000n;
  const k = p.virtualToken0 * p.virtualQuote0;
  const vQTarget = isqrt((k * r.vQ * (10_000n + bps)) / (r.vT * 10_000n)) + 1n;
  const net = vQTarget > r.vQ ? vQTarget - r.vQ : 1n;
  let amountIn = (net * 10_000n + 10_000n - p.feeBps - 1n) / (10_000n - p.feeBps);
  for (;;) {
    const q = simulateBuy(p, r, amountIn);
    const after = priceE18({ vT: r.vT - q.amountOut, vQ: r.vQ + q.amountInUsed - q.feeUsed });
    if (q.completes) {
      return { amountIn: q.amountInUsed, priceBefore, priceAfter: after, completes: true };
    }
    if (after >= target) return { amountIn, priceBefore, priceAfter: after, completes: false };
    amountIn += amountIn / 1_000n + 1n;
  }
}

/** A plain-EOA wallet client with public actions. */
export type Wallet = Client<
  HttpTransport,
  Chain,
  LocalAccount,
  WalletRpcSchema,
  WalletActions<Chain, LocalAccount> & PublicActions<HttpTransport, Chain, LocalAccount>
>;

function wallet(rpcUrl: string, account: LocalAccount, pollingInterval: number): Wallet {
  return createWalletClient({
    account,
    chain: mantleSepoliaTestnet,
    transport: http(rpcUrl),
    pollingInterval,
  }).extend(publicActions);
}

/**
 * A non-LLM market (DESIGN §8.3): plain EOAs create tokens and trade them directly on the
 * launchpad, paying their own gas. Every method waits for its transaction's receipt and throws
 * if it reverted. Methods take a wallet index (default: a seeded random choice).
 */
export class MarketSim {
  readonly launchpad: Address;
  readonly quoteToken: Address;
  readonly wallets: readonly Wallet[];
  private readonly random: () => number;
  private log: (event: SimEvent) => void;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private params?: CurveParams;

  constructor(cfg: MarketSimConfig) {
    if (cfg.accounts.length === 0) throw new Error("market-sim needs at least one account");
    const book = cfg.launchpad && cfg.quoteToken ? undefined : loadDeployments();
    const launchpad = cfg.launchpad ?? book?.memeLaunchpad;
    if (!launchpad) throw new Error("No MemeLaunchpad address");
    this.launchpad = launchpad;
    const quoteToken = cfg.quoteToken ?? book?.mockUsd;
    if (!quoteToken) throw new Error("No quote token address");
    this.quoteToken = quoteToken;
    this.pollMs = cfg.pollingIntervalMs ?? 250;
    this.timeoutMs = cfg.receiptTimeoutMs ?? 60_000;
    this.wallets = cfg.accounts.map((a) => wallet(cfg.rpcUrl, a, this.pollMs));
    this.random = rng(cfg.seed ?? 1);
    this.log = cfg.log ?? (() => {});
  }

  /** The EOA addresses, in wallet-index order (fund these with MNT). */
  get addresses(): Address[] {
    return this.wallets.map((w) => w.account.address);
  }

  private pick(index?: number): Wallet {
    const i = index ?? Math.floor(this.random() * this.wallets.length);
    const w = this.wallets[i];
    if (!w) throw new RangeError(`No wallet ${i} (have ${this.wallets.length})`);
    return w;
  }

  private emit<E extends SimEvent>(event: E): E {
    this.log(event);
    return event;
  }

  private async curveParams(): Promise<CurveParams> {
    this.params ??= await readCurveParams(this.wallets[0] as Wallet, this.launchpad);
    return this.params;
  }

  /** Sends one call and polls for its receipt (bounded); throws on a revert or a timeout. */
  private async send(w: Wallet, call: { to: Address; data: Hex }): Promise<TransactionReceipt> {
    const hash = await w.sendTransaction({ to: call.to, data: call.data });
    for (const until = Date.now() + this.timeoutMs; ; await sleep(this.pollMs)) {
      const r = await w.getTransactionReceipt({ hash }).catch(() => undefined);
      if (r) {
        if (r.status !== "success") throw new Error(`transaction ${hash} reverted`);
        return r;
      }
      if (Date.now() > until) throw new Error(`no receipt for ${hash} within ${this.timeoutMs} ms`);
    }
  }

  private async deadline(w: Wallet): Promise<bigint> {
    return (await w.getBlock()).timestamp + 300n;
  }

  private balanceOf(w: Wallet, token: Address): Promise<bigint> {
    return w.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [w.account.address],
    });
  }

  /** Mints MockUSD (anyone may mint) when `w` holds less than `amount`. */
  private async ensureQuote(w: Wallet, amount: bigint): Promise<void> {
    const balance = await this.balanceOf(w, this.quoteToken);
    if (balance >= amount) return;
    const mint = amount - balance + MINT_BUFFER;
    const data = encodeFunctionData({
      abi: mockUsdAbi,
      functionName: "mint",
      args: [w.account.address, mint],
    });
    const r = await this.send(w, { to: this.quoteToken, data });
    this.emit({ kind: "mint", wallet: w.account.address, amount: mint, tx: r.transactionHash });
  }

  /** `createToken` from a plain EOA; resolves with the new token (from `TokenCreated`). */
  async createToken(
    opts: { wallet?: number; name?: string; symbol?: string } = {},
  ): Promise<CreateEvent> {
    const w = this.pick(opts.wallet);
    const word = WORDS[Math.floor(this.random() * WORDS.length)] as string;
    const n = Math.floor(this.random() * 10_000);
    const name = opts.name ?? `${word} ${n}`;
    const symbol = opts.symbol ?? `${word.slice(0, 4).toUpperCase()}${n}`;
    const r = await this.send(
      w,
      createTokenCall(this.launchpad, { name, symbol, salt: randomSalt() }),
    );
    const [created] = parseEventLogs({
      abi: memeLaunchpadAbi,
      eventName: "TokenCreated",
      logs: r.logs,
    });
    if (!created) throw new Error(`no TokenCreated in ${r.transactionHash}`);
    return this.emit({
      kind: "create",
      wallet: w.account.address,
      token: created.args.token,
      name,
      symbol,
      tx: r.transactionHash,
    });
  }

  private tradeEvent(
    kind: "buy" | "sell",
    w: Wallet,
    token: Address,
    r: TransactionReceipt,
  ): TradeEvent {
    const [trade] = parseEventLogs({ abi: memeLaunchpadAbi, eventName: "Trade", logs: r.logs });
    if (!trade) throw new Error(`no Trade in ${r.transactionHash}`);
    const completed =
      parseEventLogs({ abi: memeLaunchpadAbi, eventName: "CurveCompleted", logs: r.logs }).length >
      0;
    return {
      kind,
      wallet: w.account.address,
      token,
      quoteAmount: trade.args.quoteAmount,
      tokenAmount: trade.args.tokenAmount,
      completed,
      tx: r.transactionHash,
    };
  }

  /**
   * `approve(amountIn)` + `buy(token, amountIn, …)` exactly as requested — **not** clamped to the
   * completing amount. A request above what the curve has left therefore completes it through the
   * contract's on-chain truncation (DESIGN §4.3.3): only `amountInUsed` is pulled.
   */
  async buy(
    token: Address,
    amountIn: bigint,
    opts: { wallet?: number; slippageBps?: number } = {},
  ): Promise<TradeEvent> {
    const w = this.pick(opts.wallet);
    await this.ensureQuote(w, amountIn);
    const q = await quoteBuy(w, this.launchpad, token, amountIn);
    await this.send(w, approveCall(this.quoteToken, this.launchpad, amountIn));
    const r = await this.send(
      w,
      buyCall(this.launchpad, {
        token,
        amount: amountIn,
        minOut: minOutFor(q.amountOut, opts.slippageBps),
        deadline: await this.deadline(w),
        recipient: w.account.address,
      }),
    );
    return this.emit(this.tradeEvent("buy", w, token, r));
  }

  /** `sell(token, amount, …)` from the EOA's own balance (no approve needed). */
  async sell(
    token: Address,
    amount: bigint,
    opts: { wallet?: number; slippageBps?: number } = {},
  ): Promise<TradeEvent> {
    const w = this.pick(opts.wallet);
    const q = await quoteSell(w, this.launchpad, token, amount);
    const r = await this.send(
      w,
      sellCall(this.launchpad, {
        token,
        amount,
        minOut: minOutFor(q.amountOut, opts.slippageBps),
        deadline: await this.deadline(w),
        recipient: w.account.address,
      }),
    );
    return this.emit(this.tradeEvent("sell", w, token, r));
  }

  /**
   * Buys `token` hard enough to lift its spot price (`curveState.priceE18`) to at least
   * `(1 + percent/100)` × the spot price right before the pump (default 100: the price doubles).
   * The amount comes from `planPump` and is capped at the curve's completing amount.
   */
  async pump(token: Address, opts: { percent?: number; wallet?: number } = {}): Promise<PumpEvent> {
    const percent = opts.percent ?? 100;
    const w = this.pick(opts.wallet);
    const s = await curveState(w, this.launchpad, token);
    const plan = planPump(
      await this.curveParams(),
      { vT: s.virtualToken, vQ: s.virtualQuote },
      percent,
    );
    const bought = await this.buy(token, plan.amountIn, { wallet: this.wallets.indexOf(w) });
    const after = await curveState(w, this.launchpad, token);
    return this.emit({
      kind: "pump",
      wallet: w.account.address,
      token,
      percent,
      priceBefore: s.priceE18,
      priceAfter: after.priceE18,
      quoteAmount: bought.quoteAmount,
      completed: bought.completed,
      tx: bought.tx,
    });
  }

  /** The newest (≤ 20) launchpad tokens that are still trading. */
  private async tradingTokens(): Promise<Address[]> {
    const w = this.wallets[0] as Wallet;
    const all = await scanTokens(w, this.launchpad, 20n);
    const states = await Promise.all(all.map((t) => curveState(w, this.launchpad, t)));
    return all.filter((_, i) => states[i]?.status === "trading");
  }

  /**
   * One scheduler step: `create`, or a random buy (1–20 mUSD) or sell (20–100% of a holding) on
   * a trading token. Without `kind`, it buys or sells (60/40; a sell needs a holding). A buy that
   * would complete a curve, or a sell too small to pay out, is skipped instead of sent.
   */
  async step(kind?: "create" | "buy" | "sell"): Promise<SimEvent> {
    if (kind === "create") return this.createToken();
    const tokens = await this.tradingTokens();
    if (tokens.length === 0) return this.createToken();
    const w = this.pick();
    const wi = this.wallets.indexOf(w);
    const holdings = (
      await Promise.all(tokens.map(async (t) => [t, await this.balanceOf(w, t)] as const))
    ).filter(([, b]) => b > 0n);
    const sell =
      kind === "sell" || (kind === undefined && holdings.length > 0 && this.random() < 0.4);
    if (sell) {
      const holding = holdings[Math.floor(this.random() * holdings.length)];
      if (!holding) return this.emit({ kind: "skip", reason: "no_holding" });
      const [token, balance] = holding;
      const amount = (balance * BigInt(20 + Math.floor(this.random() * 81))) / 100n;
      try {
        await quoteSell(w, this.launchpad, token, amount);
      } catch {
        return this.emit({ kind: "skip", reason: "sell_quote_reverts", token });
      }
      return this.sell(token, amount, { wallet: wi });
    }
    const token = tokens[Math.floor(this.random() * tokens.length)] as Address;
    const amount = mUSD + BigInt(Math.floor(this.random() * 19 * 1e6));
    const q = await quoteBuy(w, this.launchpad, token, amount);
    if (q.completes) return this.emit({ kind: "skip", reason: "would_complete", token });
    return this.buy(token, amount, { wallet: wi });
  }

  /**
   * Runs the schedule until `signal` aborts: a create right away and then every
   * `createIntervalMs`, random trades every `tradeIntervalMs` in between. A failed step is
   * reported as an `error` event and the loop carries on.
   */
  async run(opts: RunOptions = {}): Promise<RunSummary> {
    const { signal } = opts;
    const [cMin, cMax] = opts.createIntervalMs ?? [120_000, 300_000];
    const [tMin, tMax] = opts.tradeIntervalMs ?? [10_000, 30_000];
    const between = (min: number, max: number) => min + this.random() * (max - min);
    const summary: RunSummary = { creates: 0, buys: 0, sells: 0, mints: 0, skips: 0, errors: 0 };
    const outer = this.log;
    this.log = (e) => {
      if (e.kind === "create") summary.creates++;
      else if (e.kind === "buy") summary.buys++;
      else if (e.kind === "sell") summary.sells++;
      else if (e.kind === "mint") summary.mints++;
      else if (e.kind === "skip") summary.skips++;
      else if (e.kind === "error") summary.errors++;
      outer(e);
    };
    try {
      let nextCreate = Date.now();
      while (!signal?.aborted) {
        const create = Date.now() >= nextCreate;
        if (create) nextCreate = Date.now() + between(cMin, cMax);
        try {
          await this.step(create ? "create" : undefined);
        } catch (e) {
          this.emit({
            kind: "error",
            action: create ? "create" : "trade",
            message: (e as Error).message.split("\n")[0] ?? String(e),
          });
        }
        const wait = Math.min(between(tMin, tMax), Math.max(0, nextCreate - Date.now()));
        try {
          await sleep(wait, undefined, signal ? { signal } : {});
        } catch {
          break; // aborted
        }
      }
    } finally {
      this.log = outer;
    }
    return summary;
  }
}
