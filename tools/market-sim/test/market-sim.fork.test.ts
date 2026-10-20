// The market simulator against the deployed MemeLaunchpad on an anvil fork of Mantle Sepolia:
// plain EOAs (self-paid gas) create, buy, sell and pump; an oversized buy completes a curve
// through the contract's on-chain truncation.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { curveState, DESIGN_CURVE_PARAMS, priceE18 } from "@0xwh1sker/mantle-meme-sdk";
import { type Address, createPublicClient, erc20Abi, http, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mantleSepoliaTestnet } from "viem/chains";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFork } from "../../../e2e/launchpad/fork.js";
import { errorMessage, MarketSim, mUSD, type SimEvent } from "../src/sim.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const LAUNCH_PRICE = priceE18({
  vT: DESIGN_CURVE_PARAMS.virtualToken0,
  vQ: DESIGN_CURVE_PARAMS.virtualQuote0,
});

describe.skipIf(!rpcUrl)("market-sim on a Mantle Sepolia fork", { timeout: 120_000 }, () => {
  let stop: (() => void) | undefined;
  let forkUrl: string;
  let sim: MarketSim;
  let client: ReturnType<typeof createPublicClient>;
  const events: SimEvent[] = [];

  beforeAll(async () => {
    const fork = await startFork(rpcUrl as string);
    stop = fork.stop;
    forkUrl = fork.url;
    client = createPublicClient({ chain: mantleSepoliaTestnet, transport: http(fork.url) });
    const accounts = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
    for (const a of accounts) {
      await client.request({
        method: "anvil_setBalance" as never,
        params: [a.address, toHex(parseEther("1000"))] as never,
      });
    }
    sim = new MarketSim({
      rpcUrl: fork.url,
      accounts,
      seed: 42,
      pollingIntervalMs: 50,
      log: (e) => events.push(e),
    });
  }, 120_000);

  afterAll(() => stop?.());

  const state = (token: Address) => curveState(client, sim.launchpad, token);
  const usd = (who: Address) =>
    client.readContract({
      address: sim.quoteToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [who],
    });

  it("plain EOAs create and trade directly on the launchpad, minting their own MockUSD", async () => {
    const created = await sim.createToken({ wallet: 0 });
    expect((await state(created.token)).creator).toBe(sim.addresses[0]);
    const buy = await sim.buy(created.token, 5n * mUSD, { wallet: 1 });
    expect(buy).toMatchObject({ kind: "buy", quoteAmount: 5n * mUSD, completed: false });
    expect(events.some((e) => e.kind === "mint" && e.wallet === sim.addresses[1])).toBe(true);
    const sell = await sim.sell(created.token, buy.tokenAmount / 2n, { wallet: 1 });
    expect(sell.kind).toBe("sell");
    expect(sell.quoteAmount).toBeGreaterThan(0n);
  });

  for (const percent of [undefined, 50] as const) {
    it(`pump${percent ? ` --percent ${percent}` : ""} moves the spot price past +50%`, async () => {
      const { token } = await sim.createToken({ wallet: 0 });
      await sim.buy(token, 3n * mUSD, { wallet: 1 }); // an early entry, as the autopilot's
      const before = (await state(token)).priceE18;
      const pump = await sim.pump(token, { wallet: 2, ...(percent ? { percent } : {}) });
      const after = (await state(token)).priceE18;
      expect(pump.priceBefore).toBe(before);
      expect(pump.priceAfter).toBe(after);
      expect(pump.completed).toBe(false);
      // +50% vs the spot price right before the pump (and so vs the launch price too).
      expect(after * 2n).toBeGreaterThanOrEqual(before * 3n);
      expect(after * 2n).toBeGreaterThanOrEqual(LAUNCH_PRICE * 3n);
      if (!percent) expect(after).toBeGreaterThanOrEqual(before * 2n);
    });
  }

  it("an oversized buy completes the curve through on-chain truncation", async () => {
    const { token } = await sim.createToken({ wallet: 0 });
    await sim.buy(token, 100n * mUSD, { wallet: 1 });
    const who = sim.addresses[2] as Address;
    const usdBefore = await usd(who);
    const mark = events.length;
    const buy = await sim.buy(token, 1_000n * mUSD, { wallet: 2 });
    const minted = events
      .slice(mark)
      .reduce((sum, e) => (e.kind === "mint" ? sum + e.amount : sum), 0n);
    expect(buy.completed).toBe(true);
    // Truncated: well below the request, the rest of 606.06 mUSD gross after ≈101 mUSD.
    expect(buy.quoteAmount).toBeLessThan(1_000n * mUSD);
    expect(usdBefore + minted - (await usd(who))).toBe(buy.quoteAmount);
    const s = await state(token);
    expect(s.status).toBe("completed");
    expect(s.sold).toBe(DESIGN_CURVE_PARAMS.curveSupply);
    // Trading is over: the next buy fails with a readable reason.
    const next = await sim.buy(token, mUSD, { wallet: 1 }).catch((e: unknown) => e);
    expect(errorMessage(next)).toMatch(/^Curve completed/);
  });

  it("run: the schedule creates and trades with no errors, then stops on abort", async () => {
    const ac = new AbortController();
    const seen: SimEvent[] = [];
    const quiet = new MarketSim({
      rpcUrl: forkUrl,
      accounts: sim.wallets.map((w) => w.account),
      seed: 7,
      pollingIntervalMs: 50,
      log: (e) => {
        seen.push(e);
        if (seen.filter((x) => x.kind === "buy" || x.kind === "sell").length >= 4) ac.abort();
      },
    });
    const summary = await quiet.run({
      signal: ac.signal,
      createIntervalMs: [60_000, 60_000],
      tradeIntervalMs: [0, 10],
    });
    expect(summary.errors).toBe(0);
    expect(summary.creates).toBe(1);
    expect(summary.buys + summary.sells).toBeGreaterThanOrEqual(4);
    expect(seen.filter((e) => e.kind === "error")).toEqual([]);
  });
});
