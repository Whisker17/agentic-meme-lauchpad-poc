import { appendFileSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import {
  type Address,
  getAddress,
  type Hex,
  isAddressEqual,
  parseEventLogs,
  type TransactionReceipt,
} from "viem";
import { memeLaunchpadAbi } from "./generated.js";
import { memeDir } from "./lock.js";

/** One trade of a confirmed submission of this session, as its own `Trade` log reports it. */
export interface JournalRecord {
  keyHash: Hex;
  txHash: Hex;
  token: Address;
  side: "buy" | "sell";
  /** BUY: quote pulled, fee included. SELL: quote paid out, net of the fee. */
  quotePulled: bigint;
  tokens: bigint;
  fee: bigint;
  blockNumber: bigint;
  /** The `execute` caller's `correlationId` (the autopilot's trade id); absent on manual trades. */
  correlationId?: string;
}

/** `<home>/meme/journal.jsonl`. */
export const journalPath = (home: string) => join(memeDir(home), "journal.jsonl");

/**
 * The journal records of a confirmed transaction: one per `Trade` log of `launchpad` in the
 * receipt whose trader is `account` (DESIGN §5, R-8; never a historical scan).
 */
export function tradesOf(
  receipt: TransactionReceipt,
  launchpad: Address,
  account: Address,
  keyHash: Hex,
): JournalRecord[] {
  return parseEventLogs({ abi: memeLaunchpadAbi, eventName: "Trade", logs: receipt.logs })
    .filter((l) => isAddressEqual(l.address, launchpad) && isAddressEqual(l.args.trader, account))
    .map((l) => ({
      keyHash,
      txHash: receipt.transactionHash,
      token: getAddress(l.args.token),
      side: l.args.isBuy ? "buy" : "sell",
      quotePulled: l.args.quoteAmount,
      tokens: l.args.tokenAmount,
      fee: l.args.fee,
      blockNumber: receipt.blockNumber,
    }));
}

const BIGINTS = ["quotePulled", "tokens", "fee", "blockNumber"] as const;

function parseRecord(line: string): JournalRecord {
  const r = JSON.parse(line);
  for (const k of BIGINTS) r[k] = BigInt(r[k]);
  return r as JournalRecord;
}

/** Whether `line`, the journal's unterminated last line, is a whole record (only its newline lost). */
function whole(line: string): boolean {
  try {
    parseRecord(line);
    return true;
  } catch {
    return false;
  }
}

/**
 * Appends records, one JSON line each (amounts as decimal strings). Called under the send lock, so
 * no other append runs: a last line a crash cut short is first dropped (or, when only its newline
 * was lost, terminated), so a record is never written onto it.
 */
export function appendJournal(home: string, records: readonly JournalRecord[]): void {
  if (records.length === 0) return;
  mkdirSync(memeDir(home), { recursive: true, mode: 0o700 });
  const file = journalPath(home);
  let lead = "";
  try {
    const text = readFileSync(file);
    const end = text.lastIndexOf("\n") + 1;
    if (end < text.length) {
      if (whole(text.subarray(end).toString("utf8"))) lead = "\n";
      else truncateSync(file, end);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const lines = records.map((r) =>
    JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
  appendFileSync(file, `${lead}${lines.join("\n")}\n`, { mode: 0o600 });
}

/**
 * Every record of the journal; none when it does not exist. An unterminated last line that is not
 * a whole record was cut short by a crash (or is being appended) and is skipped: that history is
 * unknown, so its cost basis reads as `null` (DESIGN §12). Corruption anywhere else throws.
 */
export function readJournal(home: string): JournalRecord[] {
  let text: string;
  try {
    text = readFileSync(journalPath(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const lines = text.split("\n");
  const last = lines.pop() as string;
  if (whole(last)) lines.push(last);
  return lines.filter((line) => line.trim() !== "").map(parseRecord);
}

/**
 * The weighted cost basis (fees included) of what remains of `keyHash`'s position in `token`:
 * buys add their quote pulled, sells remove the average cost of the tokens sold. `null`
 * ("unknown") unless the journal accounts for exactly `inventory`, the hook's inventory of the key.
 */
export function costBasis(
  records: readonly JournalRecord[],
  keyHash: Hex,
  token: Address,
  inventory: bigint,
): bigint | null {
  let held = 0n;
  let cost = 0n;
  for (const r of records) {
    if (r.keyHash.toLowerCase() !== keyHash.toLowerCase() || !isAddressEqual(r.token, token)) {
      continue;
    }
    if (r.side === "buy") {
      held += r.tokens;
      cost += r.quotePulled;
    } else {
      if (r.tokens > held) return null;
      cost -= held === 0n ? 0n : (cost * r.tokens) / held;
      held -= r.tokens;
    }
  }
  return held === inventory && held > 0n ? cost : null;
}
