// Command mode under the real AA stack, on an anvil fork of Mantle Sepolia: the deployed
// CaliburEntry + AgentPolicyHook, a session granted into an agent-only home, and the sponsor
// service. Two OS processes send at once through the send lock; the journal, the portfolio and
// the unknown cost basis are checked against chain state.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type AgentSession,
  agentPolicyHookAbi,
  type Call,
  loadDeployments,
  MantleAccount,
  mantleSepolia,
  type Policy,
  PrivateKeySigner,
  type Profile,
  RelayerExecutor,
  RuleKind,
  readProfiles,
  SELECTORS,
  SponsorBusyError,
} from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  parseAbi,
  parseEther,
  type TransactionReceipt,
  toFunctionSelector,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, mnemonicToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFork } from "../../../e2e/launchpad/fork.js";
import {
  agentProfile,
  approveCall,
  buyCall,
  CurveCompletedError,
  createTokenCall,
  DESIGN_CURVE_PARAMS,
  execute,
  InsufficientBalanceError,
  journalPath,
  minOutFor,
  openAgentSession,
  planBuy,
  portfolio,
  predictTokenAddress,
  quoteBuy,
  quoteSell,
  randomSalt,
  readJournal,
  SlippageError,
  sellCall,
  tradesOf,
} from "../src/index.js";
import { forgeBuild } from "./helpers.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const USD = book.mockUsd;
const HOOK = book.agentPolicyHook;
const mUSD = (n: number) => BigInt(n) * 10n ** 6n;
const PASSWORD = "agent-password";

const MNEMONIC = "test test test test test test test test test test test junk";
const DEPLOYER = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const TREASURY = mnemonicToAccount(MNEMONIC, { addressIndex: 3 }).address;
const RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);

const child = fileURLToPath(new URL("./fixtures/agent-buy.ts", import.meta.url));
const hooks = fileURLToPath(new URL("./fixtures/node-ts.mjs", import.meta.url));

