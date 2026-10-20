import { type Address, isAddressEqual, parseUnits } from "viem";
import {
  CurveModelError,
  type CurveParams,
  initialReserves,
  priceE18,
  type Reserves,
  simulateSell,
} from "./curve.js";

/**
 * An autopilot strategy (DESIGN §7.3), validated. Percentages are kept as basis points; the
 * quote amount in base units (6 decimals).
 */
export interface Strategy {
  entry: {
    /** Quote base units spent on each new token, fee included. */
    amountPerToken: bigint;
    /** The token's age when the watcher observes it (chain time), at most. */
    maxAgeSeconds: number;
    /** Case-insensitive substrings of the name or symbol; empty = every token. */
    keywords: string[];
    /** Skip tokens the account created. */
    excludeOwn: boolean;
    maxOpenPositions: number;
    /** Skip a token whose spot price exceeds this multiple of its launch price (basis points). */
    maxEntryPriceMultipleBps: bigint;
  };
  exit: {
    takeProfitBps: bigint;
    takeProfitSellBps: bigint;
    /** Chain seconds after the buy at which the remaining inventory is sold. */
    maxHoldSeconds: bigint;
  };
  slippageBps: number;
}

/** A strategy file that does not satisfy the schema. */
export class StrategyError extends Error {
  override readonly name = "StrategyError";
}

const ENTRY_KEYS = [
  "amountPerToken",
  "maxAgeSeconds",
  "keywords",
  "excludeOwn",
  "maxOpenPositions",
  "maxEntryPriceMultiple",
];
const EXIT_KEYS = [
  "takeProfitPercent",
  "takeProfitSellPercent",
  "maxHoldMinutes",
  "stopLossPercent",
];

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StrategyError(`${path} must be an object`);
  }
  for (const k of Object.keys(value)) {
    if (!keys.includes(k)) throw new StrategyError(`${path}.${k} is not a strategy field`);
  }
  return value as Record<string, unknown>;
}

interface NumOptions {
  min: number;
  max?: number;
  /** `min` itself is refused. */
  open?: boolean;
  integer?: boolean;
  /** The value when the field is absent; without it the field is required. */
  fallback?: number;
}

/** A finite number in `[min, max]` (`(min, max]` when `open`). */
function num(o: Record<string, unknown>, key: string, path: string, opts: NumOptions): number {
  const { min, max, open = false, integer = false } = opts;
  const v = o[key] ?? opts.fallback;
  if (v === undefined) throw new StrategyError(`${path}.${key} is required`);
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (integer && !Number.isInteger(v)) ||
    (open ? v <= min : v < min) ||
    (max !== undefined && v > max)
  ) {
    throw new StrategyError(
      `${path}.${key} must be ${integer ? "an integer" : "a number"} ${open ? ">" : "≥"} ${min}${max === undefined ? "" : ` and ≤ ${max}`}`,
    );
  }
  return v;
}

/** A percentage or multiple in basis points; at most two decimals of a percent are kept. */
const bps = (percent: number) => BigInt(Math.round(percent * 100));

/**
 * Validates a strategy file (DESIGN §7.3). Unknown fields are refused. `amountPerToken` is a
 * decimal mUSD string (or number); `maxHoldMinutes` may be fractional. Defaults: `keywords` [],
 * `excludeOwn` true, `maxOpenPositions` 10, `maxEntryPriceMultiple` 2, `slippagePercent` 3.
 * `stopLossPercent` is reserved: any value but `null` is refused.
 */
