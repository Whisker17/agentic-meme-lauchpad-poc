import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { HOME_ENV, RPC_URL_ENV, SPONSOR_URL_ENV, UsageError } from "@0xwh1sker/mantle-aa-cli";
import {
  type AgentSession,
  agentPolicyHookAbi,
  getChain,
  InventoryExceededError,
  PASSWORD_ENV,
  RelayerExecutor,
  readProfiles,
  redactUrls,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  agentProfile,
  CurveCompletedError,
  claimCall,
  createTokenCall,
  curveState,
  DEFAULT_DEADLINE_SECONDS,
  DESIGN_CURVE_PARAMS,
  execute,
  initialReserves,
  listTokens,
  loadDeployments as loadMemeDeployments,
  type MemeAddressBook,
  memeLaunchpadAbi,
  memeTokenAbi,
  minOutFor,
  openAgentSession,
  planBuy,
  portfolio,
  predictTokenAddress,
  quoteBuy,
  quoteSell,
  randomSalt,
  readCurveParams,
  resolveToken,
  scanTokens,
  sellCall,
  simulateBuy,
  type TokenInfo,
  tokenCount,
  watch,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  type Client,
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  getAddress,
  type Hex,
  http,
  isAddressEqual,
  parseAbi,
  parseEventLogs,
  parseUnits,
} from "viem";
import { getBlock, readContract } from "viem/actions";
import { CURVE_COMPLETED_TEXT, describe } from "./errors.js";
import { policyFile, SESSION_TTL_SECONDS } from "./policy.js";

/** MockUSD and meme token decimals. */
const QUOTE_DECIMALS = 6;
const TOKEN_DECIMALS = 18;

const USAGE = `usage: mantle-meme <command> [options]

  policy init  --total <mUSD> --per-day <mUSD> [--expiry 24h] [--out policy.json]
  create       --name <name> --symbol <symbol> [--description <text>] [--image-url <url>]
               [--dev-buy <mUSD>] [--slippage 5]
  buy          <token> --amount <mUSD> [--slippage 5]
  sell         <token> (--amount <tokens> | --percent <n> | --all) [--slippage 5]
  quote        <token> (--buy <mUSD> | --sell <tokens>)
  list         [--status trading|completed] [--limit 20] [--since <duration>]
  info         <token>
  watch        [--from-block <n>]                (JSON lines on stdout until interrupted)
  portfolio
  claim        <token> | --all

  <token> is an address or a symbol. Amounts are human units (mUSD, tokens); --slippage is a
  percentage; durations are <n>s|m|h|d.

options:  --json  --agent <name> (the agent profile; default: the only one)
env:      ${RPC_URL_ENV}, ${SPONSOR_URL_ENV}, ${HOME_ENV}, ${PASSWORD_ENV}
exit:     0 ok, 10 policy, 11 limit, 12 inventory, 13 key expired/revoked,
          20 sponsor rejected, 21 sponsor busy, 30 reverted,
          40 curve completed, 41 slippage, 42 unknown token, 43 insufficient balance, 1 other
`;

export interface CliIO {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Stops `watch` (besides SIGINT / SIGTERM). */
  signal?: AbortSignal;
}

type Values = Record<string, string | boolean | undefined>;

/** Returned by a command that printed its own output (`watch`). */
const PRINTED = Symbol("printed");

// ---- parsing ----------------------------------------------------------------------------------

const str = (v: Values, name: string) => {
  const value = v[name];
  return typeof value === "string" ? value : undefined;
};

const required = (v: Values, name: string) => {
  const value = str(v, name);
  if (value === undefined || value === "") throw new UsageError(`--${name} is required`);
  return value;
};

/** A non-negative decimal in `decimals` base units; `positive` refuses zero. */
function units(value: string, decimals: number, flag: string, positive = true): bigint {
  const [, fraction = ""] = value.split(".");
  if (!/^\d+(\.\d+)?$/.test(value) || fraction.length > decimals) {
    throw new UsageError(`--${flag} must be a decimal number with at most ${decimals} decimals`);
  }
  const base = parseUnits(value, decimals);
  if (positive && base === 0n) throw new UsageError(`--${flag} must be greater than 0`);
  return base;
}

