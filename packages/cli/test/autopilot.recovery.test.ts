// Restart recovery of a pending autopilot trade (DESIGN §7.3, D33) against a real journal file:
// only the journal record carrying the pending trade's id is its outcome. A same-session manual
// trade of that token and side, journalled after the daemon died, is never taken for it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, type JournalRecord } from "@0xwh1sker/mantle-meme-sdk";
import { type Address, type Hex, zeroHash } from "viem";
import { describe, expect, it } from "vitest";
import { recover } from "../src/autopilot.js";

const KEY = `0x${"11".repeat(32)}` as Hex;
const T = `0x0a${"0".repeat(38)}` as Address;
type Reason = "buy" | "take_profit" | "max_hold";

const record = (side: "buy" | "sell", correlationId?: string): JournalRecord => ({
  keyHash: KEY,
  txHash: zeroHash,
  token: T,
  side,
  quotePulled: 1n,
  tokens: side === "buy" ? 10n : 4n,
  fee: 0n,
  blockNumber: 7n,
  ...(correlationId !== undefined && { correlationId }),
});

/** Recovers `reason` (id `pending`) over a journal of `records`; returns the positions after it. */
function recovered(reason: Reason, records: JournalRecord[]) {
  const home = mkdtempSync(join(tmpdir(), "meme-autopilot-recover-"));
  appendJournal(home, records);
  const open = { token: T, symbol: "T", openedBlock: 1, openedAt: 1, takeProfitDone: false };
  const state = { positions: reason === "buy" ? [] : [{ ...open, status: "open" }] };
  recover(
    state as unknown as Parameters<typeof recover>[0],
    { token: T, symbol: "T", reason, id: "pending" },
    home,
  );
  return state.positions;
}

const unchanged = {
  buy: [],
  take_profit: [expect.objectContaining({ status: "open", takeProfitDone: false })],
  max_hold: [expect.objectContaining({ status: "open", takeProfitDone: false })],
};
const applied = {
  buy: [expect.objectContaining({ status: "open", openedBlock: 7, takeProfitDone: false })],
  take_profit: [expect.objectContaining({ status: "open", takeProfitDone: true })],
  max_hold: [expect.objectContaining({ status: "closed" })],
};
const sideOf = (reason: Reason) => (reason === "buy" ? "buy" : "sell");

describe("autopilot restart recovery", () => {
  it.each(["buy", "take_profit", "max_hold"] as const)(
    "a pending %s that never confirmed, then a same-session manual trade of that token and side: not applied",
    (reason) => {
      expect(recovered(reason, [record(sideOf(reason))])).toEqual(unchanged[reason]);
    },
  );

  it.each(["buy", "take_profit", "max_hold"] as const)(
    "a pending %s whose own record is journalled: applied once, past manual and older autopilot trades",
    (reason) => {
      const side = sideOf(reason);
      const records = [record(side, "earlier"), record(side), record(side, "pending")];
      expect(recovered(reason, records)).toEqual(applied[reason]);
    },
  );
});