describe.skipIf(!rpcUrl)("command mode under the real AA contracts and sponsor (fork)", () => {
  let stopFork: (() => void) | undefined;
  let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
  let forkUrl: string;
  let client: ReturnType<typeof publicClient>;
  let pad: Address;
  let me: Address;
  let keyHash: Hex;
  let expiry: number;
  let home: string;
  let profile: Profile;
  let session: AgentSession;
  /** Bought by the two processes, journalled. */
  let tokenA: Address;
  /** Bought outside `execute` (the no-lock control), so never journalled. */
  let tokenB: Address;
  const children: ChildProcessWithoutNullStreams[] = [];

  const publicClient = (url: string) =>
    createPublicClient({ chain: mantleSepolia, transport: http(url), pollingInterval: 50 });

  const hookRead = (fn: "inventory" | "remainingLimit", token: Address) =>
    client.readContract({
      address: HOOK,
      abi: agentPolicyHookAbi,
      functionName: fn as "inventory",
      args: [keyHash, me, token],
    });
  const balanceOf = (token: Address) =>
    client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  const deadline = async () => (await client.getBlock()).timestamp + 300n;

  /** Polls for the receipt (viem's waiter can hang on a quiet fork). */
  async function receipt(hash: Hex): Promise<TransactionReceipt> {
    for (const until = Date.now() + 30_000; ; await sleep(50)) {
      const r = await client.getTransactionReceipt({ hash }).catch(() => undefined);
      if (r) return r;
      if (Date.now() > until) throw new Error(`no receipt for ${hash} within 30 s`);
    }
  }

  async function market(call: { to: Address; data: Hex }) {
    const wallet = createWalletClient({
      account: MARKET,
      chain: mantleSepolia,
      transport: http(forkUrl),
    });
    const r = await receipt(await wallet.sendTransaction(call));
    expect(r.status).toBe("success");
  }

  async function marketToken(name: string): Promise<Address> {
    const salt = randomSalt();
    await market(createTokenCall(pad, { name, symbol: name, salt }));
    return predictTokenAddress(pad, MARKET.address, salt, name, name);
  }

  async function buyPlan(token: Address, amountIn: bigint) {
    return planBuy({
      launchpad: pad,
      quoteToken: USD,
      token,
      recipient: me,
      amountIn,
      quote: await quoteBuy(client, pad, token, amountIn),
      deadline: await deadline(),
    });
  }

  /** Starts the agent process; resolves with it once it is ready to send. */
  function startAgent(token: Address, amount: bigint) {
    const proc = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--no-warnings",
        "--import",
        hooks,
        child,
        forkUrl,
        sponsor?.url as string,
        home,
        pad,
        token,
        amount.toString(),
      ],
      { env: { ...process.env, MANTLE_AA_KEYSTORE_PASSWORD: PASSWORD } },
    );
    children.push(proc);
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    const lines = createInterface({ input: proc.stdout })[Symbol.asyncIterator]();
    const exited = new Promise<number | null>((r) => proc.once("exit", r));
    const next = async (what: string) => {
      const line = await Promise.race([lines.next(), exited.then(() => undefined)]);
      if (!line || line.done) throw new Error(`agent exited before ${what}: ${stderr}`);
      return line.value;
    };
    return next("ready").then((ready) => {
      expect(ready).toBe("ready");
      return {
        go: () => proc.stdin.write("go\n"),
        result: async () => {
          const out = JSON.parse(await next("its result"));
          expect(await exited, stderr).toBe(0);
          return out as { hash: Hex; trades: { tokens: string; quotePulled: string }[] };
        },
      };
    });
  }

  beforeAll(async () => {
    const fork = await startFork(rpcUrl as string);
    stopFork = fork.stop;
    forkUrl = fork.url;
    client = publicClient(fork.url);

    const { abi, bytecode } = forgeBuild()("MemeLaunchpad");
    const deployer = createWalletClient({
      account: DEPLOYER,
      chain: mantleSepolia,
      transport: http(forkUrl),
    });
    const deployed = await receipt(
      await deployer.deployContract({
        abi,
        bytecode: bytecode.object,
        args: [USD, TREASURY, DESIGN_CURVE_PARAMS],
      }),
    );
    pad = deployed.contractAddress as Address;

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
    const executor = new RelayerExecutor({ client, url: sponsor.url, addresses: book });

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
    // The root key stays in memory: the home receives only the agent's key and profile, which is
    // what `mantle-aa session export` hands the agent.
    home = mkdtempSync(join(tmpdir(), "meme-agent-home-"));
    const keystore = { home, password: PASSWORD, scrypt: { n: 1024, r: 8, p: 1 } };
    const account = new MantleAccount({ client, root, executor, addresses: book, keystore });
    const init = await account.init({ grant: { policy, agentName: "trader" } });
    expect(init.state).toBe("INITIALIZED");
    const grant = init.session as NonNullable<typeof init.session>;
    keyHash = grant.keyHash;
    expiry = grant.expiry;

    profile = agentProfile(home).profile;
    session = openAgentSession({ home, password: PASSWORD, client, executor, addresses: book });

    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    for (const [to, amount] of [
      [me, mUSD(500)],
      [MARKET.address, mUSD(10_000)],
    ] as const) {
      await market({ to: USD, data: encodeFunctionData({ abi: mint, args: [to, amount] }) });
    }
    await market(approveCall(USD, pad, mUSD(10_000)));
    tokenA = await marketToken("ALPHA");
    tokenB = await marketToken("BETA");
  }, 180_000);

  afterAll(async () => {
    for (const c of children) if (c.exitCode === null) c.kill();
    await sponsor?.close();
    stopFork?.();
  }, 30_000);

  it("the agent home holds one agent profile and no root profile", () => {
    const profiles = Object.values(readProfiles({ home }));
    expect(profiles.map((p) => p.role)).toEqual(["agent"]);
    expect(profile).toMatchObject({ account: me, keyHash });
    expect(session.account).toBe(me);
  });

  it("two OS processes sending at once both succeed through the send lock; no SPONSOR_BUSY surfaces", async () => {
    const agents = await Promise.all([startAgent(tokenA, mUSD(1)), startAgent(tokenA, mUSD(2))]);
    for (const a of agents) a.go();
    const results = await Promise.all(agents.map((a) => a.result()));
    expect(new Set(results.map((r) => r.hash)).size).toBe(2);

    const receipts = await Promise.all(results.map((r) => receipt(r.hash)));
    const expected = receipts.map((r) => {
      expect(r.status).toBe("success");
      expect(r.from.toLowerCase()).toBe(RELAYER.address.toLowerCase());
      return tradesOf(r, pad, me, keyHash);
    });
    // One buy each, journalled from the transaction's own Trade log.
    expect(expected.map((t) => t.length)).toEqual([1, 1]);
    const journal = readJournal(home);
    expect(journal).toHaveLength(2);
    expect(journal).toEqual(expect.arrayContaining(expected.flat()));
    expect(results.map((r) => r.trades[0]?.quotePulled).sort()).toEqual(
      [mUSD(1), mUSD(2)].map(String).sort(),
    );
    expect(await hookRead("inventory", tokenA)).toBe(journal.reduce((s, r) => s + r.tokens, 0n));
  }, 180_000);

  it("without the lock, two simultaneous sends collide on SPONSOR_BUSY (control)", async () => {
    const plans = [await buyPlan(tokenB, mUSD(2)), await buyPlan(tokenB, mUSD(3))];
    const outcomes = await Promise.allSettled(plans.map((p) => session.exec(p.calls)));
    const rejected = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason] : []));
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toBeInstanceOf(SponsorBusyError);
    expect(await hookRead("inventory", tokenB)).toBeGreaterThan(0n);
  }, 120_000);

  it("a buy whose output would fall below minOut is SlippageError and journals nothing", async () => {
    const plan = await buyPlan(tokenA, mUSD(1));
    const greedy = planBuy({
      launchpad: pad,
      quoteToken: USD,
      token: tokenA,
      recipient: me,
      amountIn: mUSD(1),
      quote: { ...(await quoteBuy(client, pad, tokenA, mUSD(1))), amountOut: plan.amountOut * 2n },
      slippageBps: 0,
      deadline: await deadline(),
    });
    const before = readJournal(home).length;
    await expect(
      execute({ session, client, home, launchpad: pad, calls: greedy.calls }),
    ).rejects.toBeInstanceOf(SlippageError);
    expect(readJournal(home)).toHaveLength(before);
  }, 120_000);

  it("a buy beyond the account's balance and a buy on a completed curve are meme errors", async () => {
    const before = readJournal(home).length;
    // Within the session's limits (700 per day) but above the account's mUSD balance.
    const balance = await balanceOf(USD);
    const big = await buyPlan(tokenA, balance + 1n);
    const poor = await execute({ session, client, home, launchpad: pad, calls: big.calls }).catch(
      (e: unknown) => e,
    );
    expect(poor).toBeInstanceOf(InsufficientBalanceError);
    expect(poor).toMatchObject({ balance, needed: balance + 1n });

    const done = await marketToken("DONE");
    const late = await buyPlan(done, mUSD(1));
    await market(
      buyCall(pad, {
        token: done,
        amount: mUSD(1000),
        minOut: 0n,
        deadline: await deadline(),
        recipient: MARKET.address,
      }),
    );
    await expect(
      execute({ session, client, home, launchpad: pad, calls: late.calls }),
    ).rejects.toBeInstanceOf(CurveCompletedError);
    expect(readJournal(home)).toHaveLength(before);
  }, 120_000);

  it("portfolio equals chain state and the journal, past a torn last line; with the journal deleted the cost basis is null", async () => {
    // Sell half of the inventory through execute: the journal now holds two buys and a sell.
    const held = await hookRead("inventory", tokenA);
    const half = held / 2n;
    const sold = await quoteSell(client, pad, tokenA, half);
    const sell: Call = sellCall(pad, {
      token: tokenA,
      amount: half,
      minOut: minOutFor(sold.amountOut),
      deadline: await deadline(),
      recipient: me,
    });
    // A crash cut the journal's last line short: the next append and the portfolio still work.
    const journalled = readJournal(home);
    appendFileSync(journalPath(home), '{"keyHash":');
    const { trades } = await execute({ session, client, home, launchpad: pad, calls: [sell] });
    expect(trades).toMatchObject([{ side: "sell", tokens: half, quotePulled: sold.amountOut }]);
    expect(readJournal(home)).toEqual([...journalled, ...trades]);

    const buys = readJournal(home).filter((r) => r.side === "buy");
    const paid = buys.reduce((s, r) => s + r.quotePulled, 0n);
    const expectedBasis = paid - (paid * half) / held;
    const addresses = { memeLaunchpad: pad, agentPolicyHook: HOOK, mockUsd: USD };

    const chain = async (token: Address) => {
      const inventory = await hookRead("inventory", token);
      return {
        balance: await balanceOf(token),
        inventory,
        sellValue: (await quoteSell(client, pad, token, inventory)).amountOut,
      };
    };
    const [a, b] = [await chain(tokenA), await chain(tokenB)];
    expect(a.inventory).toBe(held - half);

    const p = await portfolio({ client, home, profile, addresses });
    expect(p).toMatchObject({
      account: me,
      keyHash,
      expiry,
      session: { initialized: true, active: true, revoked: false },
      quote: {
        token: USD,
        balance: await balanceOf(USD),
        remainingLimit: await hookRead("remainingLimit", USD),
      },
    });
    expect(p.positions).toEqual([
      {
        token: tokenA,
        symbol: "ALPHA",
        status: "trading",
        ...a,
        costBasis: expectedBasis,
        unrealisedPnl: a.sellValue - expectedBasis,
      },
      // Bought outside the journal: inventory known, cost basis unknown.
      {
        token: tokenB,
        symbol: "BETA",
        status: "trading",
        ...b,
        costBasis: null,
        unrealisedPnl: null,
      },
    ]);

    rmSync(journalPath(home));
    const lost = await portfolio({ client, home, profile, addresses });
    expect(lost.positions).toEqual([
      {
        token: tokenA,
        symbol: "ALPHA",
        status: "trading",
        ...a,
        costBasis: null,
        unrealisedPnl: null,
      },
      {
        token: tokenB,
        symbol: "BETA",
        status: "trading",
        ...b,
        costBasis: null,
        unrealisedPnl: null,
      },
    ]);
    expect({ ...lost, positions: [] }).toEqual({ ...p, positions: [] });
  }, 180_000);

  it("the account held 0 MNT throughout: every send was sponsored", async () => {
    expect(await client.getBalance({ address: me })).toBe(0n);
  });
});
