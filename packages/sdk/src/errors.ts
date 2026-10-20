import { ExecutionRevertedError } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, BaseError, decodeErrorResult, type Hex, isHex, parseAbi } from "viem";
import { CurveModelError } from "./curve.js";
import { memeLaunchpadAbi, memeTokenAbi } from "./generated.js";

/**
 * The meme errors (DESIGN §5). AA SDK errors pass through unchanged. `code` is the CLI's
 * `error.code` (DESIGN §6.3); the exit code mapping belongs to the CLI.
 */
export abstract class MemeError extends Error {
  abstract readonly code: string;
}

/** The curve is completed: trading is disabled and v1 has no migration path. */
export class CurveCompletedError extends MemeError {
  override readonly name = "CurveCompletedError";
  readonly code = "CURVE_COMPLETED";
  constructor(message = "Curve completed; trading is disabled (no migration path in v1)") {
    super(message);
  }
}

/** The output fell below `minOut`. */
export class SlippageError extends MemeError {
  override readonly name = "SlippageError";
  readonly code = "SLIPPAGE";
  constructor(message = "Output below minOut (slippage)") {
    super(message);
  }
}

/** A registry entry that matched (or nearly matched) a symbol. */
export interface TokenCandidate {
  address: Address;
  name: string;
  symbol: string;
}

/** Not registered on this launchpad, or a symbol that matches no token or more than one. */
export class UnknownTokenError extends MemeError {
  override readonly name = "UnknownTokenError";
  readonly code = "UNKNOWN_TOKEN";
  /** At most 10: the ambiguous matches, or near matches of a missing symbol. */
  readonly candidates: TokenCandidate[];
  constructor(
    message = "Token is not registered on this launchpad",
    candidates: TokenCandidate[] = [],
  ) {
    super(message);
    this.candidates = candidates.slice(0, 10);
  }
}

/** The account's quote (or token) balance is too low. */
export class InsufficientBalanceError extends MemeError {
  override readonly name = "InsufficientBalanceError";
  readonly code = "INSUFFICIENT_BALANCE";
  readonly balance: bigint | undefined;
  readonly needed: bigint | undefined;
  constructor(params: { balance?: bigint; needed?: bigint } = {}) {
    super(
      params.needed === undefined
        ? "Balance too low"
        : `Balance too low: have ${params.balance}, need ${params.needed}`,
    );
    this.balance = params.balance;
    this.needed = params.needed;
  }
}

/** The autopilot is already running / not running. */
export class AutopilotStateError extends MemeError {
  override readonly name = "AutopilotStateError";
  readonly code = "AUTOPILOT_STATE";
}

const revertAbi = [
  ...memeLaunchpadAbi,
  ...memeTokenAbi.filter((x) => x.type === "error"),
  // Calibur v1.1.0 wraps a failed call's revert data.
  ...parseAbi(["error CallFailed(bytes reason)"]),
];

/** The revert data of an error: an AA `ExecutionRevertedError`'s, or the deepest viem cause's. */
function revertData(error: unknown): Hex | undefined {
  if (error instanceof ExecutionRevertedError) return error.data;
  if (!(error instanceof BaseError)) return undefined;
  const raw = (error.walk() as { data?: unknown }).data;
  const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
  return isHex(data) ? data : undefined;
}

function fromRevert(data: Hex): MemeError | undefined {
  let decoded: ReturnType<typeof decodeErrorResult<typeof revertAbi>>;
  try {
    decoded = decodeErrorResult({ abi: revertAbi, data });
  } catch {
    return undefined;
  }
  switch (decoded.errorName) {
    case "CallFailed":
      return fromRevert(decoded.args[0]);
    case "CurveAlreadyCompleted":
      return new CurveCompletedError();
    case "InsufficientOutput":
      return new SlippageError();
    case "UnknownToken":
      return new UnknownTokenError();
    case "ERC20InsufficientBalance":
      return new InsufficientBalanceError({ balance: decoded.args[1], needed: decoded.args[2] });
    default:
      return undefined;
  }
}

/**
 * Maps a launchpad revert (`CurveAlreadyCompleted`, `InsufficientOutput`, `UnknownToken`, an ERC20
 * `ERC20InsufficientBalance`; unwrapped from Calibur's `CallFailed`) or a local curve model refusal
 * to its meme error. Anything else is returned unchanged.
 */
export function toMemeError(error: unknown): unknown {
  if (error instanceof MemeError) return error;
  if (error instanceof CurveModelError && error.errorName === "CurveAlreadyCompleted") {
    return Object.assign(new CurveCompletedError(), { cause: error });
  }
  const data = revertData(error);
  const mapped = data && fromRevert(data);
  if (!mapped) return error;
  mapped.cause = error;
  return mapped;
}
