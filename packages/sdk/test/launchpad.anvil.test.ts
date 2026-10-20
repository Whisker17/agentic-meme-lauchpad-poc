import { readFileSync } from "node:fs";
import {
  type Abi,
  type Address,
  encodeFunctionData,
  type Hex,
  maxUint256,
  parseEventLogs,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEME_MANTLE_SEPOLIA } from "../src/generated.js";
import {
  applyBuy,
  applySell,
  type BuyQuote,
  CurveModelError,
  createTokenCall,
  DESIGN_CURVE_PARAMS,
  initialReserves,
  memeLaunchpadAbi,
  memeTokenAbi,
  memeTokenCreationCode,
  planBuy,
  predictTokenAddress,
  priceE18,
  quoteBuy,
  quoteSell,
  type Reserves,
  randomSalt,
  readCurveParams,
  type SellQuote,
  simulateBuy,
  simulateSell,
} from "../src/index.js";
import {
  forgeBuild,
  keys,
  revertName,
  startAnvil,
  type TestWallet,
  walletClient,
} from "./helpers.js";

// One fresh `forge build` (the build a deployment uses) for both suites: the committed artifacts
// must equal it, and the launchpad deployed from it must agree with the SDK's offline primitives.
const artifact = forgeBuild();

// src/generated.ts must match what `forge build` produces now; regenerate with
// `pnpm --filter @0xwh1sker/mantle-meme-sdk generate` after any contract or address-book change.
describe("generated artifacts", () => {
  it("ABIs equal the forge build", () => {
    expect(memeLaunchpadAbi).toEqual(artifact("MemeLaunchpad").abi);
    expect(memeTokenAbi).toEqual(artifact("MemeToken").abi);
  });

  it("MemeToken creation code (incl. metadata) equals the forge build", () => {
    expect(memeTokenCreationCode).toBe(artifact("MemeToken").bytecode.object);
  });

  it("the shipped address book equals deployments/mantle-sepolia.json", () => {
    const file = new URL("../../../deployments/mantle-sepolia.json", import.meta.url);
    expect(MEME_MANTLE_SEPOLIA).toEqual(JSON.parse(readFileSync(file, "utf8")));
  });
});

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let users: TestWallet[];
let launchpad: Address;
let usd: Address;

async function deploy(client: TestWallet, name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await client.deployContract({ abi, bytecode: bytecode.object, args });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error(`${name} not deployed`);
  return receipt.contractAddress;
}

async function send(client: TestWallet, call: { to: Address; data: Hex }) {
  const hash = await client.sendTransaction(call);
  const receipt = await client.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
  return receipt;
}

async function createToken(client: TestWallet, name: string, symbol: string, salt: Hex) {
  const receipt = await send(client, createTokenCall(launchpad, { name, symbol, salt }));
  const [created] = parseEventLogs({
    abi: memeLaunchpadAbi,
    eventName: "TokenCreated",
    logs: receipt.logs,
  });
  if (!created) throw new Error("no TokenCreated");
  return created.args.token;
}

const erc20 = artifact("MockUSD").abi;

beforeAll(async () => {
  anvil = await startAnvil();
  users = keys.map((k) => walletClient(anvil.url, k));
  const [owner] = users as [TestWallet];
  usd = await deploy(owner, "MockUSD", []);
  launchpad = await deploy(owner, "MemeLaunchpad", [
    usd,
    owner.account.address,
    DESIGN_CURVE_PARAMS,
  ]);
  for (const u of users) {
    await send(owner, {
      to: usd,
      data: encode(erc20, "mint", [u.account.address, 1_000_000n * 10n ** 6n]),
    });
    await send(u, { to: usd, data: encode(erc20, "approve", [launchpad, maxUint256]) });
  }
}, 60_000);

afterAll(() => anvil?.stop());

function encode(abi: Abi, functionName: string, args: unknown[]): Hex {
  return encodeFunctionData({ abi, functionName, args });
}

// Deterministic PRNG so a failure is reproducible from the printed seed.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const randBig = (r: () => number, max: bigint) =>
  (BigInt(Math.floor(r() * 2 ** 32)) * max) / 2n ** 32n;
const randText = (r: () => number) => {
  const alphabet = ["a", "Z", "9", " ", "_", "é", "🐸", "币"];
  return Array.from(
    { length: Math.floor(r() * 40) },
    () => alphabet[Math.floor(r() * alphabet.length)],
  ).join("");
};

