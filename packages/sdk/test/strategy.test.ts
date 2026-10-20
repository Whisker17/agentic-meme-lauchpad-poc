// The strategy engine (DESIGN §7.3, §10): schema validation and the pure decision table.
import {
  applyBuy,
  type DecideInput,
  decide,
  type HeldPosition,
  initialReserves,
  matchesKeywords,
  type ObservedToken,
  DESIGN_CURVE_PARAMS as P,
  parseStrategy,
  priceE18,
  StrategyError,
  simulateBuy,
  simulateSell,
} from "@0xwh1sker/mantle-meme-sdk";
import { type Address, parseUnits } from "viem";
import { describe, expect, it } from "vitest";

const ME = "0x00000000000000000000000000000000000000Aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bB" as Address;
const tokenAt = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const mUSD = (n: number) => parseUnits(String(n), 6);

/** The DESIGN §7.3 example. */
const EXAMPLE = {
  entry: {
    amountPerToken: "3",
    maxAgeSeconds: 60,
    keywords: [],
    excludeOwn: true,
    maxOpenPositions: 10,
    maxEntryPriceMultiple: 2,
  },
  exit: {
    takeProfitPercent: 50,
    takeProfitSellPercent: 50,
    maxHoldMinutes: 30,
    stopLossPercent: null,
  },
  slippagePercent: 3,
};

const strategy = (patch: { entry?: object; exit?: object } = {}) =>
  parseStrategy({
    ...EXAMPLE,
    entry: { ...EXAMPLE.entry, ...patch.entry },
    exit: { ...EXAMPLE.exit, ...patch.exit },
  });

const launch = initialReserves(P);

function observed(o: Partial<ObservedToken> = {}): ObservedToken {
  return {
    token: tokenAt(1),
    name: "Some coin",
    symbol: "SOME",
    creator: OTHER,
    createdAt: 1_000n,
    observedAt: 1_010n,
    priceE18: priceE18(launch),
    trading: true,
    ...o,
  };
}

const input = (o: Partial<DecideInput> = {}): DecideInput => ({
  strategy: strategy(),
  params: P,
  account: ME,
  now: 1_010n,
  observed: [],
  positions: [],
  openPositions: 0,
  budget: { remainingLimit: mUSD(100), balance: mUSD(100) },
  budgetExhausted: false,
  ...o,
});

/** A position bought for 3 mUSD at launch, then the curve moved by `marketBuy` mUSD. */
function held(marketBuy: number, o: Partial<HeldPosition> = {}): HeldPosition {
  const buy = simulateBuy(P, launch, mUSD(3));
  let reserves = applyBuy(launch, buy);
  if (marketBuy > 0) reserves = applyBuy(reserves, simulateBuy(P, reserves, mUSD(marketBuy)));
  return {
    token: tokenAt(9),
    symbol: "HELD",
    openedAt: 1_000n,
    inventory: buy.amountOut,
    costBasis: mUSD(3),
    reserves,
    takeProfitDone: false,
    ...o,
  };
}

