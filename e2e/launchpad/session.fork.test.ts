// The launchpad under the real AA stack, on an anvil fork of Mantle Sepolia: the deployed
// CaliburEntry v1.1.0 + AgentPolicyHook, a session granted with the `policy init` policy, and the
// sponsor service (`sponsor_relay` → on-chain checks → `eth_estimateGas` → relayer submission).
// Covers create + dev buy in one batch (sponsor path and direct), buy, sell, claim under NONE, the
// clamped completing buy, on-chain truncation in a race, and every refusal three times: by the
// SDK's pre-check, by the sponsor given the request without it, and on chain (a funded third
// party sends the session-signed batch straight to the account).
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
// FORK_TRACE_DIR=<dir> writes the call traces of the create + dev-buy transactions there.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  agentPolicyHookAbi,
  type Call,
  DeadlineOutOfRangeError,
  InventoryExceededError,
  LimitExceededError,
  laneOf,
  loadDeployments,
  loadSigner,
  MantleAccount,
  mantleSepolia,
  type Policy,
  PolicyViolationError,
  PrivateKeySigner,
  RelayerExecutor,
  RuleKind,
  readCaliburNonce,
  SELECTORS,
  SponsorRejectedError,
  signBatchedCall,
} from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  approveCall,
  buyCall,
  claimCall,
  createTokenCall,
  DESIGN_CURVE_PARAMS,
  initialReserves,
  memeLaunchpadAbi,
  minOutFor,
  planBuy,
  predictTokenAddress,
  quoteBuy,
  quoteSell,
  randomSalt,
  sellCall,
  simulateBuy,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  BaseError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  isHex,
  parseAbi,
  parseEther,
  parseEventLogs,
  type TransactionReceipt,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { forgeBuild } from "../../packages/sdk/test/helpers.js";
import { startFork } from "./fork.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const traceDir = process.env.FORK_TRACE_DIR;
const book = loadDeployments();
const USD = book.mockUsd;
const HOOK = book.agentPolicyHook;
const mUSD = (n: number) => BigInt(n) * 10n ** 6n;

// anvil's funded development accounts; none of them is the human or the agent.
const MNEMONIC = "test test test test test test test test test test test junk";
const DEPLOYER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
/** Trades on the launchpad as a plain EOA, and lands session-signed batches on chain directly. */
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const TREASURY = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
const RELAYER_KEY = toHex(
  mnemonicToAccount(MNEMONIC, { addressIndex: 1 }).getHdKey().privateKey as Uint8Array,
);

/** The reverts a session batch can produce on chain: Calibur v1.1.0, AgentPolicyHook, launchpad. */
const revertAbi = parseAbi([
  "error CallFailed(bytes reason)",
  "error CallNotPermitted(address to, bytes4 selector)",
  "error LimitExceeded(address token)",
  "error RecipientNotAccount(address recipient)",
  "error DeadlineOutOfRange(uint256 deadline)",
  "error InventoryExceeded(address token, uint256 held)",
  "error AttributionGap(address token)",
  "error TargetIsHook()",
  "error SessionInactive()",
  "error InvalidSignature()",
  "error InvalidNonce()",
  "error UnknownToken()",
  "error InsufficientOutput()",
]);

/** `Name` of a revert, a Calibur `CallFailed(bytes)` unwrapped to `CallFailed(Name)`. */
function revertName(data: Hex): string {
  const { errorName, args } = decodeErrorResult({ abi: revertAbi, data });
  if (errorName === "CallFailed" && args?.[0] && args[0] !== "0x") {
    return `CallFailed(${revertName(args[0] as Hex)})`;
  }
  return errorName;
}

/** The revert data of a failed `eth_call` (on the deepest cause, as viem's own helper finds it). */
function revertData(error: unknown): Hex {
  const cause = error instanceof BaseError ? (error.walk() as { data?: unknown }) : undefined;
  const raw = cause?.data;
  const data = typeof raw === "object" ? (raw as { data?: unknown } | null)?.data : raw;
  if (!isHex(data)) throw error;
  return data;
}

