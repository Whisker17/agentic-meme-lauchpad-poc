import { loadDeployments as loadAaDeployments } from "@0xwh1sker/mantle-aa-sdk";
import { type Address, decodeFunctionData, erc20Abi, toFunctionSelector, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  approveCall,
  buyCall,
  claimCall,
  createTokenCall,
  DESIGN_CURVE_PARAMS,
  defaultDeadline,
  initialReserves,
  loadDeployments,
  memeLaunchpadAbi,
  minOutFor,
  planBuy,
  randomSalt,
  sellCall,
  simulateBuy,
  VERSION,
} from "../src/index.js";

const launchpad: Address = "0x1111111111111111111111111111111111111111";
const usd: Address = "0x2222222222222222222222222222222222222222";
const token: Address = "0x3333333333333333333333333333333333333333";
const account: Address = "0x4444444444444444444444444444444444444444";
const mUSD = 10n ** 6n;

const decodeBuy = (data: `0x${string}`) => decodeFunctionData({ abi: memeLaunchpadAbi, data });
const decodeApprove = (data: `0x${string}`) => decodeFunctionData({ abi: erc20Abi, data });

describe("planBuy clamp (completing buy)", () => {
  // A fresh curve fills with ~606 mUSD gross; the agent asks for 1000 mUSD.
  const request = 1000n * mUSD;
  const quote = simulateBuy(DESIGN_CURVE_PARAMS, initialReserves(DESIGN_CURVE_PARAMS), request);

  it("uses amountInUsed for the approve, the BUY amountIn and the budget", () => {
    expect(quote.completes).toBe(true);
    expect(quote.amountInUsed).toBeLessThan(request);
    // The session's remaining limit lies between what the buy uses and what was requested.
    const remainingLimit = (quote.amountInUsed + request) / 2n;

    const plan = planBuy({
      launchpad,
      quoteToken: usd,
      token,
      recipient: account,
      amountIn: request,
      quote,
    });

    expect(plan.amountIn).toBe(quote.amountInUsed);
    expect(plan.amountIn <= remainingLimit).toBe(true);
    const [approve, buy] = plan.calls;
    expect(approve.to).toBe(usd);
    expect(decodeApprove(approve.data)).toEqual({
      functionName: "approve",
      args: [launchpad, quote.amountInUsed],
    });
    expect(buy.to).toBe(launchpad);
    const decoded = decodeBuy(buy.data);
    expect(decoded.functionName).toBe("buy");
    expect(decoded.args?.[1]).toBe(quote.amountInUsed);
    expect(decoded.args?.[2]).toBe(plan.minOut);
  });

  it("keeps the request when the buy does not complete", () => {
    const small = 10n * mUSD;
    const q = simulateBuy(DESIGN_CURVE_PARAMS, initialReserves(DESIGN_CURVE_PARAMS), small);
    const plan = planBuy({
      launchpad,
      quoteToken: usd,
      token,
      recipient: account,
      amountIn: small,
      quote: q,
    });
    expect(q.completes).toBe(false);
    expect(plan.amountIn).toBe(small);
    expect(decodeApprove(plan.calls[0].data).args[1]).toBe(small);
    expect(decodeBuy(plan.calls[1].data).args?.[1]).toBe(small);
  });
});

describe("minOutFor", () => {
  it("applies the default 5% and custom slippage, rounding down", () => {
    expect(minOutFor(1000n)).toBe(950n);
    expect(minOutFor(1000n, 300)).toBe(970n);
    expect(minOutFor(999n, 1)).toBe(998n);
    expect(minOutFor(1000n, 0)).toBe(1000n);
    expect(minOutFor(1000n, 10_000)).toBe(0n);
  });

  it("rejects slippage outside [0, 10000] bps", () => {
    for (const bad of [-1, 10_001, 1.5, Number.NaN])
      expect(() => minOutFor(1n, bad)).toThrow(RangeError);
  });
});

describe("builders", () => {
  it("encode the launchpad selectors of the policy (DESIGN §4.3, §6.2)", () => {
    const trade = { token, amount: 5n, minOut: 4n, deadline: 7n, recipient: account };
    expect(buyCall(launchpad, trade).data.slice(0, 10)).toBe("0x9f01c7de");
    expect(sellCall(launchpad, trade).data.slice(0, 10)).toBe("0x1d87be21");
    expect(claimCall(launchpad, token).data.slice(0, 10)).toBe(
      toFunctionSelector("claimCreatorFees(address)"),
    );
    const create = createTokenCall(launchpad, { name: "N", symbol: "S", salt: randomSalt() });
    expect(create.data.slice(0, 10)).toBe(
      toFunctionSelector("createToken(string,string,string,string,bytes32)"),
    );
    expect(decodeBuy(create.data).args?.slice(2, 4)).toEqual(["", ""]);
    expect(approveCall(usd, launchpad, 1n)).toEqual({
      to: usd,
      value: 0n,
      data:
        "0x095ea7b30000000000000000000000001111111111111111111111111111111111111111" +
        "0000000000000000000000000000000000000000000000000000000000000001",
    });
  });

  it("defaultDeadline is now + 300 s", () => {
    expect(defaultDeadline(1_700_000_000_999)).toBe(1_700_000_300n);
  });

  it("randomSalt draws 32 fresh bytes", () => {
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });
});

describe("loadDeployments", () => {
  const aa = loadAaDeployments();

  const deployed = "0xB7E6E09Bc2dF2b078A9171abA68663f13E2bc985";

  it("merges the shipped book with the AA SDK's", () => {
    expect(loadDeployments()).toEqual({ ...aa, memeLaunchpad: deployed });
  });

  it("an empty address means not deployed yet", () => {
    const book = loadDeployments({ meme: { chainId: aa.chainId, MemeLaunchpad: { address: "" } } });
    expect(book).toEqual({ ...aa, memeLaunchpad: null });
  });

  it("checksums a deployed launchpad address", () => {
    const book = loadDeployments({
      meme: { chainId: aa.chainId, MemeLaunchpad: { address: launchpad.replace(/1/g, "a") } },
    });
    expect(book.memeLaunchpad).toBe("0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa");
  });

  it("rejects an invalid address and a chain mismatch", () => {
    expect(() =>
      loadDeployments({ meme: { chainId: aa.chainId, MemeLaunchpad: { address: "0x12" } } }),
    ).toThrow(/MemeLaunchpad/);
    expect(() =>
      loadDeployments({ meme: { chainId: 1, MemeLaunchpad: { address: zeroAddress } } }),
    ).toThrow(/chainId/);
  });

  it("reads a record from a path", () => {
    const file = new URL("../../../deployments/mantle-sepolia.json", import.meta.url);
    expect(loadDeployments({ meme: file }).memeLaunchpad).toBe(deployed);
  });
});

it("exports its version", () => {
  expect(VERSION).toBe("0.1.3");
});