describe("parseStrategy", () => {
  it("accepts the DESIGN §7.3 example in base units and basis points", () => {
    expect(parseStrategy(EXAMPLE)).toEqual({
      entry: {
        amountPerToken: 3_000_000n,
        maxAgeSeconds: 60,
        keywords: [],
        excludeOwn: true,
        maxOpenPositions: 10,
        maxEntryPriceMultipleBps: 20_000n,
      },
      exit: { takeProfitBps: 5_000n, takeProfitSellBps: 5_000n, maxHoldSeconds: 1_800n },
      slippageBps: 300,
    });
  });

  it("defaults the optional fields; fractional minutes and a numeric amount are accepted", () => {
    const s = parseStrategy({
      entry: { amountPerToken: 0.5, maxAgeSeconds: 30 },
      exit: { takeProfitPercent: 25.5, takeProfitSellPercent: 100, maxHoldMinutes: 0.5 },
    });
    expect(s.entry).toMatchObject({
      amountPerToken: 500_000n,
      keywords: [],
      excludeOwn: true,
      maxOpenPositions: 10,
      maxEntryPriceMultipleBps: 20_000n,
    });
    expect(s.exit).toEqual({
      takeProfitBps: 2_550n,
      takeProfitSellBps: 10_000n,
      maxHoldSeconds: 30n,
    });
    expect(s.slippageBps).toBe(300);
  });

  it.each([
    ["stop-loss set", { exit: { stopLossPercent: 10 } }, /stopLossPercent is reserved/],
    ["stop-loss zero", { exit: { stopLossPercent: 0 } }, /stopLossPercent is reserved/],
    ["unknown field", { entry: { maxAge: 5 } }, /entry\.maxAge is not a strategy field/],
    ["zero amount", { entry: { amountPerToken: "0" } }, /amountPerToken/],
    ["too many decimals", { entry: { amountPerToken: "1.0000001" } }, /amountPerToken/],
    ["negative amount", { entry: { amountPerToken: "-1" } }, /amountPerToken/],
    ["no max age", { entry: { maxAgeSeconds: undefined } }, /maxAgeSeconds is required/],
    ["zero max age", { entry: { maxAgeSeconds: 0 } }, /maxAgeSeconds/],
    ["empty keyword", { entry: { keywords: [""] } }, /keywords/],
    ["keyword not a string", { entry: { keywords: [1] } }, /keywords/],
    ["fractional cap", { entry: { maxOpenPositions: 1.5 } }, /maxOpenPositions/],
    ["multiple below 1", { entry: { maxEntryPriceMultiple: 0.5 } }, /maxEntryPriceMultiple/],
    ["sell over 100%", { exit: { takeProfitSellPercent: 101 } }, /takeProfitSellPercent/],
    ["zero take-profit", { exit: { takeProfitPercent: 0 } }, /takeProfitPercent/],
    ["zero max hold", { exit: { maxHoldMinutes: 0 } }, /maxHoldMinutes/],
    ["string number", { exit: { maxHoldMinutes: "30" } }, /maxHoldMinutes/],
  ])("refuses %s", (_, patch, message) => {
    expect(() => strategy(patch)).toThrow(StrategyError);
    expect(() => strategy(patch)).toThrow(message);
  });

  it("refuses a non-object and an unknown top-level field", () => {
    expect(() => parseStrategy([])).toThrow(/strategy must be an object/);
    expect(() => parseStrategy({ ...EXAMPLE, mode: "x" })).toThrow(/strategy\.mode/);
    expect(() => parseStrategy({ ...EXAMPLE, slippagePercent: 101 })).toThrow(/slippagePercent/);
  });
});

describe("keywords", () => {
  it.each([
    ["empty = every token", [], "Anything", "ANY", true],
    ["name substring", ["moon"], "To the moon", "TTM", true],
    ["symbol substring", ["dog"], "Shiba", "DOGE2", true],
    ["case-insensitive", ["MoOn"], "MOONSHOT", "MS", true],
    ["several: any matches", ["cat", "pepe"], "Pepe classic", "PEPEC", true],
    ["none matches", ["cat", "frog"], "Moon dog", "MDOG", false],
  ] as const)("%s", (_, keywords, name, symbol, expected) => {
    expect(matchesKeywords(keywords, name, symbol)).toBe(expected);
    const s = strategy({ entry: { keywords } });
    const [action] = decide(input({ strategy: s, observed: [observed({ name, symbol })] }));
    expect(action?.type).toBe(expected ? "buy" : "skip");
  });

  it("is locale-independent (dotted capital I)", () => {
    expect(matchesKeywords(["istanbul"], "ISTANBUL coin", "IST")).toBe(true);
  });
});