describe.skipIf(!rpcUrl)("launchpad under the real AA contracts and sponsor (fork)", () => {
  let stopFork: (() => void) | undefined;
  let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
  let client: ReturnType<typeof publicClient>;
  let pad: Address;
  let me: Address;
  let keyHash: Hex;
  let signer: PrivateKeySigner;
  let executor: RelayerExecutor;
  let session: AgentSession;
  let account: MantleAccount;
  /** Created by the session in the sponsor-path spike; used for the later trades and refusals. */
  let devToken: Address;

  const publicClient = (url: string) =>
    createPublicClient({ chain: mantleSepolia, transport: http(url), pollingInterval: 50 });
  const walletFor = (url: string, who: typeof MARKET) =>
    createWalletClient({ account: who, chain: mantleSepolia, transport: http(url) });
  let wallet: (who: typeof MARKET) => ReturnType<typeof walletFor>;

  // ---- reads ----
  const now = async () => (await client.getBlock()).timestamp;
  const deadline = async () => (await now()) + 300n;
  const hookRead = (fn: "inventory" | "remainingLimit", token: Address) =>
    client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: fn as "inventory",
      args: [keyHash, me, token],
    });
  const inventory = (token: Address) => hookRead("inventory", token);
  const remaining = () => hookRead("remainingLimit", USD);
  const balanceOf = (token: Address, who: Address = me) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const allowance = () =>
    client.readContract({
      address: USD,
      abi: erc20Abi,
      functionName: "allowance",
      args: [me, pad],
    });
  const curveStatus = async (token: Address) =>
    (
      await client.readContract({
        address: pad,
        abi: memeLaunchpadAbi,
        functionName: "curveState",
        args: [token],
      })
    ).status;
  const relayerTxs = () => client.getTransactionCount({ address: RELAYER.address });

  const receipt = (hash: Hex) => client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  const tradeOf = (r: TransactionReceipt) => {
    const trades = parseEventLogs({ abi: memeLaunchpadAbi, eventName: "Trade", logs: r.logs });
    expect(trades).toHaveLength(1);
    return (trades[0] as (typeof trades)[number]).args;
  };

  /** A plain EOA transaction from MARKET; must succeed. */
  async function market(call: { to: Address; data: Hex }) {
    const r = await receipt(await wallet(MARKET).sendTransaction(call));
    expect(r.status).toBe("success");
    return r;
  }

  /** A market-created token (no session involved). */
  async function marketToken(name: string): Promise<Address> {
    const salt = randomSalt();
    await market(createTokenCall(pad, { name, symbol: name, salt }));
    return predictTokenAddress(pad, MARKET.address, salt, name, name);
  }

  /** The session's batch through the SDK (simulate) and the sponsor; relayed by the sponsor. */
  async function viaSponsor(calls: Call[]) {
    const { hash, success } = await session.exec(calls);
    expect(success).toBe(true);
    const r = await receipt(hash);
    expect(r.from.toLowerCase()).toBe(RELAYER.address.toLowerCase());
    return r;
  }

  /** `execute(SignedBatchedCall, sig)` signed by the session key, executor = MARKET. */
  async function signDirect(calls: Call[]) {
    return signBatchedCall(client, {
      account: me,
      implementation: book.caliburEntry,
      chainId: book.chainId,
      signer,
      keyHash,
      calls,
      nonce: await readCaliburNonce(client, me, laneOf(keyHash)),
      executor: MARKET.address,
      deadline: (await now()) + 600n,
    });
  }

  /** The call traces of a transaction (anvil's `debug_traceTransaction`), when asked for. */
  async function trace(hash: Hex, label: string) {
    if (!traceDir) return;
    const result = await client.request({
      method: "debug_traceTransaction" as never,
      params: [hash, { tracer: "callTracer" }] as never,
    });
    mkdirSync(traceDir, { recursive: true });
    writeFileSync(
      join(traceDir, `${label}.json`),
      JSON.stringify({ hash, trace: result }, null, 2),
    );
  }

  /** `[createToken, approve, buy(predicted)]` for a fresh token, with the local curve's quote. */
  function createWithDevBuy(name: string, dev: bigint, deadline: bigint) {
    const salt = randomSalt();
    const token = predictTokenAddress(pad, me, salt, name, name);
    // The token does not exist yet, so the quote comes from the local model of a fresh curve.
    const quote = simulateBuy(DESIGN_CURVE_PARAMS, initialReserves(DESIGN_CURVE_PARAMS), dev);
    const plan = planBuy({
      launchpad: pad,
      quoteToken: USD,
      token,
      recipient: me,
      amountIn: dev,
      quote,
      deadline,
    });
    const calls = [createTokenCall(pad, { name, symbol: name, salt }), ...plan.calls];
    return { token, quote, calls };
  }

  /** Every overreach is refused by the SDK, by the sponsor (no pre-check) and on chain. */
  async function refusedEverywhere(
    calls: Call[],
    expected: { sdk: new (...args: never[]) => Error; chain: string },
  ) {
    const txs = await relayerTxs();
    await expect(session.simulate(calls)).rejects.toBeInstanceOf(expected.sdk);

    const error = await executor
      .submit({
        account: me,
        keyHash,
        calls,
        lane: laneOf(keyHash),
        signer,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SponsorRejectedError);
    expect((error as SponsorRejectedError).reason, (error as Error).message).toBe(
      "SIMULATION_FAILED",
    );
    expect(await relayerTxs()).toBe(txs);

    // On chain: the same batch, signed by the session key and sent by MARKET with a fixed gas limit
    // so that the reverting transaction is mined.
    const data = await signDirect(calls);
    const reason = await client.call({ account: MARKET.address, to: me, data }).then(
      () => "no revert",
      (e: unknown) => revertName(revertData(e)),
    );
    const r = await receipt(
      await wallet(MARKET).sendTransaction({ to: me, data, gas: 3_000_000n }),
    );
    expect(r.status).toBe("reverted");
    expect(reason).toBe(expected.chain);
  }

  beforeAll(async () => {
    const fork = await startFork(rpcUrl as string);
    stopFork = fork.stop;
    client = publicClient(fork.url);
    wallet = (who) => walletFor(fork.url, who);

    // The launchpad from a fresh `forge build`, quoting in the deployed MockUSD.
    const { abi, bytecode } = forgeBuild()("MemeLaunchpad");
    const deployed = await receipt(
      await wallet(DEPLOYER).deployContract({
        abi,
        bytecode: bytecode.object,
        args: [USD, TREASURY, DESIGN_CURVE_PARAMS],
      }),
    );
    pad = deployed.contractAddress as Address;

    // A human with 0 MNT; every transaction of theirs and their agent's is paid by the sponsor.
    const root = new PrivateKeySigner(generatePrivateKey());
    me = root.address;
    const config: SponsorConfig = {
      chainId: book.chainId,
      rpcUrl: fork.url,
      listen: { host: "127.0.0.1", port: 0 },
      database: ":memory:",
      relayer: RELAYER.address,
      relayerKeyEnv: "E2E_RELAYER_KEY",
      settleTimeoutSeconds: 30,
      addresses: book,
      maxRequestValiditySeconds: 300,
      policy: {
        allowlist: [me],
        accountDailyGas: 1_000_000_000n,
        maxFeePerRequest: parseEther("0.5"),
        dailyBudget: parseEther("5"),
        managementReserve: parseEther("1"),
      },
    };
    sponsor = await startSponsor(config, {
      env: { E2E_RELAYER_KEY: RELAYER_KEY },
      pollIntervalMs: 100,
    });
    executor = new RelayerExecutor({ client, url: sponsor.url, addresses: book });

    // The policy `mantle-meme policy init` generates (DESIGN §6.2).
    const policy: Policy = {
      maxValuePerCall: 0n,
      mntLimit: { token: zeroAddress, totalCap: 0n, periodCap: 0n },
      quoteLimits: [{ token: USD, totalCap: mUSD(1000), periodCap: mUSD(700) }],
      periodLength: 86400,
      permissions: [
        { target: USD, selector: SELECTORS.approve, ruleKind: RuleKind.ERC20_APPROVE },
        { target: pad, selector: SELECTORS.buy, ruleKind: RuleKind.LAUNCHPAD_BUY },
        { target: pad, selector: SELECTORS.sell, ruleKind: RuleKind.LAUNCHPAD_SELL },
        {
          target: pad,
          selector: toFunctionSelector("createToken(string,string,string,string,bytes32)"),
          ruleKind: RuleKind.NONE,
        },
        {
          target: pad,
          selector: toFunctionSelector("claimCreatorFees(address)"),
          ruleKind: RuleKind.NONE,
        },
      ],
      trustedSpenders: [pad],
      maxDeadlineWindow: 600,
    };
    const keystore = {
      home: mkdtempSync(join(tmpdir(), "meme-e2e-")),
      password: "test",
      scrypt: { n: 1024, r: 8, p: 1 },
    };
    account = new MantleAccount({ client, root, executor, addresses: book, keystore });
    const init = await account.init({ grant: { policy, agentName: "agent" } });
    expect(init.state).toBe("INITIALIZED");
    const grant = init.session as NonNullable<typeof init.session>;
    keyHash = grant.keyHash;
    signer = loadSigner(grant.keyfile, keystore);
    session = new AgentSession({ client, account: me, keyHash, signer, executor, addresses: book });

    // Principal is minted, never bought with MNT; MARKET trades with its own.
    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    for (const [to, amount] of [
      [me, mUSD(2000)],
      [MARKET.address, mUSD(100_000)],
    ] as const) {
      await market({ to: USD, data: encodeFunctionData({ abi: mint, args: [to, amount] }) });
    }
    await market(approveCall(USD, pad, mUSD(100_000)));
  }, 180_000);

  afterAll(async () => {
    await sponsor?.close();
    stopFork?.();
  }, 30_000);

  describe("create + dev buy in one batch, on a token address that does not exist yet", () => {
    it("through the sponsor: SDK simulation → sponsor_relay → checks → eth_estimateGas → relayer", async () => {
      const { token, quote, calls } = createWithDevBuy("DEV", mUSD(5), await deadline());
      expect(await client.getCode({ address: token })).toBeUndefined();
      const before = { usd: await balanceOf(USD), limit: await remaining() };

      const r = await viaSponsor(calls);
      await trace(r.transactionHash, "create-dev-buy.sponsor");

      const [created] = parseEventLogs({
        abi: memeLaunchpadAbi,
        eventName: "TokenCreated",
        logs: r.logs,
      });
      expect(created?.args).toMatchObject({ token, creator: me });
      const trade = tradeOf(r);
      expect(trade).toMatchObject({ token, trader: me, recipient: me, isBuy: true });
      expect(trade.tokenAmount).toBe(quote.amountOut);
      const received = await balanceOf(token);
      expect(received).toBe(trade.tokenAmount);
      expect(await inventory(token)).toBe(received);
      expect(before.usd - (await balanceOf(USD))).toBe(mUSD(5));
      expect(before.limit - (await remaining())).toBe(mUSD(5));
      expect(await allowance()).toBe(0n);
      devToken = token;
    }, 120_000);

    it("sent straight to the account, bypassing the SDK and the sponsor", async () => {
      const { token, quote, calls } = createWithDevBuy("DIRECT", mUSD(5), await deadline());
      const limit = await remaining();
      const r = await receipt(
        await wallet(MARKET).sendTransaction({ to: me, data: await signDirect(calls) }),
      );
      expect(r.status).toBe("success");
      await trace(r.transactionHash, "create-dev-buy.direct");

      const received = await balanceOf(token);
      expect(received).toBe(quote.amountOut);
      expect(tradeOf(r).tokenAmount).toBe(received);
      expect(await inventory(token)).toBe(received);
      expect(limit - (await remaining())).toBe(mUSD(5));
    }, 120_000);
  });

  it("buy, then sell half of the inventory", async () => {
    const bought = await inventory(devToken);
    const quote = await quoteBuy(client, pad, devToken, mUSD(10));
    const plan = planBuy({
      launchpad: pad,
      quoteToken: USD,
      token: devToken,
      recipient: me,
      amountIn: mUSD(10),
      quote,
      deadline: await deadline(),
    });
    const limit = await remaining();
    expect(tradeOf(await viaSponsor(plan.calls)).tokenAmount).toBe(quote.amountOut);
    expect(await inventory(devToken)).toBe(bought + quote.amountOut);
    expect(limit - (await remaining())).toBe(mUSD(10));

    const half = (await inventory(devToken)) / 2n;
    const sold = await quoteSell(client, pad, devToken, half);
    const usd = await balanceOf(USD);
    await viaSponsor([
      sellCall(pad, {
        token: devToken,
        amount: half,
        minOut: minOutFor(sold.amountOut),
        deadline: await deadline(),
        recipient: me,
      }),
    ]);
    expect(await inventory(devToken)).toBe(bought + quote.amountOut - half);
    expect((await balanceOf(USD)) - usd).toBe(sold.amountOut);
    // Inflows never restore the limit.
    expect(await remaining()).toBe(limit - mUSD(10));
  }, 120_000);

  it("claimCreatorFees is allowed under NONE and pays the creator account", async () => {
    // Someone else trades the session's token too.
    await market(
      buyCall(pad, {
        token: devToken,
        amount: mUSD(3),
        minOut: 0n,
        deadline: await deadline(),
        recipient: MARKET.address,
      }),
    );
    const creatorFees = () =>
      client.readContract({
        address: pad,
        abi: memeLaunchpadAbi,
        functionName: "creatorFees",
        args: [devToken],
      });
    const fees = await creatorFees();
    expect(fees).toBeGreaterThan(0n);
    const [usd, limit, held] = [await balanceOf(USD), await remaining(), await inventory(devToken)];

    await viaSponsor([claimCall(pad, devToken)]);
    expect((await balanceOf(USD)) - usd).toBe(fees);
    expect(await creatorFees()).toBe(0n);
    expect(await remaining()).toBe(limit);
    expect(await inventory(devToken)).toBe(held);
  }, 120_000);

  it("a completing buy clamped to amountInUsed is charged exactly that against the limit", async () => {
    const token = await marketToken("CLAMP");
    const request = mUSD(800);
    const quote = await quoteBuy(client, pad, token, request);
    expect(quote.completes).toBe(true);
    const limit = await remaining();
    // The clamp case: the remaining limit lies strictly between what the buy uses and the request.
    expect(quote.amountInUsed).toBeLessThan(limit);
    expect(limit).toBeLessThan(request);

    const unclamped = [
      approveCall(USD, pad, request),
      buyCall(pad, {
        token,
        amount: request,
        minOut: minOutFor(quote.amountOut),
        deadline: await deadline(),
        recipient: me,
      }),
    ];
    await expect(session.simulate(unclamped)).rejects.toBeInstanceOf(LimitExceededError);

    const plan = planBuy({
      launchpad: pad,
      quoteToken: USD,
      token,
      recipient: me,
      amountIn: request,
      quote,
      deadline: await deadline(),
    });
    expect(plan.amountIn).toBe(quote.amountInUsed);
    const usd = await balanceOf(USD);
    const trade = tradeOf(await viaSponsor(plan.calls));

    expect(trade.quoteAmount).toBe(quote.amountInUsed);
    expect(usd - (await balanceOf(USD))).toBe(quote.amountInUsed);
    expect(limit - (await remaining())).toBe(quote.amountInUsed);
    expect(await inventory(token)).toBe(trade.tokenAmount);
    expect(trade.tokenAmount).toBe(quote.amountOut);
    expect(await allowance()).toBe(0n);
    expect(await curveStatus(token)).toBe(2); // Completed
  }, 120_000);

  it("a buy truncated on chain (someone bought first) is charged only what was pulled", async () => {
    const token = await marketToken("RACE");
    const request = mUSD(30);
    // At planning time the buy does not complete the curve …
    expect((await quoteBuy(client, pad, token, request)).completes).toBe(false);
    const calls = [
      approveCall(USD, pad, request),
      // The race fallback is what is tested here, so the session accepts any output.
      buyCall(pad, {
        token,
        amount: request,
        minOut: 1n,
        deadline: await deadline(),
        recipient: me,
      }),
    ];
    // … then another buyer takes most of the curve before the session's batch lands.
    await market(
      buyCall(pad, {
        token,
        amount: mUSD(590),
        minOut: 0n,
        deadline: await deadline(),
        recipient: MARKET.address,
      }),
    );
    const raced = await quoteBuy(client, pad, token, request);
    expect(raced.completes).toBe(true);

    const [usd, limit] = [await balanceOf(USD), await remaining()];
    const trade = tradeOf(await viaSponsor(calls));
    const pulled = trade.quoteAmount;
    expect(pulled).toBe(raced.amountInUsed);
    expect(pulled).toBeLessThan(request);
    expect(usd - (await balanceOf(USD))).toBe(pulled);
    expect(limit - (await remaining())).toBe(pulled);
    expect(await inventory(token)).toBe(trade.tokenAmount);
    // The unused allowance stays with the trusted launchpad (DESIGN §4.3.3).
    expect(await allowance()).toBe(request - pulled);
    expect(await curveStatus(token)).toBe(2);

    // Reset it as the next approve would, so the refusals below start from 0.
    await viaSponsor([approveCall(USD, pad, 0n)]);
  }, 120_000);

  describe("every overreach is refused by the SDK, the sponsor and, sent directly, the chain", () => {
    let snapshot: bigint[];
    const state = async () => [
      await remaining(),
      await inventory(devToken),
      await balanceOf(USD),
      await balanceOf(devToken),
      await allowance(),
    ];

    beforeAll(async () => {
      // Meme the account holds beyond the session's inventory: bought for it by a third party.
      await market(
        buyCall(pad, {
          token: devToken,
          amount: mUSD(2),
          minOut: 0n,
          deadline: await deadline(),
          recipient: me,
        }),
      );
      expect(await balanceOf(devToken)).toBeGreaterThan(await inventory(devToken));
      snapshot = await state();
    }, 60_000);

    it("MockUSD transfer (not on the allowlist)", async () => {
      const transfer: Call = {
        to: USD,
        value: 0n,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [MARKET.address, 1n],
        }),
      };
      await refusedEverywhere([transfer], { sdk: PolicyViolationError, chain: "CallNotPermitted" });
    }, 120_000);

    it("an approve over the remaining limit", async () => {
      const over = (await remaining()) + 1n;
      await refusedEverywhere([approveCall(USD, pad, over)], {
        sdk: LimitExceededError,
        chain: "LimitExceeded",
      });
    }, 120_000);

    it("a buy over the remaining limit, spending an allowance the human set", async () => {
      // The allowance belongs to the account: the root may approve more than the session's limit.
      await account.exec([approveCall(USD, pad, mUSD(1000))]);
      const over = (await remaining()) + 1n;
      expect((await quoteBuy(client, pad, devToken, over)).completes).toBe(false);
      await refusedEverywhere(
        [
          buyCall(pad, {
            token: devToken,
            amount: over,
            minOut: 0n,
            deadline: await deadline(),
            recipient: me,
          }),
        ],
        { sdk: LimitExceededError, chain: "LimitExceeded" },
      );
      await account.exec([approveCall(USD, pad, 0n)]);
    }, 180_000);

    it("selling more than the session's inventory, reaching into meme it did not buy", async () => {
      const held = await inventory(devToken);
      await refusedEverywhere(
        [
          sellCall(pad, {
            token: devToken,
            amount: held + 1n,
            minOut: 0n,
            deadline: await deadline(),
            recipient: me,
          }),
        ],
        { sdk: InventoryExceededError, chain: "InventoryExceeded" },
      );
    }, 120_000);

    it("a sell whose proceeds go to someone else (recipient ≠ account)", async () => {
      await refusedEverywhere(
        [
          sellCall(pad, {
            token: devToken,
            amount: 1n,
            minOut: 0n,
            deadline: await deadline(),
            recipient: MARKET.address,
          }),
        ],
        { sdk: PolicyViolationError, chain: "RecipientNotAccount" },
      );
    }, 120_000);

    it("a buy with a deadline beyond the policy's window", async () => {
      await refusedEverywhere(
        [
          buyCall(pad, {
            token: devToken,
            amount: 1n,
            minOut: 0n,
            deadline: (await now()) + 3600n,
            recipient: me,
          }),
        ],
        { sdk: DeadlineOutOfRangeError, chain: "DeadlineOutOfRange" },
      );
    }, 120_000);

    it("left the limit, inventory, balances and allowance untouched", async () => {
      expect(await state()).toEqual(snapshot);
    }, 60_000);
  });

  it("the human and the agent held 0 MNT throughout", async () => {
    expect(await client.getBalance({ address: me })).toBe(0n);
    expect(await client.getBalance({ address: signer.address })).toBe(0n);
  }, 60_000);
});