export function parseStrategy(input: unknown, quoteDecimals = 6): Strategy {
  const s = object(input, "strategy", ["entry", "exit", "slippagePercent"]);
  const entry = object(s.entry, "entry", ENTRY_KEYS);
  const exit = object(s.exit, "exit", EXIT_KEYS);

  const rawAmount = entry.amountPerToken;
  const amount = typeof rawAmount === "number" ? String(rawAmount) : rawAmount;
  const [, fraction = ""] = typeof amount === "string" ? amount.split(".") : [];
  if (
    typeof amount !== "string" ||
    !/^\d+(\.\d+)?$/.test(amount) ||
    fraction.length > quoteDecimals ||
    parseUnits(amount, quoteDecimals) === 0n
  ) {
    throw new StrategyError(
      `entry.amountPerToken must be a positive decimal mUSD amount with at most ${quoteDecimals} decimals`,
    );
  }
  const keywords = entry.keywords ?? [];
  if (!Array.isArray(keywords) || keywords.some((k) => typeof k !== "string" || k === "")) {
    throw new StrategyError("entry.keywords must be an array of non-empty strings");
  }
  const excludeOwn = entry.excludeOwn ?? true;
  if (typeof excludeOwn !== "boolean")
    throw new StrategyError("entry.excludeOwn must be a boolean");
  if (exit.stopLossPercent !== undefined && exit.stopLossPercent !== null) {
    throw new StrategyError(
      "exit.stopLossPercent is reserved: stop-loss is not supported in this iteration (use null)",
    );
  }
  const slippage = num(s, "slippagePercent", "strategy", { min: 0, max: 100, fallback: 3 });
  return {
    entry: {
      amountPerToken: parseUnits(amount, quoteDecimals),
      maxAgeSeconds: num(entry, "maxAgeSeconds", "entry", { min: 0, open: true }),
      keywords: keywords as string[],
      excludeOwn,
      maxOpenPositions: num(entry, "maxOpenPositions", "entry", {
        min: 1,
        integer: true,
        fallback: 10,
      }),
      maxEntryPriceMultipleBps: bps(
        100 * num(entry, "maxEntryPriceMultiple", "entry", { min: 1, fallback: 2 }),
      ),
    },
    exit: {
      takeProfitBps: bps(num(exit, "takeProfitPercent", "exit", { min: 0, open: true })),
      takeProfitSellBps: bps(
        num(exit, "takeProfitSellPercent", "exit", { min: 0, max: 100, open: true }),
      ),
      maxHoldSeconds: BigInt(
        Math.ceil(num(exit, "maxHoldMinutes", "exit", { min: 0, open: true }) * 60),
      ),
    },
    slippageBps: Number(bps(slippage)),
  };
}

/** A `TokenCreated` the watcher observed, with the token's curve at that moment. */
export interface ObservedToken {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  /** `curveState.createdAt` (unix seconds). */
  createdAt: bigint;
  /** Chain time when the watcher observed the token. */
  observedAt: bigint;
  /** Spot `priceE18` when observed. */
  priceE18: bigint;
  /** `false` when the curve no longer trades. */
  trading: boolean;
}

/** A position the autopilot opened, with its current chain state. */
export interface HeldPosition {
  token: Address;
  symbol: string;
  /** Chain time of the block of the buy. */
  openedAt: bigint;
  /** The session key's inventory on the hook. */
  inventory: bigint;
  /** The journal's weighted cost basis of `inventory`; `null` = unknown. */
  costBasis: bigint | null;
  /** The curve's reserves; `null` when it no longer trades (completed). */
  reserves: Reserves | null;
  takeProfitDone: boolean;
}

export interface DecideInput {
  strategy: Strategy;
  params: CurveParams;
  /** The trading account (to recognise its own tokens). */
  account: Address;
  /** Chain time (latest block timestamp). */
  now: bigint;
  /** New tokens observed since the last decision. */
  observed: readonly ObservedToken[];
  /** The open positions to evaluate (all, or those a `Trade` touched). */
  positions: readonly HeldPosition[];
  /** How many positions are open in total. */
  openPositions: number;
  /** The quote asset's remaining policy limit and the account's balance. */
  budget: { remainingLimit: bigint; balance: bigint };
  /** A previous decision reported `budget_exhausted`: enter no more. */
  budgetExhausted: boolean;
}

export type SkipReason =
  | "too_old"
  | "own"
  | "keywords"
  | "not_trading"
  | "entry_price"
  | "max_positions"
  | "unknown_cost_basis";

export type Action =
  | { type: "buy"; token: Address; symbol: string; amountIn: bigint; ageSeconds: bigint }
  | { type: "skip"; token: Address; symbol: string; reason: SkipReason }
  | { type: "budget_exhausted"; needed: bigint; remainingLimit: bigint; balance: bigint }
  | {
      type: "sell";
      token: Address;
      symbol: string;
      amount: bigint;
      reason: "take_profit" | "max_hold";
      /** The local model's sell value net of fee. */
      expectedOut: bigint;
      /** The journal cost basis of `amount`. */
      costBasis: bigint;
    }
  | { type: "curve_completed"; token: Address; symbol: string };

/** Case-insensitive, locale-independent substring match on name or symbol; empty = all. */
export function matchesKeywords(keywords: readonly string[], name: string, symbol: string) {
  if (keywords.length === 0) return true;
  const n = name.toLowerCase();
  const s = symbol.toLowerCase();
  return keywords.some((k) => n.includes(k.toLowerCase()) || s.includes(k.toLowerCase()));
}