describe("on anvil", { timeout: 120_000 }, () => {
  it("readCurveParams returns the deployed immutables", async () => {
    expect(await readCurveParams(users[0] as TestWallet, launchpad)).toEqual(DESIGN_CURVE_PARAMS);
  });

  it("predictTokenAddress equals the deployed address for random salts, names and creators", async () => {
    const r = rng(0xc2);
    for (let i = 0; i < 12; i++) {
      const user = users[i % users.length] as TestWallet;
      const salt = randomSalt();
      const name = randText(r);
      const symbol = randText(r);
      const predicted = predictTokenAddress(launchpad, user.account.address, salt, name, symbol);
      const onChainView = await user.readContract({
        address: launchpad,
        abi: memeLaunchpadAbi,
        functionName: "predictTokenAddress",
        args: [user.account.address, salt, name, symbol],
      });
      expect(predicted).toBe(onChainView);
      expect(await createToken(user, name, symbol, salt)).toBe(predicted);
    }
  });

  for (const seed of [1, 2, 3]) {
    it(`the local curve model equals the contract views over a fuzzed sequence (seed ${seed})`, async () => {
      const r = rng(seed);
      const trader = users[seed % users.length] as TestWallet;
      const token = await createToken(trader, `Fuzz ${seed}`, `F${seed}`, randomSalt());
      const balanceOf = async () =>
        trader.readContract({
          address: token,
          abi: erc20,
          functionName: "balanceOf",
          args: [trader.account.address],
        }) as Promise<bigint>;
      let reserves: Reserves = initialReserves(DESIGN_CURVE_PARAMS);
      let completed = false;

      for (let step = 0; step < 120 && !completed; step++) {
        const held = await balanceOf();
        const isBuy = held === 0n || r() < 0.6;
        // Mostly dust (ZeroOutput) and ordinary sizes; rarely a buy large enough to complete.
        const scale =
          r() < 0.04
            ? 700n * 10n ** 6n
            : ([10n, 10n ** 6n, 20n * 10n ** 6n][Math.floor(r() * 3)] as bigint);
        const amount = isBuy
          ? randBig(r, scale)
          : r() < 0.1
            ? randBig(r, 10n ** 9n)
            : randBig(r, held + 1n);
        let local: BuyQuote | SellQuote | string;
        try {
          local = isBuy
            ? simulateBuy(DESIGN_CURVE_PARAMS, reserves, amount)
            : simulateSell(DESIGN_CURVE_PARAMS, reserves, amount);
        } catch (err) {
          if (!(err instanceof CurveModelError)) throw err;
          local = err.errorName;
        }
        let view: BuyQuote | SellQuote | string;
        try {
          view = isBuy
            ? await quoteBuy(trader, launchpad, token, amount)
            : await quoteSell(trader, launchpad, token, amount);
        } catch (err) {
          view = revertName(err) ?? "unknown";
        }
        expect(local, `seed ${seed} step ${step} ${isBuy ? "buy" : "sell"} ${amount}`).toEqual(
          view,
        );
        if (typeof local === "string") continue;

        const fn = isBuy ? "buy" : "sell";
        await send(trader, {
          to: launchpad,
          data: encode(memeLaunchpadAbi as Abi, fn, [
            token,
            amount,
            local.amountOut,
            2n ** 40n,
            trader.account.address,
          ]),
        });
        reserves = isBuy
          ? applyBuy(reserves, local as BuyQuote)
          : applySell(reserves, amount, local as SellQuote);
        completed = isBuy && (local as BuyQuote).completes;

        const state = await trader.readContract({
          address: launchpad,
          abi: memeLaunchpadAbi,
          functionName: "curveState",
          args: [token],
        });
        expect([state.virtualToken, state.virtualQuote, state.priceE18, state.status]).toEqual([
          reserves.vT,
          reserves.vQ,
          priceE18(reserves),
          completed ? 2 : 1,
        ]);
      }

      if (!completed) {
        // Finish the curve so the completed path is always covered.
        const q = simulateBuy(DESIGN_CURVE_PARAMS, reserves, 10n ** 12n);
        expect(q).toEqual(await quoteBuy(trader, launchpad, token, 10n ** 12n));
        expect(q.completes).toBe(true);
        await send(trader, {
          to: launchpad,
          data: encode(memeLaunchpadAbi as Abi, "buy", [
            token,
            10n ** 12n,
            q.amountOut,
            2n ** 40n,
            trader.account.address,
          ]),
        });
        reserves = applyBuy(reserves, q);
      }
      expect(() => simulateBuy(DESIGN_CURVE_PARAMS, reserves, 1n)).toThrow(CurveModelError);
      await expect(quoteBuy(trader, launchpad, token, 1n).catch(revertName)).resolves.toBe(
        "CurveAlreadyCompleted",
      );
      await expect(quoteSell(trader, launchpad, token, 1n).catch(revertName)).resolves.toBe(
        "CurveAlreadyCompleted",
      );
    });
  }

  it("a clamped completing buy pulls exactly amountInUsed and leaves no allowance", async () => {
    const buyer = users[1] as TestWallet;
    const me = buyer.account.address;
    // Revoke the blanket approval so only the plan's approve is in force.
    await send(buyer, { to: usd, data: encode(erc20, "approve", [launchpad, 0n]) });
    const token = await createToken(buyer, "Clamp", "CLMP", randomSalt());
    const request = 1_000n * 10n ** 6n;
    const quote = await quoteBuy(buyer, launchpad, token, request);
    const plan = planBuy({
      launchpad,
      quoteToken: usd,
      token,
      recipient: me,
      amountIn: request,
      quote,
    });
    expect(plan.completes).toBe(true);

    const usdBalance = () =>
      buyer.readContract({
        address: usd,
        abi: erc20,
        functionName: "balanceOf",
        args: [me],
      }) as Promise<bigint>;
    const before = await usdBalance();
    for (const call of plan.calls) await send(buyer, call);
    expect(before - (await usdBalance())).toBe(quote.amountInUsed);
    expect(
      await buyer.readContract({
        address: usd,
        abi: erc20,
        functionName: "allowance",
        args: [me, launchpad],
      }),
    ).toBe(0n);
  });
});