const usdIn = (v: Values, flag: string) => units(required(v, flag), QUOTE_DECIMALS, flag);
const tokensIn = (v: Values, flag: string) => units(required(v, flag), TOKEN_DECIMALS, flag);

/** `--slippage <percent>` in basis points; default 5%. */
function slippageBps(v: Values): number {
  const bps = units(str(v, "slippage") ?? "5", 2, "slippage", false);
  if (bps > 10_000n) throw new UsageError("--slippage must be at most 100");
  return Number(bps);
}

/** `<n>s|m|h|d` in seconds. */
function duration(value: string, flag: string): number {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (!m) throw new UsageError(`--${flag} must be a duration such as 30m, 24h or 7d`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as "s" | "m" | "h" | "d"];
}

function integer(value: string, flag: string, min: bigint, max?: bigint): bigint {
  if (!/^\d+$/.test(value)) throw new UsageError(`--${flag} must be an integer`);
  const n = BigInt(value);
  if (n < min || (max !== undefined && n > max)) {
    throw new UsageError(`--${flag} must be in [${min}, ${max ?? "∞"}]`);
  }
  return n;
}

// ---- output -----------------------------------------------------------------------------------

/** An amount in human and base units. */
const usd = (base: bigint) => ({ human: formatUnits(base, QUOTE_DECIMALS), base });
const tok = (base: bigint) => ({ human: formatUnits(base, TOKEN_DECIMALS), base });
const orNull = <T>(value: bigint | null, f: (b: bigint) => T) => (value === null ? null : f(value));

const toJson = (value: unknown, indent?: number) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), indent);

/** The curve of a token for `list` / `info`; a completed curve carries the §4.5 notice. */
function tokenView(t: TokenInfo) {
  return {
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    status: t.status,
    creator: t.creator,
    createdAt: Number(t.createdAt),
    /** mUSD per whole token; `priceE18` as the contract reports it. */
    price: { human: formatUnits(t.priceE18, QUOTE_DECIMALS + 18), priceE18: t.priceE18 },
    sold: tok(t.sold),
    progressPercent: Number((t.sold * 10_000n) / DESIGN_CURVE_PARAMS.curveSupply) / 100,
    raised: usd(t.realQuote),
    ...(t.status === "completed" && { notice: CURVE_COMPLETED_TEXT }),
  };
}

// ---- context ----------------------------------------------------------------------------------

/** Settings (from the AA CLI's environment), the chain client and the agent session of one run. */
class Context {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  #book: (MemeAddressBook & { memeLaunchpad: Address }) | undefined;
  #client: Client | undefined;

  constructor(
    readonly io: Required<Pick<CliIO, "stdout" | "stderr">> & CliIO,
    readonly values: Values,
  ) {
    this.env = io.env ?? process.env;
    this.home = this.env[HOME_ENV] || join(this.env.HOME || homedir(), ".mantle-aa");
  }

  get book() {
    if (!this.#book) {
      const book = loadMemeDeployments();
      if (!book.memeLaunchpad) throw new Error("No MemeLaunchpad in the address book");
      this.#book = { ...book, memeLaunchpad: book.memeLaunchpad };
    }
    return this.#book;
  }

  get pad(): Address {
    return this.book.memeLaunchpad;
  }

