// Release gate of command mode (DESIGN §11, 0.1.1): §9.1 items 1, 2, 4, 5 and 6 (except 44) on an
// anvil fork of Mantle Sepolia, through the real binaries only. The human sets up with
// `mantle-meme policy init` and the published `mantle-aa` (account init --grant, session export,
// the printed MockUSD mint); then the agent runs `mantle-meme` (and `mantle-aa agent exec` for the
// refused transfer) from the exported home alone, against the deployed MemeLaunchpad, CaliburEntry
// + AgentPolicyHook and a local sponsor. Plain EOAs stand in for other traders.
// Skipped only when MANTLE_SEPOLIA_RPC_URL is unset; CI sets it and fails on a skip.
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { agentPolicyHookAbi, mantleSepolia, readProfiles } from "@0xwh1sker/mantle-aa-sdk";
import { type SponsorConfig, startSponsor } from "@0xwh1sker/mantle-aa-sponsor";
import {
  approveCall,
  buyCall,
  createTokenCall,
  loadDeployments,
  memeLaunchpadAbi,
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
  formatUnits,
  getAddress,
  type Hex,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  parseEventLogs,
  parseUnits,
  type TransactionReceipt,
  toHex,
} from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CURVE_COMPLETED_TEXT } from "../../packages/cli/src/errors.js";
import { mantleAa, mantleMeme, type Ran } from "../../packages/cli/test/helpers.js";
import { startFork } from "../launchpad/fork.js";

const rpcUrl = process.env.MANTLE_SEPOLIA_RPC_URL;
const book = loadDeployments();
const PAD = book.memeLaunchpad as Address;
const USD = book.mockUsd;
const HOOK = book.agentPolicyHook;
const mUSD = (n: number) => parseUnits(String(n), 6);
const human = (base: bigint) => formatUnits(base, 6);

const MNEMONIC = "test test test test test test test test test test test junk";
const RELAYER = mnemonicToAccount(MNEMONIC, { addressIndex: 1 });
const MARKET = mnemonicToAccount(MNEMONIC, { addressIndex: 2 });
const RELAYER_KEY = toHex(RELAYER.getHdKey().privateKey as Uint8Array);

const ROOT_PASSWORD = "root-password";
const AGENT_PASSWORD = "agent-password";
/** Symbols unique to this run, so a symbol never matches a token already on Sepolia. */
const TAG = Math.random().toString(36).slice(2, 7).toUpperCase();
const SYMBOL = `GATE${TAG}`;
const FILL = `FILL${TAG}`;
const QUOTE_BUY = encodeFunctionData({
  abi: memeLaunchpadAbi,
  functionName: "quoteBuy",
  args: [PAD, 0n],
}).slice(0, 10);

/**
 * A JSON-RPC proxy in front of the fork for one CLI run. Once armed, the next `quoteBuy` eth_call
 * is answered with the fork's reply only after `move` ran (another trader's buy), so the price
 * moves between the CLI's quote and its send: a deterministic slippage race.
 */
async function raceProxy(target: string) {
  let armed: (() => Promise<void>) | undefined;
  let fired = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const reply = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }).then((r) => r.text());
    const msgs = [JSON.parse(body)].flat() as { method: string; params?: [{ data?: string }] }[];
    const move = armed;
    if (
      move &&
      msgs.some((m) => m.method === "eth_call" && m.params?.[0]?.data?.startsWith(QUOTE_BUY))
    ) {
      armed = undefined;
      fired++;
      await move();
    }
    res.setHeader("content-type", "application/json");
    res.end(reply);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    arm: (move: () => Promise<void>) => {
      armed = move;
    },
    fired: () => fired,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Every file under `dir`, recursively. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

