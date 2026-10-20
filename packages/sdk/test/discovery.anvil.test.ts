// Discovery, symbol resolution, the revert mapping and the failure diagnosis against the launchpad
// deployed on plain anvil from a fresh forge build.
import { type Call, ExecutionRevertedError } from "@0xwh1sker/mantle-aa-sdk";
import {
  type Abi,
  type Address,
  encodeErrorResult,
  encodeFunctionData,
  type Hex,
  maxUint256,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buyCall,
  CurveCompletedError,
  createTokenCall,
  curveState,
  DESIGN_CURVE_PARAMS,
  diagnoseFailure,
  InsufficientBalanceError,
  type LaunchpadEvent,
  listTokens,
  memeLaunchpadAbi,
  predictTokenAddress,
  quoteBuy,
  randomSalt,
  resolveToken,
  scanTokens,
  sellCall,
  tokenCount,
  toMemeError,
  UnknownTokenError,
  watch,
} from "../src/index.js";
import { forgeBuild, keys, startAnvil, type TestWallet, walletClient } from "./helpers.js";

const artifact = forgeBuild();
const mUSD = (n: number) => BigInt(n) * 10n ** 6n;

let anvil: Awaited<ReturnType<typeof startAnvil>>;
let user: TestWallet;
let launchpad: Address;
let usd: Address;
/** symbol → address, in creation order. */
const created: [string, Address][] = [];

const encode = (abi: Abi, functionName: string, args: unknown[]): Hex =>
  encodeFunctionData({ abi, functionName, args });

async function send(call: { to: Address; data: Hex }) {
  const receipt = await user.waitForTransactionReceipt({ hash: await user.sendTransaction(call) });
  expect(receipt.status).toBe("success");
  return receipt;
}

async function deploy(name: string, args: unknown[]) {
  const { abi, bytecode } = artifact(name);
  const hash = await user.deployContract({ abi, bytecode: bytecode.object, args });
  return (await user.waitForTransactionReceipt({ hash })).contractAddress as Address;
}

async function createToken(name: string, symbol: string) {
  const receipt = await send(createTokenCall(launchpad, { name, symbol, salt: randomSalt() }));
  const [log] = parseEventLogs({
    abi: memeLaunchpadAbi,
    eventName: "TokenCreated",
    logs: receipt.logs,
  });
  const token = (log as NonNullable<typeof log>).args.token;
  created.push([symbol, token]);
  return token;
}

const trade = async (side: "buy" | "sell", token: Address, amount: bigint) =>
  send(
    (side === "buy" ? buyCall : sellCall)(launchpad, {
      token,
      amount,
      minOut: 0n,
      deadline: maxUint256,
      recipient: user.account.address,
    }),
  );

beforeAll(async () => {
  anvil = await startAnvil();
  user = walletClient(anvil.url, keys[0]);
  usd = await deploy("MockUSD", []);
  launchpad = await deploy("MemeLaunchpad", [usd, user.account.address, DESIGN_CURVE_PARAMS]);
  const erc20 = artifact("MockUSD").abi;
  await send({ to: usd, data: encode(erc20, "mint", [user.account.address, mUSD(10_000)]) });
  await send({ to: usd, data: encode(erc20, "approve", [launchpad, maxUint256]) });
  await createToken("Pepe", "PEPE");
  await createToken("Doge", "DOGE");
  await createToken("Doge two", "doge");
  await createToken("Pepe classic", "PEPECLASSIC");
  await createToken("Wif", "WIF");
}, 120_000);

afterAll(() => anvil?.stop());