  client(): Client {
    if (!this.#client) {
      const url = this.env[RPC_URL_ENV];
      if (!url) throw new UsageError(`no RPC URL: set ${RPC_URL_ENV}`);
      this.#client = createPublicClient({
        chain: getChain(this.book.chainId),
        transport: http(url),
      });
    }
    return this.#client;
  }

  /** The agent profile (`--agent`, else the only one) of the home; no password needed. */
  profile() {
    try {
      return agentProfile(this.home, str(this.values, "agent"));
    } catch (e) {
      throw new UsageError(`${(e as Error).message} (${HOME_ENV} is the agent home)`);
    }
  }

  /** The session that signs and sends through the sponsor. */
  session(): AgentSession {
    const { name } = this.profile();
    const url = this.env[SPONSOR_URL_ENV];
    if (!url) throw new UsageError(`no sponsor: set ${SPONSOR_URL_ENV}`);
    const password = this.env[PASSWORD_ENV];
    if (!password) throw new UsageError(`no keystore password: set ${PASSWORD_ENV}`);
    const client = this.client();
    return openAgentSession({
      home: this.home,
      agent: name,
      password,
      client,
      executor: new RelayerExecutor({ client, url, addresses: this.book }),
      addresses: this.book,
    });
  }

  /** A launchpad `deadline`: 300 s after the chain's latest block. */
  async deadline(): Promise<bigint> {
    return (await getBlock(this.client())).timestamp + DEFAULT_DEADLINE_SECONDS;
  }

  /** Sends a batch: lock, simulate, sponsor, receipt, journal (meme-sdk `execute`). */
  send(session: AgentSession, calls: Parameters<typeof execute>[0]["calls"]) {
    return execute({ session, client: this.client(), home: this.home, launchpad: this.pad, calls });
  }

  tx(hash: Hex) {
    const explorer = getChain(this.book.chainId).blockExplorers?.default.url;
    return { hash, explorer: explorer ? `${explorer}/tx/${hash}` : null };
  }

  /** `<token>` (address or symbol) resolved through the registry, with its curve. */
  async token(query: string | undefined): Promise<TokenInfo> {
    if (!query) throw new UsageError("<token> is required");
    const client = this.client();
    const address = await resolveToken(client, this.pad, query);
    const read = (functionName: "name" | "symbol") =>
      readContract(client, { address, abi: memeTokenAbi, functionName });
    const [name, symbol, state] = await Promise.all([
      read("name"),
      read("symbol"),
      curveState(client, this.pad, address),
    ]);
    return { address, name, symbol, ...state };
  }

  /** As `token`, refusing a curve that no longer trades (exit 40). */
  async tradable(query: string | undefined): Promise<TokenInfo> {
    const t = await this.token(query);
    if (t.status !== "trading") throw new CurveCompletedError();
    return t;
  }

  /** The session key's inventory of `token` on the hook: what it bought and may sell. */
  inventory(session: AgentSession, token: Address): Promise<bigint> {
    return readContract(this.client(), {
      address: this.book.agentPolicyHook,
      abi: agentPolicyHookAbi,
      functionName: "inventory",
      args: [session.keyHash, session.account, token],
    });
  }
}

// ---- commands ---------------------------------------------------------------------------------

interface Command {
  options?: NonNullable<ParseArgsConfig["options"]>;
  /** Takes a `<token>` positional. */
  token?: boolean;
  run(ctx: Context, v: Values, token: string | undefined): Promise<unknown>;
  /** Plain-text output without `--json`; default: the result as indented JSON. */
  text?(result: never): string;
}

const S = { type: "string" } as const;
const B = { type: "boolean" } as const;
const mint = parseAbi(["function mint(address to, uint256 amount)"]);

