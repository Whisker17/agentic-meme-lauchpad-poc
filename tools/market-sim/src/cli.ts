import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolveToken } from "@0xwh1sker/mantle-meme-sdk";
import { type LocalAccount, parseUnits } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { errorMessage, MarketSim, type SimEvent, type Wallet } from "./sim.js";

export const RPC_ENV = "MARKET_SIM_RPC_URL";
export const MNEMONIC_ENV = "MARKET_SIM_MNEMONIC";
export const MNEMONIC_FILE_ENV = "MARKET_SIM_MNEMONIC_FILE";

const USAGE = `Usage: market-sim <command> [options]

Commands:
  addresses                 Print the EOA addresses (fund them with MNT for gas)
  run                       Create tokens and trade on a schedule until Ctrl-C or --duration
  pump <token>              Buy <token> (address or symbol) until its spot price rises by --percent
  buy <token> <mUSD>        Buy exactly <mUSD> (not clamped: an oversized buy completes the curve)

Options:
  --wallets <n>             Number of EOAs derived from the mnemonic (default 3)
  --wallet <i>              Wallet index for pump / buy (default: seeded random)
  --seed <n>                Seed of every random choice (default 1)
  --percent <p>             pump target: spot price × (1 + p/100) (default 100)
  --duration <s>            run: stop after <s> seconds
  --create-every <a-b>      run: seconds between creates (default 120-300)
  --trade-every <a-b>       run: seconds between random trades (default 10-30)

Environment:
  ${RPC_ENV}        RPC of an anvil fork or Mantle Sepolia (required)
  ${MNEMONIC_ENV}       BIP-39 mnemonic of the EOAs (m/44'/60'/0'/0/i), or
  ${MNEMONIC_FILE_ENV}  a file holding it
`;

class UsageError extends Error {}

const json = (e: unknown) =>
  JSON.stringify(e, (_, v) => (typeof v === "bigint" ? v.toString() : v));

function int(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw new UsageError(`--${name} must be a non-negative integer`);
  return n;
}

function range(value: string | undefined, name: string, fallback: [number, number]) {
  if (value === undefined) return fallback.map((s) => s * 1000) as [number, number];
  const m = /^(\d+)-(\d+)$/.exec(value);
  if (!m || Number(m[1]) > Number(m[2]))
    throw new UsageError(`--${name} must be <min>-<max> seconds`);
  return [Number(m[1]) * 1000, Number(m[2]) * 1000] as [number, number];
}

/** The EOAs: `wallets` accounts derived from the mnemonic in the environment or its file. */
export function accountsFromEnv(env: NodeJS.ProcessEnv, wallets: number): LocalAccount[] {
  const file = env[MNEMONIC_FILE_ENV];
  const mnemonic = (file ? readFileSync(file, "utf8") : (env[MNEMONIC_ENV] ?? "")).trim();
  if (!mnemonic) throw new UsageError(`Set ${MNEMONIC_ENV} or ${MNEMONIC_FILE_ENV}`);
  if (wallets < 1) throw new UsageError("--wallets must be at least 1");
  return Array.from({ length: wallets }, (_, i) =>
    mnemonicToAccount(mnemonic, { addressIndex: i }),
  );
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const print = (e: unknown) => process.stdout.write(`${json(e)}\n`);
  try {
    const { values: o, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        wallets: { type: "string" },
        wallet: { type: "string" },
        seed: { type: "string" },
        percent: { type: "string" },
        duration: { type: "string" },
        "create-every": { type: "string" },
        "trade-every": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
    const [command, ...args] = positionals;
    if (o.help || !command) {
      process.stdout.write(USAGE);
      return o.help ? 0 : 2;
    }
    const accounts = accountsFromEnv(env, int(o.wallets, "wallets", 3));
    if (command === "addresses") {
      for (const [i, a] of accounts.entries()) print({ wallet: i, address: a.address });
      return 0;
    }
    const rpcUrl = env[RPC_ENV];
    if (!rpcUrl) throw new UsageError(`Set ${RPC_ENV}`);
    const sim = new MarketSim({
      rpcUrl,
      accounts,
      seed: int(o.seed, "seed", 1),
      log: (e: SimEvent) => print({ t: new Date().toISOString(), ...e }),
    });
    const wallet = o.wallet === undefined ? undefined : int(o.wallet, "wallet", 0);
    const token = async () => {
      if (!args[0]) throw new UsageError(`${command} needs <token>`);
      return resolveToken(sim.wallets[0] as Wallet, sim.launchpad, args[0]);
    };
    switch (command) {
      case "run": {
        const ac = new AbortController();
        process.once("SIGINT", () => ac.abort());
        process.once("SIGTERM", () => ac.abort());
        const duration = o.duration === undefined ? undefined : int(o.duration, "duration", 0);
        if (duration !== undefined) setTimeout(() => ac.abort(), duration * 1000).unref();
        const summary = await sim.run({
          signal: ac.signal,
          createIntervalMs: range(o["create-every"], "create-every", [120, 300]),
          tradeIntervalMs: range(o["trade-every"], "trade-every", [10, 30]),
        });
        print({ t: new Date().toISOString(), kind: "summary", ...summary });
        return summary.errors === 0 ? 0 : 1;
      }
      case "pump": {
        const percent = o.percent === undefined ? undefined : Number(o.percent);
        if (percent !== undefined && !(percent > 0)) throw new UsageError("--percent must be > 0");
        await sim.pump(await token(), {
          ...(percent === undefined ? {} : { percent }),
          ...(wallet === undefined ? {} : { wallet }),
        });
        return 0;
      }
      case "buy": {
        if (!args[1]) throw new UsageError("buy needs <mUSD>");
        await sim.buy(
          await token(),
          parseUnits(args[1], 6),
          wallet === undefined ? {} : { wallet },
        );
        return 0;
      }
      default:
        throw new UsageError(`Unknown command ${command}`);
    }
  } catch (e) {
    const usage =
      e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    process.stderr.write(`market-sim: ${errorMessage(e)}\n`);
    if (usage) process.stderr.write(USAGE);
    return usage ? 2 : 1;
  }
}