describe.skipIf(!rpcUrl)(
  "command mode release gate: §9.1 items 1, 2, 4, 5, 6 through the CLIs (fork)",
  { timeout: 180_000 },
  () => {
    let stopFork: (() => void) | undefined;
    let sponsor: Awaited<ReturnType<typeof startSponsor>> | undefined;
    let proxy: Awaited<ReturnType<typeof raceProxy>> | undefined;
    let forkUrl: string;
    let client: ReturnType<typeof publicClient>;
    const rootKey = generatePrivateKey();
    const me = privateKeyToAddress(rootKey);
    const dir = mkdtempSync(join(tmpdir(), "meme-gate-fork-"));
    const rootHome = join(dir, "root");
    const agentHome = join(dir, "agent");
    let rootEnv: Record<string, string>;
    let agentEnv: Record<string, string>;
    let policyInit: Ran;
    let accountInit: Ran;
    let exported: Ran;
    let minted: Ran;
    /** Protocol fees and block before any trade of this run. */
    let startBlock: bigint;
    let startProtocolFees: bigint;
    /** The agent's own token; a market token bought close to completion. */
    let token: Address;
    let fillToken: Address;
    /** The agent's buys and sells of `token`, from chain receipts: quote in, tokens. */
    const ledger: { quote: bigint; tokens: bigint; side: "buy" | "sell" }[] = [];

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
    const padRead = <F extends "creatorFees" | "protocolFees" | "curveState">(
      functionName: F,
      args: readonly Address[] = [],
      // biome-ignore lint/suspicious/noExplicitAny: one reader for three views
    ): Promise<any> =>
      client.readContract({ address: PAD, abi: memeLaunchpadAbi, functionName, args } as never);
    const curve = (t: Address) => padRead("curveState", [t]);

    async function receipt(hash: Hex): Promise<TransactionReceipt> {
      for (const until = Date.now() + 30_000; ; await sleep(50)) {
        const r = await client.getTransactionReceipt({ hash }).catch(() => undefined);
        if (r) return r;
        if (Date.now() > until) throw new Error(`no receipt for ${hash} within 30 s`);
      }
    }

    /** Another trader: a plain EOA paying its own gas. */
    async function market(call: { to: Address; data: Hex }) {
      const wallet = createWalletClient({
        account: MARKET,
        chain: mantleSepolia,
        transport: http(forkUrl),
      });
      const r = await receipt(await wallet.sendTransaction(call));
      expect(r.status).toBe("success");
      return r;
    }

    async function marketBuy(t: Address, amount: bigint) {
      return market(
        buyCall(PAD, {
          token: t,
          amount,
          minOut: 0n,
          deadline: (await client.getBlock()).timestamp + 300n,
          recipient: MARKET.address,
        }),
      );
    }

    /** The launchpad's `Trade` logs of a sponsored transaction of this account. */
    async function agentTrades(hash: Hex) {
      const rc = await receipt(hash);
      expect(rc.status).toBe("success");
      expect(getAddress(rc.from)).toBe(RELAYER.address);
      return parseEventLogs({ abi: memeLaunchpadAbi, eventName: "Trade", logs: rc.logs }).filter(
        (l) => getAddress(l.address) === PAD && getAddress(l.args.trader) === me,
      );
    }

    function ok(r: Ran, command: string) {
      expect(r.code, r.stderr || r.stdout).toBe(0);
      expect(r.json).toMatchObject({ ok: true, command });
      return r.json.result;
    }

    function fails(r: Ran, command: string, exitCode: number, code: string) {
      expect(r.code, r.stderr || r.stdout).toBe(exitCode);
      expect(r.json).toMatchObject({ ok: false, command, exitCode, error: { code } });
      return r.json.error;
    }

    /** What a refusal must leave untouched: limit, balances, inventory, journal. */
    async function snapshot() {
      return {
        limit: await hookRead("remainingLimit", USD),
        usd: await balanceOf(USD),
        inventory: await hookRead("inventory", token),
        tokens: await balanceOf(token),
        journal: readJournal(agentHome).length,
      };
    }

    /** No root key in the agent home: only the agent's keystore and profile, nothing of the root's. */
    function assertNoRootKeyInAgentHome() {
      const profiles = Object.values(readProfiles({ home: agentHome }));
      expect(profiles.map((p) => p.role)).toEqual(["agent"]);
      expect(readdirSync(join(agentHome, "keys"))).toEqual(["trader.json"]);
      const agentKeystore = JSON.parse(
        readFileSync(join(agentHome, "keys", "trader.json"), "utf8"),
      );
      expect(getAddress(`0x${agentKeystore.address}`)).not.toBe(me);
      const rootKeystore = JSON.parse(readFileSync(join(rootHome, "keys", "owner.json"), "utf8"));
      expect(getAddress(`0x${rootKeystore.address}`)).toBe(me);
      const rootCipher = rootKeystore.crypto.ciphertext as string;
      expect(rootCipher.length).toBeGreaterThan(0);
      for (const f of filesUnder(agentHome)) {
        const text = readFileSync(f, "utf8").toLowerCase();
        expect(text, f).not.toContain(rootKey.slice(2).toLowerCase());
        expect(text, f).not.toContain(rootCipher.toLowerCase());
      }
      return getAddress(`0x${agentKeystore.address}`);
    }

    beforeAll(async () => {
      const fork = await startFork(rpcUrl as string);
      stopFork = fork.stop;
      forkUrl = fork.url;
      client = publicClient(fork.url);
      startBlock = await client.getBlockNumber();
      startProtocolFees = await padRead("protocolFees");
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
      proxy = await raceProxy(fork.url);
      const chain = { MANTLE_AA_RPC_URL: fork.url, MANTLE_AA_SPONSOR_URL: sponsor.url };
      rootEnv = { ...chain, MANTLE_AA_HOME: rootHome, MANTLE_AA_KEYSTORE_PASSWORD: ROOT_PASSWORD };
      agentEnv = {
        ...chain,
        MANTLE_AA_HOME: agentHome,
        MANTLE_AA_KEYSTORE_PASSWORD: AGENT_PASSWORD,
      };

      // Another trader: MockUSD, and a token bought most of the way to completion.
      const mint = parseAbi(["function mint(address to, uint256 amount)"]);
      await market({
        to: USD,
        data: encodeFunctionData({ abi: mint, args: [MARKET.address, mUSD(10_000)] }),
      });
      await market(approveCall(USD, PAD, maxUint256));
      const salt = randomSalt();
      await market(createTokenCall(PAD, { name: `${FILL} coin`, symbol: FILL, salt }));
      fillToken = predictTokenAddress(PAD, MARKET.address, salt, `${FILL} coin`, FILL);
      // Filling the curve takes ≈ 606 mUSD gross (DESIGN §4.2); 600 leaves ≈ 6 mUSD to completion.
      await marketBuy(fillToken, mUSD(600));

      // The human, in the root terminal (DESIGN §8.1), with the root key on stdin.
      ok(await aa(["keys", "import", "--name", "owner"], rootEnv, rootKey), "keys import");
      policyInit = await mantleMeme(
        [
          "policy",
          "init",
          "--total",
          "100",
          "--per-day",
          "100",
          "--expiry",
          "24h",
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
    }, 300_000);

    afterAll(async () => {
      await proxy?.close();
      await sponsor?.close();
      stopFork?.();
    }, 30_000);

    // ---- §9.1 item 1: human setup -------------------------------------------------------------

    it("item 1: policy init → account init --grant → session export → mint, all sponsored", async () => {
      expect(ok(accountInit, "account init")).toMatchObject({
        account: me,
        state: "INITIALIZED",
        session: { profile: "trader" },
      });
      expect(ok(exported, "session export")).toMatchObject({ role: "agent" });
      ok(minted, "account exec");
      expect(await balanceOf(USD)).toBe(mUSD(100));
      expect(await hookRead("remainingLimit", USD)).toBe(mUSD(100));
      expect(await client.getBalance({ address: me })).toBe(0n);
    });

    it("item 1: the agent home holds no root key (start of the run); account commands are refused there", async () => {
      const agentKey = assertNoRootKeyInAgentHome();
      expect(await client.getBalance({ address: agentKey })).toBe(0n);
      fails(await aa(["account", "status"], agentEnv), "account status", 1, "USAGE");
    });

    // ---- §9.1 item 2: agent home only --------------------------------------------------------

    it("item 2: create --dev-buy creates the token and buys it in one sponsored batch", async () => {
      const r = ok(
        await meme("create", "--name", "Gate coin", "--symbol", SYMBOL, "--dev-buy", "5"),
        "create",
      );
      token = r.token;
      const trades = await agentTrades(r.hash);
      expect(trades).toHaveLength(1);
      const t = trades[0]?.args as NonNullable<(typeof trades)[0]>["args"];
      expect(getAddress(t.token)).toBe(token);
      expect(t.quoteAmount).toBe(mUSD(5));
      expect(r.devBuy).toMatchObject({
        spent: { base: "5000000" },
        tokens: { base: t.tokenAmount.toString() },
        fee: { base: t.fee.toString() },
      });
      expect((await curve(token)).creator).toBe(me);
      expect(await hookRead("inventory", token)).toBe(t.tokenAmount);
      expect(await hookRead("remainingLimit", USD)).toBe(mUSD(95));
      ledger.push({ side: "buy", quote: t.quoteAmount, tokens: t.tokenAmount });
    });

    it("item 2: buy <symbol> spends the amount and credits the session's inventory", async () => {
      const r = ok(await meme("buy", SYMBOL, "--amount", "2"), "buy");
      const [trade] = await agentTrades(r.hash);
      expect(r).toMatchObject({
        token,
        spent: { base: "2000000" },
        tokens: { base: trade?.args.tokenAmount.toString() },
        completes: false,
      });
      expect(BigInt(r.tokens.base)).toBeGreaterThanOrEqual(BigInt(r.minOut.base));
      expect(await hookRead("remainingLimit", USD)).toBe(mUSD(93));
      expect(await hookRead("inventory", token)).toBe(
        (ledger[0]?.tokens ?? 0n) + BigInt(r.tokens.base),
      );
      ledger.push({ side: "buy", quote: mUSD(2), tokens: BigInt(r.tokens.base) });
    });

    it("item 2: sell --percent 50 sells half of the inventory and pays the account", async () => {
      const held = await hookRead("inventory", token);
      const usdBefore = await balanceOf(USD);
      const r = ok(await meme("sell", SYMBOL, "--percent", "50"), "sell");
      const [trade] = await agentTrades(r.hash);
      expect(trade?.args).toMatchObject({ isBuy: false, tokenAmount: held / 2n });
      expect(r.sold.base).toBe((held / 2n).toString());
      expect(r.received.base).toBe(trade?.args.quoteAmount.toString());
      expect(await balanceOf(USD)).toBe(usdBefore + (trade?.args.quoteAmount ?? 0n));
      expect(await hookRead("inventory", token)).toBe(held - held / 2n);
      ledger.push({ side: "sell", quote: trade?.args.quoteAmount ?? 0n, tokens: held / 2n });
    });

    it("item 2: quote, info and list agree with the chain", async () => {
      const qb = await quoteBuy(client, PAD, token, mUSD(3));
      expect(ok(await meme("quote", SYMBOL, "--buy", "3"), "quote")).toMatchObject({
        side: "buy",
        amountIn: { base: qb.amountInUsed.toString() },
        amountOut: { base: qb.amountOut.toString() },
        fee: { base: qb.feeUsed.toString() },
        completes: false,
      });
      const qs = await quoteSell(client, PAD, token, parseUnits("1000", 18));
      expect(ok(await meme("quote", token, "--sell", "1000"), "quote")).toMatchObject({
        side: "sell",
        amountOut: { base: qs.amountOut.toString() },
        fee: { base: qs.fee.toString() },
      });
      const s = await curve(token);
      const info = ok(await meme("info", SYMBOL), "info");
      expect(info).toMatchObject({
        address: token,
        symbol: SYMBOL,
        status: "trading",
        creator: me,
        price: { priceE18: s.priceE18.toString() },
        sold: { base: s.sold.toString() },
        raised: { base: s.realQuote.toString() },
        creatorFees: { base: (await padRead("creatorFees", [token])).toString() },
      });
      const list = ok(await meme("list", "--limit", "2"), "list");
      expect(list.tokens.map((t: { address: string }) => t.address)).toEqual([token, fillToken]);
      expect(list.tokens[0]).toMatchObject({
        sold: { base: s.sold.toString() },
        status: "trading",
      });
    });

    it("item 2: portfolio equals chain state; its cost basis equals the chain's trades", async () => {
      const r = ok(await meme("portfolio"), "portfolio");
      const inventory = await hookRead("inventory", token);
      // Weighted cost of what is left, from the agent's own Trade logs (independent of the journal).
      let held = 0n;
      let cost = 0n;
      for (const x of ledger) {
        if (x.side === "buy") [held, cost] = [held + x.tokens, cost + x.quote];
        else [held, cost] = [held - x.tokens, cost - (cost * x.tokens) / held];
      }
      expect(held).toBe(inventory);
      const sellValue = (await quoteSell(client, PAD, token, inventory)).amountOut;
      expect(r).toMatchObject({
        account: me,
        keyHash: keyHash(),
        session: { initialized: true, active: true, revoked: false },
        quote: {
          balance: { base: (await balanceOf(USD)).toString() },
          remainingLimit: { base: (await hookRead("remainingLimit", USD)).toString() },
        },
      });
      expect(r.positions).toEqual([
        expect.objectContaining({
          token,
          status: "trading",
          balance: expect.objectContaining({ base: (await balanceOf(token)).toString() }),
          inventory: expect.objectContaining({ base: inventory.toString() }),
          costBasis: expect.objectContaining({ base: cost.toString() }),
          sellValue: expect.objectContaining({ base: sellValue.toString() }),
          unrealisedPnl: expect.objectContaining({ base: (sellValue - cost).toString() }),
        }),
      ]);
      // The journal holds exactly the agent's trades, as the chain recorded them.
      expect(
        readJournal(agentHome).map((j) => ({
          side: j.side,
          quote: j.quotePulled,
          tokens: j.tokens,
        })),
      ).toEqual(ledger);
    });

    // ---- §9.1 item 6: refusals (44 belongs to 0.1.2) ----------------------------------------

    it("item 6: a MockUSD transfer from the agent home is exit 10 (mantle-aa agent exec)", async () => {
      const before = await snapshot();
      const transfer = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [MARKET.address, mUSD(1)],
      });
      const r = await aa(
        [
          "agent",
          "exec",
          "--agent",
          "trader",
          "--calls",
          JSON.stringify([{ to: USD, data: transfer }]),
        ],
        agentEnv,
      );
      fails(r, "agent exec", 10, "POLICY_VIOLATION");
      expect(await snapshot()).toEqual(before);
    });

    it("item 6: selling more than the session bought is exit 12", async () => {
      const before = await snapshot();
      const over = formatUnits(before.inventory + 1n, 18);
      const err = fails(
        await meme("sell", SYMBOL, "--amount", over),
        "sell",
        12,
        "INVENTORY_EXCEEDED",
      );
      expect(err).toMatchObject({ held: before.inventory.toString() });
      expect(await snapshot()).toEqual(before);
    });

    it("item 6: an unknown token is exit 42", async () => {
      const before = await snapshot();
      fails(await meme("buy", `NOPE${TAG}`, "--amount", "1"), "buy", 42, "UNKNOWN_TOKEN");
      fails(
        await meme("buy", "0x000000000000000000000000000000000000dEaD", "--amount", "1"),
        "buy",
        42,
        "UNKNOWN_TOKEN",
      );
      expect(await snapshot()).toEqual(before);
    });

    it("item 6: the price moving past --slippage between quote and send is exit 41", async () => {
      const before = await snapshot();
      const p = proxy as NonNullable<typeof proxy>;
      // Another trader buys 50 mUSD right after the CLI read its quote.
      p.arm(async () => {
        await marketBuy(token, mUSD(50));
      });
      const r = await mantleMeme(["buy", SYMBOL, "--amount", "1", "--slippage", "1", "--json"], {
        ...agentEnv,
        MANTLE_AA_RPC_URL: p.url,
      });
      expect(p.fired()).toBe(1);
      fails(r, "buy", 41, "SLIPPAGE");
      expect(await snapshot()).toEqual(before);
    });

    it("item 6: a buy over the remaining limit is exit 11", async () => {
      const before = await snapshot();
      const over = human(before.limit + mUSD(1));
      const err = fails(await meme("buy", SYMBOL, "--amount", over), "buy", 11, "LIMIT_EXCEEDED");
      expect(err).toMatchObject({ remaining: before.limit.toString() });
      expect(await snapshot()).toEqual(before);
    });

    // ---- §9.1 item 2 clamp case and item 4: the completing buy --------------------------------

    it("items 2 + 4: a completing buy over the limit is clamped, charged exactly amountInUsed, and completes the curve", async () => {
      const limit = await hookRead("remainingLimit", USD);
      const usdBefore = await balanceOf(USD);
      const requested = limit + mUSD(1);
      const before = await curve(fillToken);
      const q = await quoteBuy(client, PAD, fillToken, requested);
      // The premise: remaining limit strictly between amountInUsed and the requested amount.
      expect(q.completes).toBe(true);
      expect(q.amountInUsed).toBeLessThan(limit);
      expect(limit).toBeLessThan(requested);
      const remainingTokens = parseUnits("800000000", 18) - before.sold;

      const r = ok(await meme("buy", FILL, "--amount", human(requested)), "buy");
      expect(r).toMatchObject({
        token: fillToken,
        requested: { base: requested.toString() },
        spent: { base: q.amountInUsed.toString() },
        tokens: { base: remainingTokens.toString() },
        completes: true,
      });
      const rc = await receipt(r.hash);
      expect(
        parseEventLogs({ abi: memeLaunchpadAbi, eventName: "CurveCompleted", logs: rc.logs }).map(
          (l) => getAddress(l.args.token),
        ),
      ).toEqual([fillToken]);
      expect(await hookRead("remainingLimit", USD)).toBe(limit - q.amountInUsed);
      expect(await balanceOf(USD)).toBe(usdBefore - q.amountInUsed);
      expect(await hookRead("inventory", fillToken)).toBe(remainingTokens);
      const after = await curve(fillToken);
      expect(after.status).toBe(2); // Completed
      expect(after.sold).toBe(parseUnits("800000000", 18));
    });

    it("item 4: after completion buy and sell are exit 40 with the stranded text", async () => {
      const before = await snapshot();
      const held = await hookRead("inventory", fillToken);
      for (const r of [
        await meme("buy", FILL, "--amount", "1"),
        await meme("sell", FILL, "--all"),
      ]) {
        expect(fails(r, r.json.command, 40, "CURVE_COMPLETED").message).toBe(CURVE_COMPLETED_TEXT);
      }
      expect(ok(await meme("info", FILL), "info")).toMatchObject({
        status: "completed",
        progressPercent: 100,
        notice: CURVE_COMPLETED_TEXT,
      });
      const position = ok(await meme("portfolio"), "portfolio").positions.find(
        (x: { token: string }) => x.token === fillToken,
      );
      expect(position).toMatchObject({
        status: "completed",
        inventory: { base: held.toString() },
        sellValue: null,
        notice: CURVE_COMPLETED_TEXT,
      });
      expect(await snapshot()).toEqual(before);
    });

    // ---- §9.1 item 5: fees -----------------------------------------------------------------

    it("item 5: claim pays the creator share of every trade on the agent's token", async () => {
      const logs = await client.getContractEvents({
        address: PAD,
        abi: memeLaunchpadAbi,
        eventName: "Trade",
        args: { token },
        fromBlock: startBlock + 1n,
      });
      // The agent's own trades and the other trader's race buy.
      expect(logs.length).toBe(ledger.length + 1);
      const share = logs.reduce((s, l) => s + (l.args.fee as bigint) / 2n, 0n);
      expect(await padRead("creatorFees", [token])).toBe(share);
      const usdBefore = await balanceOf(USD);
      const r = ok(await meme("claim", SYMBOL), "claim");
      expect(r.total.base).toBe(share.toString());
      await agentTrades(r.hash);
      expect(await balanceOf(USD)).toBe(usdBefore + share);
      expect(await padRead("creatorFees", [token])).toBe(0n);
    });

    it("item 5: claimProtocolFees pays the treasury the protocol share of every trade", async () => {
      const logs = await client.getContractEvents({
        address: PAD,
        abi: memeLaunchpadAbi,
        eventName: "Trade",
        fromBlock: startBlock + 1n,
      });
      const share = logs.reduce(
        (s, l) => s + (l.args.fee as bigint) - (l.args.fee as bigint) / 2n,
        0n,
      );
      const due = await padRead("protocolFees");
      expect(due).toBe(startProtocolFees + share);
      const treasury = await client.readContract({
        address: PAD,
        abi: memeLaunchpadAbi,
        functionName: "treasury",
      });
      const before = await balanceOf(USD, treasury);
      const rc = await market({
        to: PAD,
        data: encodeFunctionData({ abi: memeLaunchpadAbi, functionName: "claimProtocolFees" }),
      });
      expect(
        parseEventLogs({
          abi: memeLaunchpadAbi,
          eventName: "ProtocolFeesClaimed",
          logs: rc.logs,
        })[0]?.args.amount,
      ).toBe(due);
      expect(await balanceOf(USD, treasury)).toBe(before + due);
      expect(await padRead("protocolFees")).toBe(0n);
    });

    // ---- §9.1 item 1, end of the run ---------------------------------------------------------

    it("item 1: the human and the agent held 0 MNT; the agent home still holds no root key (end of the run)", async () => {
      const agentKey = assertNoRootKeyInAgentHome();
      expect(await client.getBalance({ address: me })).toBe(0n);
      expect(await client.getBalance({ address: agentKey })).toBe(0n);
      // Every transaction the agent made was sent by the sponsor's relayer.
      for (const j of readJournal(agentHome)) {
        expect(getAddress((await receipt(j.txHash)).from)).toBe(RELAYER.address);
      }
    });
  },
);