const COMMANDS: Record<string, Command> = {
  "policy init": {
    options: { total: S, "per-day": S, expiry: S, out: S },
    async run(ctx, v) {
      const total = usdIn(v, "total");
      const perDay = usdIn(v, "per-day");
      if (perDay > total) throw new UsageError("--per-day must not exceed --total");
      const expiry = duration(str(v, "expiry") ?? "24h", "expiry");
      if (expiry !== SESSION_TTL_SECONDS) {
        throw new UsageError(
          `--expiry must be 24h: mantle-aa grants session keys for ${SESSION_TTL_SECONDS} s and its policy file carries no expiry`,
        );
      }
      const { mockUsd, memeLaunchpad } = ctx.book;
      const policy = policyFile({
        quoteToken: mockUsd,
        launchpad: memeLaunchpad,
        total,
        perDay,
      });
      const file = resolve(str(v, "out") ?? "policy.json");
      writeFileSync(file, `${JSON.stringify(policy, null, 2)}\n`);

      // The human's next steps (DESIGN §8.1), in the root home this terminal points at.
      const agent = str(v, "agent") ?? "trader";
      const roots = Object.values(readProfiles({ home: ctx.home })).filter(
        (p) => p.role === "root",
      );
      const account =
        roots.length === 1 ? getAddress((roots[0] as { account: string }).account) : null;
      // MockUSD is mintable by anyone; the account mints to itself, sponsored.
      const mintCall = account
        ? `'[{"to":"${mockUsd}","data":"${encodeFunctionData({ abi: mint, args: [account, total] })}"}]'`
        : `"[{\\"to\\":\\"${mockUsd}\\",\\"data\\":\\"$(cast calldata 'mint(address,uint256)' <account> ${total})\\"}]"`;
      const next = [
        ...(roots.length === 0 ? ["mantle-aa keys new --name owner"] : []),
        `mantle-aa account init --grant ${file} --agent ${agent}`,
        `mantle-aa session export --agent ${agent} --out ~/.mantle-meme-agent`,
        `mantle-aa account exec --calls ${mintCall}`,
      ];
      return { file, agent, expirySeconds: expiry, policy, next };
    },
    text: (r: { file: string; agent: string; next: string[] }) =>
      [
        `Wrote ${r.file}`,
        "",
        "Next, in the root terminal (MANTLE_AA_HOME = the root home; an initialised account grants",
        `with: mantle-aa session grant --agent ${r.agent} --policy ${r.file}):`,
        ...r.next.map((c) => `  ${c}`),
        "",
        "Then run the agent with MANTLE_AA_HOME=~/.mantle-meme-agent and its own keystore password",
        "(MANTLE_AA_KEYSTORE_PASSWORD = the export password).",
        "",
      ].join("\n"),
  },

  create: {
    options: {
      name: S,
      symbol: S,
      description: S,
      "image-url": S,
      "dev-buy": S,
      slippage: S,
    },
    async run(ctx, v) {
      const name = required(v, "name");
      const symbol = required(v, "symbol");
      const devBuy = str(v, "dev-buy") === undefined ? undefined : usdIn(v, "dev-buy");
      const slippage = slippageBps(v);
      const session = ctx.session();
      const client = ctx.client();
      const pad = ctx.pad;
      const salt = randomSalt();
      const predicted = predictTokenAddress(pad, session.account, salt, name, symbol);
      const calls = [
        createTokenCall(pad, {
          name,
          symbol,
          description: str(v, "description") ?? "",
          imageUrl: str(v, "image-url") ?? "",
          salt,
        }),
      ];
      let plan: ReturnType<typeof planBuy> | undefined;
      if (devBuy !== undefined) {
        // The token does not exist yet: quote the buy on the launch curve.
        const params = await readCurveParams(client, pad);
        plan = planBuy({
          launchpad: pad,
          quoteToken: ctx.book.mockUsd,
          token: predicted,
          recipient: session.account,
          amountIn: devBuy,
          quote: simulateBuy(params, initialReserves(params), devBuy),
          slippageBps: slippage,
          deadline: await ctx.deadline(),
        });
        calls.push(...plan.calls);
      }
      const { hash, receipt, trades } = await ctx.send(session, calls);
      const [created] = parseEventLogs({
        abi: memeLaunchpadAbi,
        eventName: "TokenCreated",
        logs: receipt.logs,
      }).filter((l) => isAddressEqual(l.address, pad));
      const token = created ? getAddress(created.args.token) : predicted;
      const trade = trades.find((t) => isAddressEqual(t.token, token));
      return {
        account: session.account,
        token,
        name,
        symbol,
        salt,
        ...ctx.tx(hash),
        devBuy:
          plan && trade
            ? {
                spent: usd(trade.quotePulled),
                tokens: tok(trade.tokens),
                fee: usd(trade.fee),
                minOut: tok(plan.minOut),
                completes: plan.completes,
              }
            : null,
      };
    },
  },

  buy: {
    token: true,
    options: { amount: S, slippage: S },
    async run(ctx, v, query) {
      const amountIn = usdIn(v, "amount");
      const slippage = slippageBps(v);
      const t = await ctx.tradable(query);
      const session = ctx.session();
      const plan = planBuy({
        launchpad: ctx.pad,
        quoteToken: ctx.book.mockUsd,
        token: t.address,
        recipient: session.account,
        amountIn,
        quote: await quoteBuy(ctx.client(), ctx.pad, t.address, amountIn),
        slippageBps: slippage,
        deadline: await ctx.deadline(),
      });
      const { hash, trades } = await ctx.send(session, plan.calls);
      const trade = trades[0];
      return {
        account: session.account,
        token: t.address,
        symbol: t.symbol,
        ...ctx.tx(hash),
        requested: usd(amountIn),
        spent: usd(trade?.quotePulled ?? plan.amountIn),
        tokens: tok(trade?.tokens ?? 0n),
        fee: usd(trade?.fee ?? 0n),
        minOut: tok(plan.minOut),
        completes: plan.completes,
      };
    },
  },

  sell: {
    token: true,
    options: { amount: S, percent: S, all: B, slippage: S },
    async run(ctx, v, query) {
      const sizes = ["amount", "percent", "all"].filter((k) => v[k] !== undefined);
      if (sizes.length !== 1)
        throw new UsageError("pass exactly one of --amount, --percent, --all");
      const slippage = slippageBps(v);
      const t = await ctx.tradable(query);
      const session = ctx.session();
      // Sized from this session's inventory on the hook, never the account's balance (DESIGN §7.1).
      const held = await ctx.inventory(session, t.address);
      let amount: bigint;
      if (v.all) amount = held;
      else if (v.percent !== undefined) {
        const bps = units(required(v, "percent"), 2, "percent");
        if (bps > 10_000n) throw new UsageError("--percent must be at most 100");
        amount = (held * bps) / 10_000n;
      } else amount = tokensIn(v, "amount");
      if (amount > held || held === 0n) {
        throw new InventoryExceededError({ token: t.address, held, requested: amount });
      }
      if (amount === 0n) throw new UsageError("the amount to sell rounds to 0 tokens");
      const quote = await quoteSell(ctx.client(), ctx.pad, t.address, amount);
      const minOut = minOutFor(quote.amountOut, slippage);
      const call = sellCall(ctx.pad, {
        token: t.address,
        amount,
        minOut,
        deadline: await ctx.deadline(),
        recipient: session.account,
      });
      const { hash, trades } = await ctx.send(session, [call]);
      const trade = trades[0];
      return {
        account: session.account,
        token: t.address,
        symbol: t.symbol,
        ...ctx.tx(hash),
        sold: tok(trade?.tokens ?? amount),
        received: usd(trade?.quotePulled ?? 0n),
        fee: usd(trade?.fee ?? 0n),
        minOut: usd(minOut),
        inventoryLeft: tok(held - amount),
      };
    },
  },

  quote: {
    token: true,
    options: { buy: S, sell: S },
    async run(ctx, v, query) {
      if ((v.buy === undefined) === (v.sell === undefined)) {
        throw new UsageError("pass exactly one of --buy <mUSD>, --sell <tokens>");
      }
      const amount = v.buy !== undefined ? usdIn(v, "buy") : tokensIn(v, "sell");
      const t = await ctx.tradable(query);
      const base = { token: t.address, symbol: t.symbol };
      if (v.buy !== undefined) {
        const q = await quoteBuy(ctx.client(), ctx.pad, t.address, amount);
        return {
          ...base,
          side: "buy",
          requested: usd(amount),
          amountIn: usd(q.amountInUsed),
          amountOut: tok(q.amountOut),
          fee: usd(q.feeUsed),
          completes: q.completes,
        };
      }
      const q = await quoteSell(ctx.client(), ctx.pad, t.address, amount);
      return {
        ...base,
        side: "sell",
        amountIn: tok(amount),
        amountOut: usd(q.amountOut),
        fee: usd(q.fee),
      };
    },
  },

  list: {
    options: { status: S, limit: S, since: S },
    async run(ctx, v) {
      const status = str(v, "status");
      if (status !== undefined && status !== "trading" && status !== "completed") {
        throw new UsageError("--status must be trading or completed");
      }
      const limit = integer(str(v, "limit") ?? "20", "limit", 1n, 100n);
      const since = str(v, "since");
      const client = ctx.client();
      const total = await tokenCount(client, ctx.pad);
      const after =
        since === undefined
          ? undefined
          : (await getBlock(client)).timestamp - BigInt(duration(since, "since"));
      // Newest first, a page at a time, over at most the newest 1000 tokens.
      const tokens: TokenInfo[] = [];
      const floor = total > 1000n ? total - 1000n : 0n;
      scan: for (let end = total; end > floor && BigInt(tokens.length) < limit; ) {
        const offset = end - limit > floor ? end - limit : floor;
        const page = await listTokens(client, ctx.pad, { offset, limit: end - offset });
        for (const t of page.reverse()) {
          if (after !== undefined && t.createdAt < after) break scan;
          if (status !== undefined && t.status !== status) continue;
          tokens.push(t);
          if (BigInt(tokens.length) === limit) break scan;
        }
        end = offset;
      }
      return { total, tokens: tokens.map(tokenView) };
    },
  },

  info: {
    token: true,
    async run(ctx, _v, query) {
      const t = await ctx.token(query);
      const creatorFees = await readContract(ctx.client(), {
        address: ctx.pad,
        abi: memeLaunchpadAbi,
        functionName: "creatorFees",
        args: [t.address],
      });
      return { ...tokenView(t), creatorFees: usd(creatorFees) };
    },
  },

  watch: {
    options: { "from-block": S },
    async run(ctx, v) {
      const from = str(v, "from-block");
      const fromBlock = from === undefined ? undefined : integer(from, "from-block", 0n);
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      ctx.io.signal?.addEventListener("abort", abort);
      try {
        for await (const log of watch(ctx.client(), ctx.pad, {
          ...(fromBlock !== undefined && { fromBlock }),
          signal: stop.signal,
          onError: (e) => ctx.io.stderr(`warning: ${redactUrls(describe(e).error.message)}\n`),
        })) {
          ctx.io.stdout(
            `${toJson({
              event: log.eventName,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              args: log.args,
            })}\n`,
          );
        }
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
        ctx.io.signal?.removeEventListener("abort", abort);
      }
      return PRINTED;
    },
  },

  portfolio: {
    async run(ctx) {
      const { name, profile } = ctx.profile();
      const p = await portfolio({
        client: ctx.client(),
        home: ctx.home,
        profile,
        addresses: { ...ctx.book, memeLaunchpad: ctx.pad },
      });
      return {
        agent: name,
        account: p.account,
        keyHash: p.keyHash,
        expiry: p.expiry,
        session: p.session,
        quote: {
          token: p.quote.token,
          balance: usd(p.quote.balance),
          remainingLimit: usd(p.quote.remainingLimit),
        },
        positions: p.positions.map((x) => ({
          token: x.token,
          symbol: x.symbol,
          status: x.status,
          balance: tok(x.balance),
          inventory: tok(x.inventory),
          costBasis: orNull(x.costBasis, usd),
          sellValue: orNull(x.sellValue, usd),
          unrealisedPnl: orNull(x.unrealisedPnl, usd),
          ...(x.status === "completed" && { notice: CURVE_COMPLETED_TEXT }),
        })),
      };
    },
  },

  claim: {
    token: true,
    options: { all: B },
    async run(ctx, v, query) {
      if (!v.all === !query) throw new UsageError("pass either <token> or --all");
      const session = ctx.session();
      const client = ctx.client();
      const pad = ctx.pad;
      const candidates = v.all ? await scanTokens(client, pad) : [(await ctx.token(query)).address];
      const fees = await Promise.all(
        candidates.map(async (token) => {
          const at = { address: pad, abi: memeLaunchpadAbi, args: [token] } as const;
          const [{ creator }, amount] = await Promise.all([
            readContract(client, { ...at, functionName: "curveState" }),
            readContract(client, { ...at, functionName: "creatorFees" }),
          ]);
          return { token, mine: isAddressEqual(creator, session.account), amount };
        }),
      );
      if (!v.all && !fees[0]?.mine) {
        throw new UsageError(`${candidates[0]} was not created by ${session.account}`);
      }
      const due = fees.filter((f) => f.mine && f.amount > 0n);
      if (due.length === 0) {
        return { account: session.account, claims: [], total: usd(0n), hash: null, explorer: null };
      }
      const { hash, receipt } = await ctx.send(
        session,
        due.map((f) => claimCall(pad, f.token)),
      );
      const claims = parseEventLogs({
        abi: memeLaunchpadAbi,
        eventName: "CreatorFeesClaimed",
        logs: receipt.logs,
      })
        .filter((l) => isAddressEqual(l.address, pad))
        .map((l) => ({ token: getAddress(l.args.token), amount: usd(l.args.amount) }));
      return {
        account: session.account,
        claims,
        total: usd(claims.reduce((s, c) => s + c.amount.base, 0n)),
        ...ctx.tx(hash),
      };
    },
  },
};