describe("discovery on anvil", { timeout: 60_000 }, () => {
  it("listTokens pages the registry in creation order with name, symbol and curve", async () => {
    expect(await tokenCount(user, launchpad)).toBe(5n);
    const page = await listTokens(user, launchpad, { offset: 1n, limit: 2n });
    expect(page.map((t) => [t.symbol, t.address])).toEqual(created.slice(1, 3));
    expect(page[0]).toMatchObject({
      name: "Doge",
      status: "trading",
      sold: 0n,
      realQuote: 0n,
      creator: user.account.address,
    });
    expect(await listTokens(user, launchpad, { offset: 10n })).toEqual([]);
    expect((await listTokens(user, launchpad)).length).toBe(5);
  });

  it("curveState names the status; an unregistered token is UnknownTokenError", async () => {
    const [, wif] = created[4] as [string, Address];
    await trade("buy", wif, mUSD(10));
    const s = await curveState(user, launchpad, wif);
    expect(s.status).toBe("trading");
    expect(s.sold).toBeGreaterThan(0n);
    await expect(curveState(user, launchpad, usd)).rejects.toBeInstanceOf(UnknownTokenError);
  });

  it("scanTokens reads only the newest maxScan entries", async () => {
    expect(await scanTokens(user, launchpad, 2n)).toEqual(created.slice(3, 5).map(([, a]) => a));
    expect(await scanTokens(user, launchpad)).toEqual(created.slice(0, 5).map(([, a]) => a));
  });

  it("resolves an exact symbol case-insensitively, and a registered address", async () => {
    expect(await resolveToken(user, launchpad, "pepe")).toBe(created[0]?.[1]);
    expect(await resolveToken(user, launchpad, "Wif")).toBe(created[4]?.[1]);
    const addr = created[1]?.[1] as Address;
    expect(await resolveToken(user, launchpad, addr.toLowerCase())).toBe(addr);
  });

  it("an ambiguous symbol lists the matches; a miss lists near matches; both are UnknownTokenError", async () => {
    const ambiguous = await resolveToken(user, launchpad, "DOGE").catch((e: unknown) => e);
    expect(ambiguous).toBeInstanceOf(UnknownTokenError);
    expect((ambiguous as UnknownTokenError).message).toMatch(/ambiguous/);
    expect((ambiguous as UnknownTokenError).candidates).toEqual([
      { address: created[1]?.[1], name: "Doge", symbol: "DOGE" },
      { address: created[2]?.[1], name: "Doge two", symbol: "doge" },
    ]);

    const miss = (await resolveToken(user, launchpad, "PEP").catch(
      (e: unknown) => e,
    )) as UnknownTokenError;
    expect(miss).toBeInstanceOf(UnknownTokenError);
    expect(miss.candidates.map((c) => c.symbol)).toEqual(["PEPE", "PEPECLASSIC"]);

    const none = (await resolveToken(user, launchpad, "NOPE").catch(
      (e: unknown) => e,
    )) as UnknownTokenError;
    expect(none.candidates).toEqual([]);

    await expect(resolveToken(user, launchpad, usd)).rejects.toBeInstanceOf(UnknownTokenError);
    await expect(resolveToken(user, launchpad, zeroAddress)).rejects.toBeInstanceOf(
      UnknownTokenError,
    );
  });

  it("at most 10 candidates", async () => {
    for (let i = 0; i < 11; i++) await createToken(`Cat ${i}`, "CAT");
    const e = (await resolveToken(user, launchpad, "cat").catch(
      (x: unknown) => x,
    )) as UnknownTokenError;
    expect(e.candidates).toHaveLength(10);
  });

  it("watch reports TokenCreated, Trade and CurveCompleted from fromBlock on, once each", async () => {
    const from = (await user.getBlockNumber()) + 1n;
    const stop = new AbortController();
    const seen: LaunchpadEvent[] = [];
    const done = (async () => {
      for await (const e of watch(user, launchpad, {
        fromBlock: from,
        pollIntervalMs: 50,
        signal: stop.signal,
      })) {
        seen.push(e);
      }
    })();
    const token = await createToken("Watch", "WATCH");
    await trade("buy", token, mUSD(5));
    await trade("sell", token, 10n ** 24n);
    await trade("buy", token, mUSD(1000)); // completes the curve (≈600 mUSD fills it)
    for (const until = Date.now() + 10_000; seen.length < 5 && Date.now() < until; ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300)); // a few more polls: nothing is reported twice
    stop.abort();
    await done;
    expect(seen.map((e) => e.eventName)).toEqual([
      "TokenCreated",
      "Trade",
      "Trade",
      "Trade",
      "CurveCompleted",
    ]);
    expect(seen[0]?.args).toMatchObject({ token, symbol: "WATCH" });
    expect(seen.map((e) => (e.eventName === "Trade" ? e.args.isBuy : null))).toEqual([
      null,
      true,
      false,
      true,
      null,
    ]);

    // A completed curve: the view's revert maps to CurveCompletedError, as an unknown token's does.
    expect((await curveState(user, launchpad, token)).status).toBe("completed");
    const completed = await quoteBuy(user, launchpad, token, mUSD(1)).catch(toMemeError);
    expect(completed).toBeInstanceOf(CurveCompletedError);
    const unknown = await quoteBuy(user, launchpad, usd, mUSD(1)).catch(toMemeError);
    expect(unknown).toBeInstanceOf(UnknownTokenError);
  });
});

