// `mantle-meme` driven as a binary on an anvil fork of Mantle Sepolia, the way the agent runs it:
// the human sets up with the published `mantle-aa` CLI (keys import, `account init --grant` with
// the file `mantle-meme policy init` wrote, `session export`, the printed MockUSD mint), then every
// command runs from the exported agent home — which holds no root key — against the deployed
// MemeLaunchpad, CaliburEntry + AgentPolicyHook and a local sponsor.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import {
  agentPolicyHookAbi,
  ExecutionRevertedError,
  mantleSepolia,
  readProfiles,
} from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  approveCall,
  buyCall,
  createTokenCall,
  journalPath,
  loadDeployments,
  memeLaunchpadAbi,
  openAgentSession,
  planBuy,
  predictTokenAddress,
  quoteBuy,
  quoteSell,
  randomSalt,
  readJournal,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseUnits,
  type TransactionReceipt,
  toHex,
  zeroHash,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFork } from "../../../e2e/launchpad/fork.js";
import { CURVE_COMPLETED_TEXT } from "../src/errors.js";
import { mantleAa, mantleMeme, memeArgs, type Ran } from "./helpers.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const PAD = book.memeLaunchpad as Address;
const USD = book.mockUsd;
const HOOK = book.agentPolicyHook;
const mUSD = (n: number) => parseUnits(String(n), 6);

const MNEMONIC = "test test test test test test test test test test test junk";
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);

const ROOT_PASSWORD = "root-password";
const AGENT_PASSWORD = "agent-password";
/** Symbols unique to this run, so a symbol never matches a token already on Sepolia. */
const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const SYMBOL = `CLI${TAG}`;
const TWIN = `TWIN${TAG}`;
const DONE = `DONE${TAG}`;