// ---- entry point ------------------------------------------------------------------------------

const GLOBAL = { json: B, help: { type: "boolean", short: "h" }, agent: S } as const;

/**
 * Runs one `mantle-meme` command line and resolves to its exit code (DESIGN §6.3). With `--json`,
 * stdout carries exactly one JSON object: `{ ok: true, command, result }`, or
 * `{ ok: false, command, exitCode, error: { code, type, message, …fields } }` (`watch` prints one
 * JSON line per event instead of a result). Without it, the result is printed as indented JSON
 * (`policy init`: the next steps as text) and an error as one line on stderr.
 */
export async function run(argv: string[], io: CliIO = {}): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => void process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => void process.stderr.write(text));
  const json = argv.includes("--json");
  const words = argv[0] === "policy" ? 2 : 1;
  const name = argv.slice(0, words).join(" ");
  const spec = COMMANDS[name];
  const command = spec ? name : null;
  try {
    if (!spec) {
      if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
        stdout(USAGE);
        return argv.length ? 0 : 1;
      }
      throw new UsageError(`unknown command ${JSON.stringify(name)}`);
    }
    let parsed: ReturnType<typeof parseArgs<{ options: typeof GLOBAL; allowPositionals: true }>>;
    try {
      parsed = parseArgs({
        args: argv.slice(words),
        options: { ...GLOBAL, ...spec.options },
        allowPositionals: true,
        strict: true,
      }) as typeof parsed;
    } catch (error) {
      throw new UsageError((error as Error).message);
    }
    const values = parsed.values as Values;
    if (values.help) {
      stdout(USAGE);
      return 0;
    }
    const { positionals } = parsed;
    if (positionals.length > (spec.token ? 1 : 0)) {
      throw new UsageError(`unexpected argument ${JSON.stringify(positionals.at(-1))}`);
    }
    const ctx = new Context({ ...io, stdout, stderr }, values);
    const result = await spec.run(ctx, values, positionals[0]);
    if (result !== PRINTED) {
      stdout(
        json
          ? `${toJson({ ok: true, command, result })}\n`
          : spec.text
            ? spec.text(result as never)
            : `${toJson(result, 2)}\n`,
      );
    }
    return 0;
  } catch (error) {
    const { exitCode, error: details } = describe(error);
    if (json) {
      stdout(`${redactUrls(toJson({ ok: false, command, exitCode, error: details }))}\n`);
    } else {
      stderr(`error: ${redactUrls(details.message)}\n`);
    }
    return exitCode;
  }
}
