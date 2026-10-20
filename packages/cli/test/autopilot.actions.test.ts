// The daemon's action loop with the chain and the send stubbed (DESIGN §7.3): one decision whose
// first buy is refused for budget sends no further buy of that decision, and its exits still run.
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LimitExceededError } from "@0xwh1sker/mantle-aa-sdk";
import {
  type Action,
  execute,
  InsufficientBalanceError,
  parseStrategy,
  quoteBuy,
  quoteSell,
} from "@0xwh1sker/mantle-meme-sdk";
import type { Address, Client, Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AutopilotEvent, actOn, autopilotFiles, type Run } from "../src/autopilot.js";

vi.mock("@0xwh1sker/mantle-meme-sdk", async (original) => ({
  ...(await original<typeof import("@0xwh1sker/mantle-meme-sdk")>()),
  execute: vi.fn(),
  quoteBuy: vi.fn(),
  quoteSell: vi.fn(),
}));

const PAD = "0x00000000000000000000000000000000000000aa" as Address;
const USD = "0x00000000000000000000000000000000000000bb" as Address;
const HOOK = "0x00000000000000000000000000000000000000cc" as Address;
const ACCOUNT = "0x00000000000000000000000000000000000000dd" as Address;
const KEY = `0x${"11".repeat(32)}` as Hex;
const [A, B, P] = ["0x0a", "0x0b", "0x0c"].map((t) => `${t}${"0".repeat(38)}` as Address) as [
  Address,
  Address,
  Address,
];

const strategy = parseStrategy({
  entry: { amountPerToken: "4", maxAgeSeconds: 60 },
  exit: { takeProfitPercent: 50, takeProfitSellPercent: 50, maxHoldMinutes: 1 },
});

function setup() {
  const home = join(mkdtempSync(join(tmpdir(), "meme-autopilot-actions-")), "agent");
  mkdirSync(autopilotFiles(home).dir, { recursive: true });
  const events: AutopilotEvent[] = [];
  const run = {
    ctx: {
      home,
      env: {},
      pad: PAD,
      book: { mockUsd: USD, agentPolicyHook: HOOK },
      deadline: async () => 1_300n,
      tx: (hash: Hex) => ({ hash, explorer: null }),
    },
    strategy,
    client: {} as Client,
    session: { account: ACCOUNT, keyHash: KEY },
    account: ACCOUNT,
    hook: HOOK,
    fromBlock: 1n,
    state: {
      status: "running",
      budgetExhausted: false,
      pending: null,
      positions: [
        {
          token: P,
          symbol: "P",
          openedBlock: 1,
          openedAt: 1_000,
          status: "open",
          takeProfitDone: false,
        },
      ],
    },
  } as unknown as Run;
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    events.push({ at: "", event, ...fields });
  };
  return { run, events, emit, home };
}

const buy = (token: Address, symbol: string): Action => ({
  type: "buy",
  token,
  symbol,
  amountIn: strategy.entry.amountPerToken,
  ageSeconds: 1n,
});
const maxHold: Action = {
  type: "sell",
  token: P,
  symbol: "P",
  amount: 100n,
  reason: "max_hold",
  expectedOut: 60n,
  costBasis: 50n,
};

beforeEach(() => {
  vi.mocked(quoteBuy).mockReset().mockResolvedValue({
    amountOut: 1_000n,
    amountInUsed: strategy.entry.amountPerToken,
    feeUsed: 0n,
    completes: false,
  });
  vi.mocked(quoteSell).mockReset().mockResolvedValue({ amountOut: 60n, fee: 1n });
});

describe("autopilot action loop", () => {
  it.each([
    [
      "11 (policy limit)",
      () => new LimitExceededError({ asset: USD, remaining: 1n, requested: 4n }),
    ],
    ["43 (balance)", () => new InsufficientBalanceError({ balance: 1n, needed: 4n })],
  ])(
    "a buy refused with %s: the decision's next buy is never sent; its exit still runs",
    async (_, refusal) => {
      const { run, events, emit, home } = setup();
      // A buy is approve + buy (two calls) and is refused; a sale is one call and confirms.
      vi.mocked(execute)
        .mockReset()
        .mockImplementation(async (o) => {
          if (o.calls.length === 2) throw refusal();
          return {
            hash: `0x${"ee".repeat(32)}`,
            receipt: { blockNumber: 9n },
            trades: [],
          } as unknown as Awaited<ReturnType<typeof execute>>;
        });

      await actOn(run, [buy(A, "A"), buy(B, "B"), maxHold], 1_100n, emit);

      expect(vi.mocked(quoteBuy).mock.calls.map((c) => c[2])).toEqual([A]);
      expect(vi.mocked(execute)).toHaveBeenCalledTimes(2);
      expect(events.map((e) => [e.event, e.token, e.reason])).toEqual([
        ["budget_exhausted", A, undefined],
        ["sold", P, "max_hold"],
      ]);
      const state = JSON.parse(readFileSync(autopilotFiles(home).state, "utf8"));
      expect(state).toMatchObject({
        budgetExhausted: true,
        pending: null,
        positions: [{ token: P, status: "closed" }],
      });
    },
  );
});
