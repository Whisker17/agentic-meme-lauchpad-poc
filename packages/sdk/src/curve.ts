import type { Address, Client } from "viem";
import { readContract } from "viem/actions";
import { memeLaunchpadAbi } from "./generated.js";

/** A launchpad's immutable curve parameters, in base units (`MemeLaunchpad.CurveParams`). */
export interface CurveParams {
  totalSupply: bigint;
  curveSupply: bigint;
  virtualToken0: bigint;
  virtualQuote0: bigint;
  feeBps: bigint;
}

/** The parameter set of DESIGN §4.2 (18-decimal token, 6-decimal quote). */
export const DESIGN_CURVE_PARAMS: CurveParams = {
  totalSupply: 1_000_000_000n * 10n ** 18n,
  curveSupply: 800_000_000n * 10n ** 18n,
  virtualToken0: 1_066_666_667n * 10n ** 18n,
  virtualQuote0: 200n * 10n ** 6n,
  feeBps: 100n,
};

/** Reads the curve parameters from a deployed launchpad's immutables. */
export async function readCurveParams(client: Client, launchpad: Address): Promise<CurveParams> {
  const read = (
    functionName:
      | "TOTAL_SUPPLY"
      | "CURVE_SUPPLY"
      | "VIRTUAL_TOKEN_0"
      | "VIRTUAL_QUOTE_0"
      | "FEE_BPS",
  ) => readContract(client, { address: launchpad, abi: memeLaunchpadAbi, functionName });
  const [totalSupply, curveSupply, virtualToken0, virtualQuote0, feeBps] = await Promise.all([
    read("TOTAL_SUPPLY"),
    read("CURVE_SUPPLY"),
    read("VIRTUAL_TOKEN_0"),
    read("VIRTUAL_QUOTE_0"),
    read("FEE_BPS"),
  ]);
  return { totalSupply, curveSupply, virtualToken0, virtualQuote0, feeBps };
}

/** Virtual reserves of one token's curve. */
export interface Reserves {
  vT: bigint;
  vQ: bigint;
}

export interface BuyQuote {
  amountOut: bigint;
  /** Quote actually pulled; below the request only when the buy completes the curve. */
  amountInUsed: bigint;
  feeUsed: bigint;
  completes: boolean;
}

export interface SellQuote {
  amountOut: bigint;
  fee: bigint;
}

/** A trade the contract would revert; `errorName` is the contract's custom error. */
export class CurveModelError extends Error {
  override readonly name = "CurveModelError";
  constructor(readonly errorName: "CurveAlreadyCompleted" | "ZeroAmount" | "ZeroOutput") {
    super(`The launchpad would revert with ${errorName}`);
  }
}

const BPS = 10_000n;
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);
const feeOf = (p: CurveParams, amount: bigint) => ceilDiv(amount * p.feeBps, BPS);

/** The initial reserves of every new token. */
export function initialReserves(p: CurveParams): Reserves {
  return { vT: p.virtualToken0, vQ: p.virtualQuote0 };
}

/** `vQ · 1e36 / vT`: quote base units per whole (1e18 base units) token, scaled by 1e18. */
export function priceE18(r: Reserves): bigint {
  return (r.vQ * 10n ** 36n) / r.vT;
}

function tradable(p: CurveParams, r: Reserves, amount: bigint): bigint {
  const vTEnd = p.virtualToken0 - p.curveSupply;
  // A trading curve always has tokens left; the completing buy leaves exactly vTEnd.
  if (r.vT <= vTEnd) throw new CurveModelError("CurveAlreadyCompleted");
  if (amount === 0n) throw new CurveModelError("ZeroAmount");
  return vTEnd;
}

/** Local model of `quoteBuy`: the same integer arithmetic as the contract (DESIGN §4.3.2–4.3.3). */
export function simulateBuy(p: CurveParams, r: Reserves, amountIn: bigint): BuyQuote {
  const vTEnd = tradable(p, r, amountIn);
  const k = p.virtualToken0 * p.virtualQuote0;
  const remaining = r.vT - vTEnd;
  let amountInUsed = amountIn;
  let feeUsed = feeOf(p, amountIn);
  let amountOut = r.vT - ceilDiv(k, r.vQ + amountIn - feeUsed);
  let completes = false;
  if (amountOut >= remaining) {
    const netNeeded = ceilDiv(k, vTEnd) - r.vQ;
    amountInUsed = ceilDiv(netNeeded * BPS, BPS - p.feeBps);
    feeUsed = feeOf(p, amountInUsed);
    amountOut = remaining;
    completes = true;
  }
  if (amountInUsed === feeUsed || amountOut === 0n) throw new CurveModelError("ZeroOutput");
  return { amountOut, amountInUsed, feeUsed, completes };
}

/** Local model of `quoteSell`. */
export function simulateSell(p: CurveParams, r: Reserves, amount: bigint): SellQuote {
  tradable(p, r, amount);
  const k = p.virtualToken0 * p.virtualQuote0;
  const gross = r.vQ - ceilDiv(k, r.vT + amount);
  const fee = feeOf(p, gross);
  const amountOut = gross - fee;
  if (amountOut === 0n) throw new CurveModelError("ZeroOutput");
  return { amountOut, fee };
}

/** Reserves after a buy described by `q`. */
export function applyBuy(r: Reserves, q: BuyQuote): Reserves {
  return { vT: r.vT - q.amountOut, vQ: r.vQ + q.amountInUsed - q.feeUsed };
}

/** Reserves after selling `amount` tokens described by `q`. */
export function applySell(r: Reserves, amount: bigint, q: SellQuote): Reserves {
  return { vT: r.vT + amount, vQ: r.vQ - q.amountOut - q.fee };
}
