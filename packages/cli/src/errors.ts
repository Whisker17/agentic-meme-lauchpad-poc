import { describeError, EXIT_CODES } from "@0xwh1sker/mantle-aa-cli";
import { MemeError, toMemeError } from "@0xwh1sker/mantle-meme-sdk";

/** The meme exit codes of DESIGN §6.3, by `error.code`; AA codes pass through unchanged. */
export const MEME_EXIT_CODES = {
  CURVE_COMPLETED: 40,
  SLIPPAGE: 41,
  UNKNOWN_TOKEN: 42,
  INSUFFICIENT_BALANCE: 43,
  AUTOPILOT_STATE: 44,
} as const;

/** Every exit code `mantle-meme` uses: the AA CLI's and the meme ones. */
export const EXIT = { ...EXIT_CODES, ...MEME_EXIT_CODES } as const;

/** What the CLI says for exit 40 (DESIGN §4.5, R-7): never "graduated". */
export const CURVE_COMPLETED_TEXT =
  "Curve completed; trading is disabled. This v1 launchpad has no migration path, so the position is stranded.";

export interface ErrorDescription {
  exitCode: number;
  error: { code: string; type: string; message: string; [field: string]: unknown };
}

/**
 * The one mapping from error to exit code and `--json` error. A launchpad revert or a meme error
 * of the SDK (`execute` diagnoses a failed batch from chain state) is 40–44; everything else goes
 * through the AA CLI's own `describeError`, so AA codes (0, 1, 10–13, 20, 21, 30) are unchanged.
 */
export function describe(error: unknown): ErrorDescription {
  const e = toMemeError(error);
  if (!(e instanceof MemeError)) return describeError(e);
  const fields = Object.fromEntries(
    Object.entries(e).filter(([k]) => !["name", "message", "stack", "cause", "code"].includes(k)),
  );
  const message = e.code === "CURVE_COMPLETED" ? CURVE_COMPLETED_TEXT : e.message;
  const exitCode = MEME_EXIT_CODES[e.code as keyof typeof MEME_EXIT_CODES] ?? EXIT_CODES.ERROR;
  return { exitCode, error: { code: e.code, type: e.name, message, ...fields } };
}