describe("diagnoseFailure on anvil", { timeout: 60_000 }, () => {
  /** An account holding no MockUSD and no tokens. */
  const poor = privateKeyToAddress(keys[1]);
  const opaque = () => new ExecutionRevertedError({ data: "0x3204506f" });
  const order = { minOut: 0n, deadline: maxUint256, recipient: poor };
  const buy = (token: Address, amount: bigint, minOut = 0n) =>
    buyCall(launchpad, { ...order, token, amount, minOut });
  const diagnose = (calls: Call[], error = opaque()) =>
    diagnoseFailure(user, launchpad, poor, calls, error);

  it("an opaque failure on a completed curve is CurveCompletedError, though the balance is short too", async () => {
    const done = await createToken("Done", "DONE");
    await trade("buy", done, mUSD(1000));
    expect(await diagnose([buy(done, mUSD(1))])).toBeInstanceOf(CurveCompletedError);
    expect(
      await diagnose([sellCall(launchpad, { ...order, token: done, amount: 1n })]),
    ).toBeInstanceOf(CurveCompletedError);
  });

  it("an opaque failure on an unknown token is UnknownTokenError, though the balance is short too; a token the batch creates is checked for balance", async () => {
    expect(await diagnose([buy(usd, mUSD(1))])).toBeInstanceOf(UnknownTokenError);
    // A buy of the token the same batch creates has no quote yet: balance only.
    const salt = randomSalt();
    const predicted = predictTokenAddress(launchpad, poor, salt, "New", "NEW");
    const create = createTokenCall(launchpad, { name: "New", symbol: "NEW", salt });
    expect(await diagnose([create, buy(predicted, mUSD(1))])).toBeInstanceOf(
      InsufficientBalanceError,
    );
  });

  it("explicit revert data is kept; only an opaque failure is diagnosed from the balance", async () => {
    const [, pepe] = created[0] as [string, Address];
    const expired = new ExecutionRevertedError({
      data: encodeErrorResult({ abi: memeLaunchpadAbi, errorName: "Expired" }),
    });
    expect(await diagnose([buy(pepe, mUSD(1))], expired)).toBe(expired);
    expect(await diagnose([buy(pepe, mUSD(1))])).toBeInstanceOf(InsufficientBalanceError);
  });

  it("a buy that completes the curve needs only the quote's amountInUsed", async () => {
    const near = await createToken("Near", "NEAR");
    await trade("buy", near, mUSD(550));
    const q = await quoteBuy(user, launchpad, near, mUSD(100));
    expect(q.completes).toBe(true);
    const fund = (amount: bigint) =>
      send({ to: usd, data: encode(artifact("MockUSD").abi, "transfer", [poor, amount]) });
    await fund(q.amountInUsed - 1n);
    const short = await diagnose([buy(near, mUSD(100), q.amountOut)]);
    expect(short).toBeInstanceOf(InsufficientBalanceError);
    expect(short).toMatchObject({ balance: q.amountInUsed - 1n, needed: q.amountInUsed });
    await fund(1n);
    const error = opaque();
    expect(await diagnose([buy(near, mUSD(100), q.amountOut)], error)).toBe(error);
  });
});