/** The cost basis of `amount` of a position. */
const portionCost = (p: HeldPosition & { costBasis: bigint }, amount: bigint) =>
  amount === p.inventory ? p.costBasis : (p.costBasis * amount) / p.inventory;

/** The local model's sale value net of fee; 0 for a sale that would pay nothing. */
function sellValue(params: CurveParams, reserves: Reserves, amount: bigint): bigint {
  try {
    return simulateSell(params, reserves, amount).amountOut;
  } catch (e) {
    if (e instanceof CurveModelError) return 0n;
    throw e;
  }
}

/**
 * Whether selling `amount` for `value` (net of fee) meets the take-profit: `value ≥ cost × (1 + tp)`.
 * The daemon re-checks it with `quoteSell` before sending.
 */
export function meetsTakeProfit(strategy: Strategy, value: bigint, cost: bigint): boolean {
  return value * 10_000n >= cost * (10_000n + strategy.exit.takeProfitBps);
}

/**
 * The strategy engine (DESIGN §5, §7.3): pure, deterministic, no I/O. Entry: each observed token
 * passes age (when observed), own, keywords, curve, entry-price guard and open-position cap, then
 * the budget (`remainingLimit` and balance ≥ `amountPerToken`; the first shortfall is one
 * `budget_exhausted` and no further entries). Exit, per position: a curve that no longer trades is
 * `curve_completed`; unknown cost basis is skipped (`unknown_cost_basis`); past the max hold the
 * whole inventory is sold; else take-profit once, on the local model's net sell value of the
 * portion against its cost basis.
 */
export function decide(input: DecideInput): Action[] {
  const { strategy, params, now } = input;
  const { entry, exit } = strategy;
  const actions: Action[] = [];
  const launch = priceE18(initialReserves(params));
  let open = input.openPositions;
  let { remainingLimit, balance } = input.budget;
  let exhausted = input.budgetExhausted;

  for (const t of input.observed) {
    if (exhausted) break;
    const skip = (reason: SkipReason) =>
      actions.push({ type: "skip", token: t.token, symbol: t.symbol, reason });
    const age = t.observedAt > t.createdAt ? t.observedAt - t.createdAt : 0n;
    if (age > BigInt(Math.floor(entry.maxAgeSeconds))) skip("too_old");
    else if (entry.excludeOwn && isAddressEqual(t.creator, input.account)) skip("own");
    else if (!matchesKeywords(entry.keywords, t.name, t.symbol)) skip("keywords");
    else if (!t.trading) skip("not_trading");
    else if (t.priceE18 * 10_000n > launch * entry.maxEntryPriceMultipleBps) skip("entry_price");
    else if (open >= entry.maxOpenPositions) skip("max_positions");
    else if (remainingLimit < entry.amountPerToken || balance < entry.amountPerToken) {
      actions.push({
        type: "budget_exhausted",
        needed: entry.amountPerToken,
        remainingLimit,
        balance,
      });
      exhausted = true;
    } else {
      actions.push({
        type: "buy",
        token: t.token,
        symbol: t.symbol,
        amountIn: entry.amountPerToken,
        ageSeconds: age,
      });
      open++;
      remainingLimit -= entry.amountPerToken;
      balance -= entry.amountPerToken;
    }
  }

  for (const p of input.positions) {
    const base = { token: p.token, symbol: p.symbol };
    if (p.reserves === null) {
      actions.push({ type: "curve_completed", ...base });
      continue;
    }
    if (p.inventory === 0n) continue;
    if (p.costBasis === null) {
      actions.push({ type: "skip", ...base, reason: "unknown_cost_basis" });
      continue;
    }
    const known = { ...p, costBasis: p.costBasis };
    if (now - p.openedAt >= exit.maxHoldSeconds) {
      actions.push({
        type: "sell",
        ...base,
        amount: p.inventory,
        reason: "max_hold",
        expectedOut: sellValue(params, p.reserves, p.inventory),
        costBasis: p.costBasis,
      });
      continue;
    }
    if (p.takeProfitDone) continue;
    const amount = (p.inventory * exit.takeProfitSellBps) / 10_000n;
    if (amount === 0n) continue;
    const value = sellValue(params, p.reserves, amount);
    const cost = portionCost(known, amount);
    if (value > 0n && meetsTakeProfit(strategy, value, cost)) {
      actions.push({
        type: "sell",
        ...base,
        amount,
        reason: "take_profit",
        expectedOut: value,
        costBasis: cost,
      });
    }
  }
  return actions;
}
