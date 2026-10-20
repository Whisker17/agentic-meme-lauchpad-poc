import type { Call } from "@0xwh1sker/mantle-aa-sdk";
import type { Address, Client } from "viem";
import { readContract } from "viem/actions";
import { approveCall, buyCall, defaultDeadline } from "./calls.js";
import type { BuyQuote, SellQuote } from "./curve.js";
import { memeLaunchpadAbi } from "./generated.js";

/** Default slippage of a command trade (5%); the autopilot passes 300. */
export const DEFAULT_SLIPPAGE_BPS = 500;

/** `quoteBuy` view: exactly what `buy(token, amountIn, …)` would do now; reverts as `buy` would. */
export async function quoteBuy(
  client: Client,
  launchpad: Address,
  token: Address,
  amountIn: bigint,
): Promise<BuyQuote> {
  const [amountOut, amountInUsed, feeUsed, completes] = await readContract(client, {
    address: launchpad,
    abi: memeLaunchpadAbi,
    functionName: "quoteBuy",
    args: [token, amountIn],
  });
  return { amountOut, amountInUsed, feeUsed, completes };
}

/** `quoteSell` view: exactly what `sell(token, amount, …)` would pay out now. */
export async function quoteSell(
  client: Client,
  launchpad: Address,
  token: Address,
  amount: bigint,
): Promise<SellQuote> {
  const [amountOut, fee] = await readContract(client, {
    address: launchpad,
    abi: memeLaunchpadAbi,
    functionName: "quoteSell",
    args: [token, amount],
  });
  return { amountOut, fee };
}

/** `amountOut · (1 − slippage)`, rounded down. */
export function minOutFor(amountOut: bigint, slippageBps: number = DEFAULT_SLIPPAGE_BPS): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError(`slippageBps must be an integer in [0, 10000], got ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface BuyPlanArgs {
  launchpad: Address;
  /** The launchpad's quote asset (MockUSD). */
  quoteToken: Address;
  token: Address;
  recipient: Address;
  /** The requested spend, fee included. */
  amountIn: bigint;
  /** `quoteBuy(token, amountIn)` for this same request. */
  quote: BuyQuote;
  slippageBps?: number;
  deadline?: bigint;
}

export interface BuyPlan {
  /**
   * What the buy costs: the request, or `amountInUsed` when it completes the curve. The approve,
   * the BUY calldata, budget checks and the displayed cost all use this value.
   */
  amountIn: bigint;
  amountOut: bigint;
  fee: bigint;
  minOut: bigint;
  completes: boolean;
  deadline: bigint;
  /** `[approve(quoteToken → launchpad, amountIn), buy(token, amountIn, minOut, deadline, recipient)]` */
  calls: [Call, Call];
}

/**
 * Builds the approve + buy batch. A completing buy is clamped to `amountInUsed` in both calls:
 * the policy hook refuses an approve above the remaining limit and the session simulation charges
 * the BUY's `amountIn` (DESIGN §4.3.3).
 */
export function planBuy(a: BuyPlanArgs): BuyPlan {
  const amountIn = a.quote.completes ? a.quote.amountInUsed : a.amountIn;
  const minOut = minOutFor(a.quote.amountOut, a.slippageBps);
  const deadline = a.deadline ?? defaultDeadline();
  return {
    amountIn,
    amountOut: a.quote.amountOut,
    fee: a.quote.feeUsed,
    minOut,
    completes: a.quote.completes,
    deadline,
    calls: [
      approveCall(a.quoteToken, a.launchpad, amountIn),
      buyCall(a.launchpad, {
        token: a.token,
        amount: amountIn,
        minOut,
        deadline,
        recipient: a.recipient,
      }),
    ],
  };
}
