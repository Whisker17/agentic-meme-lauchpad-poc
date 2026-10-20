import {
  applyBuy,
  initialReserves,
  DESIGN_CURVE_PARAMS as P,
  priceE18,
  type Reserves,
  simulateBuy,
} from "@0xwh1sker/mantle-meme-sdk";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { mUSD, planPump, rng } from "../src/sim.js";

const after = (r: Reserves, amountIn: bigint) => {
  const q = simulateBuy(P, r, amountIn);
  return { q, price: priceE18(applyBuy(r, q)) };
};

/** Reserves after a sequence of buys from launch. */
const bought = (...amounts: bigint[]) =>
  amounts.reduce((r, a) => applyBuy(r, simulateBuy(P, r, a)), initialReserves(P));

describe("planPump", () => {
  const states: [string, Reserves][] = [
    ["launch", initialReserves(P)],
    ["after 3 mUSD", bought(3n * mUSD)],
    ["after 150 mUSD", bought(100n * mUSD, 50n * mUSD)],
    ["after 300 mUSD", bought(300n * mUSD)],
  ];
  for (const [label, r] of states) {
    for (const percent of [50, 100]) {
      it(`+${percent}% at ${label}: reaches the target with ≤ 1% overspend`, () => {
        const plan = planPump(P, r, percent);
        const target = (priceE18(r) * BigInt(100 + percent)) / 100n;
        expect(plan.completes).toBe(false);
        expect(plan.priceBefore).toBe(priceE18(r));
        expect(after(r, plan.amountIn).price).toBe(plan.priceAfter);
        expect(plan.priceAfter).toBeGreaterThanOrEqual(target);
        // 1% less would not reach it: the amount is computed, not padded.
        expect(after(r, (plan.amountIn * 99n) / 100n).price).toBeLessThan(target);
      });
    }
  }

  it("from launch, +50% costs ≈ 45.4 mUSD and +100% ≈ 83.7 mUSD (price ∝ vQ², DESIGN §4.2)", () => {
    const r = initialReserves(P);
    // vQ' = 200·sqrt(m) → net 44.95 / 82.84 mUSD, gross = net / 0.99.
    const p50 = Number(planPump(P, r, 50).amountIn) / 1e6;
    const p100 = Number(planPump(P, r, 100).amountIn) / 1e6;
    expect(p50).toBeGreaterThan(45.3);
    expect(p50).toBeLessThan(45.5);
    expect(p100).toBeGreaterThan(83.6);
    expect(p100).toBeLessThan(83.8);
  });

  it("a target beyond the curve end is capped at the completing amount (never overpays)", () => {
    const r = bought(500n * mUSD); // vQ ≈ 695 mUSD; doubling needs vQ ≈ 983 > 800
    const plan = planPump(P, r, 100);
    const completing = simulateBuy(P, r, 10_000n * mUSD);
    expect(completing.completes).toBe(true);
    expect(plan.completes).toBe(true);
    expect(plan.amountIn).toBe(completing.amountInUsed);
    expect(simulateBuy(P, r, plan.amountIn)).toEqual(completing);
  });

  it("fuzz: the plan always reaches the target or completes the curve", () => {
    const random = rng(7);
    for (let i = 0; i < 200; i++) {
      const r = bought(BigInt(Math.floor(random() * 590)) * mUSD + 1n * mUSD);
      const percent = 1 + Math.floor(random() * 300);
      const plan = planPump(P, r, percent);
      const { q, price } = after(r, plan.amountIn);
      expect(q.completes).toBe(plan.completes);
      if (!plan.completes) {
        expect(price).toBeGreaterThanOrEqual((priceE18(r) * BigInt(100 + percent)) / 100n);
      }
    }
  });

  it("rejects a non-positive percent", () => {
    expect(() => planPump(P, initialReserves(P), 0)).toThrow(RangeError);
    expect(() => planPump(P, initialReserves(P), -5)).toThrow(RangeError);
  });
});

describe("market-sim CLI", () => {
  const MNEMONIC = "test test test test test test test test test test test junk";

  const capture = async (argv: string[], env: NodeJS.ProcessEnv) => {
    let out = "";
    let err = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out += s;
      return true;
    });
    const e = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      err += s;
      return true;
    });
    try {
      return { code: await main(argv, env), out, err };
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
  };

  it("addresses: derives --wallets EOAs from the mnemonic and prints addresses only", async () => {
    const { code, out } = await capture(["addresses", "--wallets", "2"], {
      MARKET_SIM_MNEMONIC: MNEMONIC,
    });
    expect(code).toBe(0);
    expect(
      out
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { wallet: 0, address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" },
      { wallet: 1, address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" },
    ]);
    expect(out).not.toMatch(/test test|0x[0-9a-f]{64}/);
  });

  it("usage errors exit 2: no mnemonic, no RPC, bad flags", async () => {
    expect((await capture(["addresses"], {})).code).toBe(2);
    expect((await capture(["run"], { MARKET_SIM_MNEMONIC: MNEMONIC })).code).toBe(2);
    expect(
      (await capture(["addresses", "--wallets", "x"], { MARKET_SIM_MNEMONIC: MNEMONIC })).code,
    ).toBe(2);
    expect(
      (
        await capture(["nope"], {
          MARKET_SIM_MNEMONIC: MNEMONIC,
          MARKET_SIM_RPC_URL: "http://127.0.0.1:1",
        })
      ).code,
    ).toBe(2);
  });
});