describe.skipIf(!rpcUrl)(
  "mantle-meme command mode from an exported agent home (fork)",
  { timeout: 180_000 },
  () => {
    let stopFork: (() => void) | undefined;
    let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
    let forkUrl: string;
    let client: ReturnType<typeof publicClient>;
    const rootKey = generatePrivateKey();
    const me = privateKeyToAddress(rootKey);
    const dir = mkdtempSync(join(tmpdir(), "meme-cli-fork-"));
    const rootHome = join(dir, "root");
    const agentHome = join(dir, "agent");
    let rootEnv: Record<string, string>;
    let agentEnv: Record<string, string>;
    /** Outputs of the human's setup. */
    let policyInit: Ran;
    let accountInit: Ran;
    let exported: Ran;
    let minted: Ran;
    /** The agent's own token (created with a dev buy) and the block it was created in. */
    let token: Address;
    let createdBlock: bigint;
    let doneToken: Address;

    const publicClient = (url: string) =>
      createPublicClient({ chain: mantleSepolia, transport: http(url), pollingInterval: 50 });

    const meme = (...args: string[]) => mantleMeme([...args, "--json"], agentEnv);
    const aa = (args: string[], env = rootEnv, input?: string) =>
      mantleAa([...args, "--json"], env, input);

    const keyHash = () => accountInit.json.result.session.keyHash as Hex;
    const hookRead = (fn: "inventory" | "remainingLimit", t: Address) =>
      client.readContract({
        address: HOOK,
        abi: agentPolicyHookAbi,
        functionName: fn as "inventory",
        args: [keyHash(), me, t],
      });
    const balanceOf = (t: Address, who: Address = me) =>
      client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    const creatorFees = (t: Address) =>
      client.readContract({
        address: PAD,
        abi: memeLaunchpadAbi,
        functionName: "creatorFees",
        args: [t],
      });

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

    async function marketToken(symbol: string): Promise<Address> {
      const salt = randomSalt();
      await market(createTokenCall(PAD, { name: `${symbol} coin`, symbol, salt }));
      return predictTokenAddress(PAD, MARKET.address, salt, `${symbol} coin`, symbol);
    }

    /** A successful `--json` run: its result. */
    function ok(r: Ran, command: string) {
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.json).toMatchObject({ ok: true, command });
      return r.json.result;
    }

    /** A failed `--json` run: its error. */
    function fails(r: Ran, command: string, exitCode: number, code: string) {
      expect(r.code, r.stderr || r.stdout).toBe(exitCode);
      expect(r.json).toMatchObject({ ok: false, command, exitCode, error: { code } });
      return r.json.error;
    }

    beforeAll(async () => {
      const fork = await startFork(rpcUrl as string);
      stopFork = fork.stop;
      forkUrl = fork.url;
      client = publicClient(fork.url);
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
      const chain = { MANTLE_AA_RPC_URL: fork.url, MANTLE_AA_SPONSOR_URL: sponsor.url };
      rootEnv = { ...chain, MANTLE_AA_HOME: rootHome, MANTLE_AA_KEYSTORE_PASSWORD: ROOT_PASSWORD };
      agentEnv = {
        ...chain,
        MANTLE_AA_HOME: agentHome,
        MANTLE_AA_KEYSTORE_PASSWORD: AGENT_PASSWORD,
      };

      // The human, in the root terminal (DESIGN §8.1).
      ok(await aa(["keys", "import", "--name", "owner"], rootEnv, rootKey), "keys import");
      policyInit = await mantleMeme(
        [
          "policy",
          "init",
          "--total",
          "100",
          "--per-day",
          "100",
          "--out",
          join(dir, "policy.json"),
          "--json",
        ],
        rootEnv,
      );
      const next: string[] = ok(policyInit, "policy init").next;
      accountInit = await aa([
        "account",
        "init",
        "--grant",
        join(dir, "policy.json"),
        "--agent",
        "trader",
      ]);
      exported = await aa(["session", "export", "--agent", "trader", "--out", agentHome], {
        ...rootEnv,
        MANTLE_AA_EXPORT_PASSWORD: AGENT_PASSWORD,
      });
      const calls = /^mantle-aa account exec --calls '(.*)'$/.exec(next[2] as string)?.[1];
      minted = await aa(["account", "exec", "--calls", calls as string]);

      // The market (a plain EOA paying its own gas): tokens to trade and one completed curve.
      const mint = parseAbi(["function mint(address to, uint256 amount)"]);
      await market({
        to: USD,
        data: encodeFunctionData({ abi: mint, args: [MARKET.address, mUSD(10_000)] }),
      });
      await market(approveCall(USD, PAD, maxUint256));
      await marketToken(TWIN);
      await marketToken(TWIN);
      doneToken = await marketToken(DONE);
      await market(
        buyCall(PAD, {
          token: doneToken,
          amount: mUSD(1000),
          minOut: 0n,
          deadline: (await client.getBlock()).timestamp + 300n,
          recipient: MARKET.address,
        }),
      );
    }, 300_000);

    afterAll(async () => {
      await sponsor?.close();
      stopFork?.();
    }, 30_000);

    it("policy init's file grants on the fork: account init --grant, session export, the printed mint", async () => {
      expect(policyInit.json.result.next).toEqual([
        `mantle-aa account init --grant ${join(dir, "policy.json")} --agent trader`,
        `mantle-aa session export --agent trader --out ~/.mantle-meme-agent`,
        expect.stringMatching(/^mantle-aa account exec --calls '\[.*\]'$/),
      ]);
      const init = ok(accountInit, "account init");
      expect(init).toMatchObject({
        account: me,
        state: "INITIALIZED",
        session: { profile: "trader" },
      });
      expect(ok(exported, "session export")).toMatchObject({
        home: expect.any(String),
        role: "agent",
      });
      ok(minted, "account exec");
      expect(await balanceOf(USD)).toBe(mUSD(100));
      expect(await hookRead("remainingLimit", USD)).toBe(mUSD(100));
    });

    it("the agent home holds only the agent's key and profile, no root key", () => {
      expect(Object.values(readProfiles({ home: agentHome })).map((p) => p.role)).toEqual([
        "agent",
      ]);
      expect(readdirSync(join(agentHome, "keys"))).toEqual(["trader.json"]);
      const keystore = JSON.parse(readFileSync(join(agentHome, "keys", "trader.json"), "utf8"));
      expect(`0x${keystore.address}`.toLowerCase()).not.toBe(me.toLowerCase());
      expect(readFileSync(join(agentHome, "keys", "trader.json"), "utf8")).not.toContain(
        rootKey.slice(2),
      );
    });

    it("create --dev-buy creates the token and buys it in one sponsored batch", async () => {
      const r = ok(
        await meme("create", "--name", "CLI coin", "--symbol", SYMBOL, "--dev-buy", "5"),
        "create",
      );
      expect(r).toEqual({
        account: me,
        token: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        name: "CLI coin",
        symbol: SYMBOL,
        salt: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        hash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        explorer: `https://sepolia.mantlescan.xyz/tx/${r.hash}`,
        devBuy: {
          spent: { human: "5", base: "5000000" },
          tokens: { human: expect.any(String), base: expect.any(String) },
          fee: { human: "0.05", base: "50000" },
          minOut: { human: expect.any(String), base: expect.any(String) },
          completes: false,
        },
      });
      token = r.token;
      const rc = await receipt(r.hash);
      expect(rc.status).toBe("success");
      expect(rc.from.toLowerCase()).toBe(RELAYER.address.toLowerCase());
      createdBlock = rc.blockNumber;
      expect(await hookRead("inventory", token)).toBe(BigInt(r.devBuy.tokens.base));
      expect(BigInt(r.devBuy.tokens.base)).toBeGreaterThanOrEqual(BigInt(r.devBuy.minOut.base));
      expect(readJournal(agentHome)).toHaveLength(1);
    });

    it("buy <symbol> spends the amount and credits the session's inventory", async () => {
      const before = await hookRead("inventory", token);
      const r = ok(
        await meme("buy", SYMBOL.toLowerCase(), "--amount", "2", "--slippage", "1"),
        "buy",
      );
      expect(r).toEqual({
        account: me,
        token,
        symbol: SYMBOL,
        hash: expect.any(String),
        explorer: expect.stringContaining(r.hash),
        requested: { human: "2", base: "2000000" },
        spent: { human: "2", base: "2000000" },
        tokens: { human: expect.any(String), base: expect.any(String) },
        fee: { human: "0.02", base: "20000" },
        minOut: { human: expect.any(String), base: expect.any(String) },
        completes: false,
      });
      expect(await hookRead("inventory", token)).toBe(before + BigInt(r.tokens.base));
    });

    it("quote --buy / --sell match the launchpad's views", async () => {
      const buy = ok(await meme("quote", token, "--buy", "1"), "quote");
      const qb = await quoteBuy(client, PAD, token, mUSD(1));
      expect(buy).toEqual({
        token,
        symbol: SYMBOL,
        side: "buy",
        requested: { human: "1", base: "1000000" },
        amountIn: { human: "1", base: qb.amountInUsed.toString() },
        amountOut: { human: expect.any(String), base: qb.amountOut.toString() },
        fee: { human: "0.01", base: qb.feeUsed.toString() },
        completes: false,
      });
      const sell = ok(await meme("quote", SYMBOL, "--sell", "1000.5"), "quote");
      const qs = await quoteSell(client, PAD, token, parseUnits("1000.5", 18));
      expect(sell).toEqual({
        token,
        symbol: SYMBOL,
        side: "sell",
        amountIn: { human: "1000.5", base: parseUnits("1000.5", 18).toString() },
        amountOut: { human: expect.any(String), base: qs.amountOut.toString() },
        fee: { human: expect.any(String), base: qs.fee.toString() },
      });
    });

    it("info shows the curve; a completed curve carries the stranded notice", async () => {
      const r = ok(await meme("info", SYMBOL), "info");
      const s = await client.readContract({
        address: PAD,
        abi: memeLaunchpadAbi,
        functionName: "curveState",
        args: [token],
      });
      expect(r).toEqual({
        address: token,
        name: "CLI coin",
        symbol: SYMBOL,
        status: "trading",
        creator: me,
        createdAt: Number(s.createdAt),
        price: { human: expect.any(String), priceE18: s.priceE18.toString() },
        sold: { human: expect.any(String), base: s.sold.toString() },
        progressPercent: expect.any(Number),
        raised: { human: expect.any(String), base: s.realQuote.toString() },
        creatorFees: { human: expect.any(String), base: (await creatorFees(token)).toString() },
      });
      const done = ok(await meme("info", doneToken), "info");
      expect(done).toMatchObject({
        status: "completed",
        progressPercent: 100,
        notice: CURVE_COMPLETED_TEXT,
      });
    });

    it("list shows the newest tokens first, filtered by status and age", async () => {
      const r = ok(await meme("list", "--limit", "4", "--since", "1h"), "list");
      expect(r.tokens.map((t: { symbol: string }) => t.symbol)).toEqual([SYMBOL, DONE, TWIN, TWIN]);
      expect(BigInt(r.total)).toBeGreaterThanOrEqual(4n);
      const completed = ok(await meme("list", "--status", "completed", "--limit", "1"), "list");
      expect(completed.tokens).toEqual([
        expect.objectContaining({
          address: doneToken,
          status: "completed",
          notice: CURVE_COMPLETED_TEXT,
        }),
      ]);
    });

    it("watch prints the launchpad's events as JSON lines until interrupted", async () => {
      const proc = spawn(
        process.execPath,
        memeArgs(["watch", "--from-block", String(createdBlock)]),
        {
          env: { ...process.env, ...agentEnv },
        },
      );
      const lines = createInterface({ input: proc.stdout });
      const events: { event: string; args: { token: string } }[] = [];
      const exited = new Promise<number | null>((r) => proc.once("exit", r));
      const timer = setTimeout(() => proc.kill("SIGKILL"), 60_000);
      for await (const line of lines) {
        events.push(JSON.parse(line));
        if (events.length === 3) break;
      }
      proc.kill("SIGTERM");
      expect(await exited).toBe(0);
      clearTimeout(timer);
      // The create + dev buy transaction, then the buy.
      expect(events.map((e) => e.event)).toEqual(["TokenCreated", "Trade", "Trade"]);
      expect(events[0]).toMatchObject({
        blockNumber: createdBlock.toString(),
        transactionHash: expect.any(String),
        logIndex: expect.any(Number),
        args: { token, creator: me, symbol: SYMBOL },
      });
      expect(events[1]).toMatchObject({
        args: { token, trader: me, isBuy: true, quoteAmount: "5000000" },
      });
    });

    it("sell --percent 50 sells half of the session's inventory", async () => {
      const held = await hookRead("inventory", token);
      const r = ok(await meme("sell", SYMBOL, "--percent", "50"), "sell");
      expect(r).toEqual({
        account: me,
        token,
        symbol: SYMBOL,
        hash: expect.any(String),
        explorer: expect.stringContaining(r.hash),
        sold: { human: expect.any(String), base: (held / 2n).toString() },
        received: { human: expect.any(String), base: expect.any(String) },
        fee: { human: expect.any(String), base: expect.any(String) },
        minOut: { human: expect.any(String), base: expect.any(String) },
        inventoryLeft: { human: expect.any(String), base: (held - held / 2n).toString() },
      });
      expect(BigInt(r.received.base)).toBeGreaterThanOrEqual(BigInt(r.minOut.base));
      expect(await hookRead("inventory", token)).toBe(held - held / 2n);
    });

    it("selling more than the session's inventory is exit 12, checked before sending", async () => {
      const held = await hookRead("inventory", token);
      const journal = readJournal(agentHome).length;
      const err = fails(
        await meme("sell", SYMBOL, "--amount", (Number(held / 10n ** 18n) + 1).toString()),
        "sell",
        12,
        "INVENTORY_EXCEEDED",
      );
      expect(err).toMatchObject({ token, held: held.toString() });
      expect(readJournal(agentHome)).toHaveLength(journal);
    });

    it("portfolio equals chain state and the journal", async () => {
      const r = ok(await meme("portfolio"), "portfolio");
      const inventory = await hookRead("inventory", token);
      const sellValue = (await quoteSell(client, PAD, token, inventory)).amountOut;
      expect(r).toMatchObject({
        agent: "trader",
        account: me,
        keyHash: keyHash(),
        expiry: accountInit.json.result.session.expiry,
        session: { initialized: true, active: true, revoked: false },
        quote: {
          token: USD,
          balance: { base: (await balanceOf(USD)).toString() },
          remainingLimit: { base: (await hookRead("remainingLimit", USD)).toString() },
        },
      });
      expect(r.positions).toEqual([
        {
          token,
          symbol: SYMBOL,
          status: "trading",
          balance: { human: expect.any(String), base: (await balanceOf(token)).toString() },
          inventory: { human: expect.any(String), base: inventory.toString() },
          costBasis: { human: expect.any(String), base: expect.any(String) },
          sellValue: { human: expect.any(String), base: sellValue.toString() },
          unrealisedPnl: { human: expect.any(String), base: expect.any(String) },
        },
      ]);
      expect(BigInt(r.positions[0].sellValue.base) - BigInt(r.positions[0].costBasis.base)).toBe(
        BigInt(r.positions[0].unrealisedPnl.base),
      );
      // --agent names the profile; the exported home holds only "trader".
      expect(ok(await meme("portfolio", "--agent", "trader"), "portfolio").keyHash).toBe(keyHash());
      const none = fails(await meme("portfolio", "--agent", "nobody"), "portfolio", 1, "USAGE");
      expect(none.message).toMatch(/nobody/);
    });

    it("claim <token> pays the creator share; claim --all claims what accrued since", async () => {
      const due = await creatorFees(token);
      expect(due).toBeGreaterThan(0n);
      const one = ok(await meme("claim", SYMBOL), "claim");
      expect(one).toEqual({
        account: me,
        claims: [{ token, amount: { human: expect.any(String), base: due.toString() } }],
        total: { human: expect.any(String), base: due.toString() },
        hash: expect.any(String),
        explorer: expect.stringContaining(one.hash),
      });
      expect(await creatorFees(token)).toBe(0n);
      // Nothing accrued: no transaction.
      expect(ok(await meme("claim", "--all"), "claim")).toEqual({
        account: me,
        claims: [],
        total: { human: "0", base: "0" },
        hash: null,
        explorer: null,
      });
      // A market trade accrues fees on the agent's token; --all finds and claims them.
      await market(
        buyCall(PAD, {
          token,
          amount: mUSD(10),
          minOut: 0n,
          deadline: (await client.getBlock()).timestamp + 300n,
          recipient: MARKET.address,
        }),
      );
      const accrued = await creatorFees(token);
      const all = ok(await meme("claim", "--all"), "claim");
      expect(all.claims).toEqual([
        { token, amount: { human: expect.any(String), base: accrued.toString() } },
      ]);
      // Not the creator of a market token.
      expect(fails(await meme("claim", DONE), "claim", 1, "USAGE").message).toMatch(
        /not created by/,
      );
    });

    it("unknown and ambiguous symbols are exit 42 with candidates", async () => {
      const missing = fails(
        await meme("buy", `NOPE${TAG}`, "--amount", "1"),
        "buy",
        42,
        "UNKNOWN_TOKEN",
      );
      expect(missing.candidates).toEqual([]);
      const twin = fails(await meme("info", TWIN), "info", 42, "UNKNOWN_TOKEN");
      expect(twin.candidates).toHaveLength(2);
      expect(twin.candidates.map((c: { symbol: string }) => c.symbol)).toEqual([TWIN, TWIN]);
      fails(
        await meme("info", "0x000000000000000000000000000000000000dEaD"),
        "info",
        42,
        "UNKNOWN_TOKEN",
      );
    });

    it("a completed curve is exit 40 with the stranded text for buy, sell and quote", async () => {
      for (const r of [
        await meme("buy", DONE, "--amount", "1"),
        await meme("sell", DONE, "--all"),
        await meme("quote", DONE, "--buy", "1"),
      ]) {
        expect(fails(r, r.json.command, 40, "CURVE_COMPLETED").message).toBe(CURVE_COMPLETED_TEXT);
      }
    });

    it("premise: Calibur reports a failing session call as bare CallFailed(), so 40 comes from chain state", async () => {
      const session = openAgentSession({
        home: agentHome,
        password: AGENT_PASSWORD,
        client,
        addresses: book,
      });
      const plan = planBuy({
        launchpad: PAD,
        quoteToken: USD,
        token: doneToken,
        recipient: me,
        amountIn: mUSD(1),
        quote: { amountOut: 1n, amountInUsed: mUSD(1), feeUsed: 0n, completes: false },
        deadline: (await client.getBlock()).timestamp + 300n,
      });
      const err = await session.simulate(plan.calls).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExecutionRevertedError);
      expect((err as ExecutionRevertedError).data).toBe("0x3204506f");
    });

    it("a buy within the limit but above the account's balance is exit 43; above the limit, 11", async () => {
      // The root moves most of the account's MockUSD away, so the balance is below the remaining limit.
      const balance = await balanceOf(USD);
      const transfer = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [MARKET.address, balance - mUSD(10)],
      });
      ok(
        await aa(["account", "exec", "--calls", JSON.stringify([{ to: USD, data: transfer }])]),
        "account exec",
      );
      const remaining = await hookRead("remainingLimit", USD);
      expect(remaining).toBeGreaterThan(mUSD(20));
      const journal = readJournal(agentHome).length;

      const poor = fails(
        await meme("buy", SYMBOL, "--amount", "20"),
        "buy",
        43,
        "INSUFFICIENT_BALANCE",
      );
      expect(poor).toMatchObject({ balance: mUSD(10).toString(), needed: mUSD(20).toString() });

      const over = (Number(remaining) / 1e6 + 1).toFixed(6);
      const limit = fails(await meme("buy", SYMBOL, "--amount", over), "buy", 11, "LIMIT_EXCEEDED");
      expect(limit).toMatchObject({ remaining: remaining.toString() });
      expect(readJournal(agentHome)).toHaveLength(journal);
    });

    it("a sponsor reporting success for a reverted transaction is exit 30, not a trade", async () => {
      // A transaction that reverted on chain: the market buys a token that is not registered.
      const wallet = createWalletClient({
        account: MARKET,
        chain: mantleSepolia,
        transport: http(forkUrl),
      });
      const order = { amount: 1n, minOut: 0n, deadline: maxUint256, recipient: MARKET.address };
      const reverted = await wallet.sendTransaction({
        ...buyCall(PAD, { ...order, token: USD }),
        gas: 300_000n,
      });
      expect((await receipt(reverted)).status).toBe("reverted");
      // The sponsor is not trusted: this one answers every relay "success" with that hash.
      const liar = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        res.setHeader("content-type", "application/json");
        const request = body ? JSON.parse(body) : undefined;
        if (request?.method === "sponsor_relay") {
          const result = { status: "success", batchDigest: zeroHash, hash: reverted };
          res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
          return;
        }
        const upstream = await fetch(
          `${sponsor?.url}${req.url}`,
          body ? { method: "POST", headers: { "content-type": "application/json" }, body } : {},
        );
        res.statusCode = upstream.status;
        res.end(await upstream.text());
      });
      await new Promise<void>((r) => liar.listen(0, "127.0.0.1", r));
      try {
        const journal = readJournal(agentHome).length;
        const inventory = await hookRead("inventory", token);
        const r = await mantleMeme(["buy", SYMBOL, "--amount", "1", "--json"], {
          ...agentEnv,
          MANTLE_AA_SPONSOR_URL: `http://127.0.0.1:${(liar.address() as AddressInfo).port}`,
        });
        expect(fails(r, "buy", 30, "EXECUTION_REVERTED").message).toContain(reverted);
        expect(readJournal(agentHome)).toHaveLength(journal);
        expect(await hookRead("inventory", token)).toBe(inventory);
      } finally {
        liar.close();
      }
    });

    it("sell --all empties the session's inventory", async () => {
      const held = await hookRead("inventory", token);
      const r = ok(await meme("sell", SYMBOL, "--all"), "sell");
      expect(r.sold.base).toBe(held.toString());
      expect(r.inventoryLeft.base).toBe("0");
      expect(await hookRead("inventory", token)).toBe(0n);
      expect(readJournal(agentHome).map((x) => x.side)).toEqual(["buy", "buy", "sell", "sell"]);
      expect(journalPath(agentHome).startsWith(agentHome)).toBe(true);
    });

    it("the account held 0 MNT throughout: every send was sponsored", async () => {
      expect(await client.getBalance({ address: me })).toBe(0n);
    });
  },
);