describe("entry", () => {
  it("buys a fresh token for amountPerToken with its observed age", () => {
    expect(decide(input({ observed: [observed()] }))).toEqual([
      { type: "buy", token: tokenAt(1), symbol: "SOME", amountIn: mUSD(3), ageSeconds: 10n },
    ]);
  });

  it.each([
    ["older than maxAgeSeconds when observed", { observedAt: 1_061n }, "too_old"],
    ["the account's own token", { creator: ME }, "own"],
    ["a curve that no longer trades", { trading: false }, "not_trading"],
  ] as const)("skips %s", (_, o, reason) => {
    expect(decide(input({ observed: [observed(o)] }))).toEqual([
      { type: "skip", token: tokenAt(1), symbol: "SOME", reason },
    ]);
  });

  it("observed exactly at maxAgeSeconds is still in; own tokens pass with excludeOwn false", () => {
    expect(decide(input({ observed: [observed({ observedAt: 1_060n })] }))[0]?.type).toBe("buy");
    const s = strategy({ entry: { excludeOwn: false } });
    expect(decide(input({ strategy: s, observed: [observed({ creator: ME })] }))[0]?.type).toBe(
      "buy",
    );
  });

  it("entry guard: skips a spot price above maxEntryPriceMultiple × the launch price", () => {
    const at = (r: ReturnType<typeof initialReserves>) => observed({ priceE18: priceE18(r) });
    // ≈ 1.2× and ≈ 2.3× the launch price.
    const mild = applyBuy(launch, simulateBuy(P, launch, mUSD(20)));
    const pumped = applyBuy(launch, simulateBuy(P, launch, mUSD(105)));
    expect(priceE18(pumped) * 10n).toBeGreaterThan(priceE18(launch) * 20n);
    expect(decide(input({ observed: [at(mild)] }))[0]?.type).toBe("buy");
    expect(decide(input({ observed: [at(pumped)] }))[0]).toMatchObject({
      type: "skip",
      reason: "entry_price",
    });
    const loose = strategy({ entry: { maxEntryPriceMultiple: 3 } });
    expect(decide(input({ strategy: loose, observed: [at(pumped)] }))[0]?.type).toBe("buy");
  });

  it("respects maxOpenPositions, counting the buys of this decision", () => {
    const s = strategy({ entry: { maxOpenPositions: 2 } });
    const actions = decide(
      input({
        strategy: s,
        openPositions: 1,
        observed: [observed({ token: tokenAt(1) }), observed({ token: tokenAt(2) })],
      }),
    );
    expect(actions.map((a) => (a.type === "skip" ? a.reason : a.type))).toEqual([
      "buy",
      "max_positions",
    ]);
  });

  it("budget: the first shortfall (limit or balance) is one budget_exhausted, then no entries", () => {
    const three = [1, 2, 3].map((n) => observed({ token: tokenAt(n) }));
    const limit = decide(
      input({ observed: three, budget: { remainingLimit: mUSD(5), balance: mUSD(100) } }),
    );
    expect(limit).toEqual([
      expect.objectContaining({ type: "buy", token: tokenAt(1) }),
      { type: "budget_exhausted", needed: mUSD(3), remainingLimit: mUSD(2), balance: mUSD(97) },
    ]);
    const poor = decide(
      input({ observed: three, budget: { remainingLimit: mUSD(100), balance: mUSD(1) } }),
    );
    expect(poor.map((a) => a.type)).toEqual(["budget_exhausted"]);
    expect(decide(input({ observed: three, budgetExhausted: true }))).toEqual([]);
  });
});

describe("exit", () => {
  it("take-profit sells takeProfitSellPercent once the portion's net value beats its cost by takeProfitPercent", () => {
    const p = held(60);
    const [action] = decide(input({ positions: [p] }));
    const amount = p.inventory / 2n;
    expect(action).toEqual({
      type: "sell",
      token: p.token,
      symbol: "HELD",
      amount,
      reason: "take_profit",
      expectedOut: simulateSell(P, p.reserves as NonNullable<HeldPosition["reserves"]>, amount)
        .amountOut,
      costBasis: mUSD(3) / 2n,
    });
    if (action?.type !== "sell") throw new Error("no sell");
    expect(action.expectedOut * 100n).toBeGreaterThanOrEqual(action.costBasis * 150n);
  });

  it("no take-profit below the threshold, and only once per position", () => {
    expect(decide(input({ positions: [held(5)] }))).toEqual([]);
    expect(decide(input({ positions: [held(60, { takeProfitDone: true })] }))).toEqual([]);
  });

  it("the take-profit threshold is net of fees: the fee alone keeps a flat curve below it", () => {
    const s = strategy({ exit: { takeProfitPercent: 0.01 } });
    expect(decide(input({ strategy: s, positions: [held(0)] }))).toEqual([]);
  });

  it("max hold sells the whole remaining inventory, even after take-profit", () => {
    const p = held(0, { takeProfitDone: true });
    expect(decide(input({ now: 1_000n + 1_799n, positions: [p] }))).toEqual([]);
    expect(decide(input({ now: 1_000n + 1_800n, positions: [p] }))).toEqual([
      expect.objectContaining({ type: "sell", amount: p.inventory, reason: "max_hold" }),
    ]);
  });

  it("a position with unknown cost basis is not managed", () => {
    expect(decide(input({ now: 99_999n, positions: [held(60, { costBasis: null })] }))).toEqual([
      { type: "skip", token: tokenAt(9), symbol: "HELD", reason: "unknown_cost_basis" },
    ]);
  });

  it("a curve that no longer trades is curve_completed; an empty inventory needs nothing", () => {
    expect(decide(input({ positions: [held(0, { reserves: null })] }))).toEqual([
      { type: "curve_completed", token: tokenAt(9), symbol: "HELD" },
    ]);
    expect(decide(input({ now: 99_999n, positions: [held(60, { inventory: 0n })] }))).toEqual([]);
  });
});
