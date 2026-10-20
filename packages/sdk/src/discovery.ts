import { setTimeout as sleep } from "node:timers/promises";
import { type Address, type Client, type GetLogsReturnType, getAddress, isAddress } from "viem";
import { getBlockNumber, getLogs, readContract } from "viem/actions";
import { UnknownTokenError } from "./errors.js";
import { memeLaunchpadAbi, memeTokenAbi } from "./generated.js";

/** `MemeLaunchpad.Status`, by name. */
export const TOKEN_STATUSES = ["none", "trading", "completed", "graduated"] as const;
export type TokenStatus = (typeof TOKEN_STATUSES)[number];

/** `MemeLaunchpad.curveState(token)`, with the status by name. */
export interface CurveState {
  virtualToken: bigint;
  virtualQuote: bigint;
  /** Curve tokens sold (18 decimals). */
  sold: bigint;
  /** Net quote held for the curve (6 decimals). */
  realQuote: bigint;
  /** Quote base units per whole token, ×1e18. */
  priceE18: bigint;
  creator: Address;
  /** Unix seconds. */
  createdAt: bigint;
  status: TokenStatus;
}

export interface TokenInfo extends CurveState {
  address: Address;
  name: string;
  symbol: string;
}

/** The number of tokens registered on the launchpad. */
export function tokenCount(client: Client, launchpad: Address): Promise<bigint> {
  return readContract(client, {
    address: launchpad,
    abi: memeLaunchpadAbi,
    functionName: "tokenCount",
  });
}

/** A token's curve; `UnknownTokenError` when it is not registered on this launchpad. */
export async function curveState(
  client: Client,
  launchpad: Address,
  token: Address,
): Promise<CurveState> {
  const s = await readContract(client, {
    address: launchpad,
    abi: memeLaunchpadAbi,
    functionName: "curveState",
    args: [token],
  });
  const status = TOKEN_STATUSES[s.status] ?? "none";
  if (status === "none")
    throw new UnknownTokenError(`${token} is not registered on this launchpad`);
  return { ...s, status };
}

const tokenRead = (client: Client, token: Address, functionName: "name" | "symbol") =>
  readContract(client, { address: token, abi: memeTokenAbi, functionName });

async function tokenPage(client: Client, launchpad: Address, offset: bigint, limit: bigint) {
  return readContract(client, {
    address: launchpad,
    abi: memeLaunchpadAbi,
    functionName: "tokens",
    args: [offset, limit],
  });
}

/** Registered tokens in creation order (`tokens(offset, limit)`), with name, symbol and curve. */
export async function listTokens(
  client: Client,
  launchpad: Address,
  { offset = 0n, limit = 20n }: { offset?: bigint; limit?: bigint } = {},
): Promise<TokenInfo[]> {
  const page = await tokenPage(client, launchpad, offset, limit);
  return Promise.all(
    page.map(async (address) => {
      const [name, symbol, state] = await Promise.all([
        tokenRead(client, address, "name"),
        tokenRead(client, address, "symbol"),
        curveState(client, launchpad, address),
      ]);
      return { address, name, symbol, ...state };
    }),
  );
}

/** How many of the newest registry entries a symbol lookup or a portfolio scan reads. */
export const DEFAULT_MAX_SCAN = 1000n;
const PAGE = 100n;

/** The newest `maxScan` registered tokens, oldest first. */
export async function scanTokens(
  client: Client,
  launchpad: Address,
  maxScan: bigint = DEFAULT_MAX_SCAN,
): Promise<Address[]> {
  const count = await tokenCount(client, launchpad);
  const start = count > maxScan ? count - maxScan : 0n;
  const pages: Promise<readonly Address[]>[] = [];
  for (let offset = start; offset < count; offset += PAGE) {
    pages.push(tokenPage(client, launchpad, offset, PAGE));
  }
  return (await Promise.all(pages)).flat();
}

/**
 * Resolves a token argument: an address must be registered; a symbol must match exactly one of
 * the newest `maxScan` tokens, case-insensitively. A miss or an ambiguity throws
 * `UnknownTokenError` with at most 10 candidates (the matches, or symbols containing the query).
 */
export async function resolveToken(
  client: Client,
  launchpad: Address,
  query: string,
  { maxScan = DEFAULT_MAX_SCAN }: { maxScan?: bigint } = {},
): Promise<Address> {
  if (isAddress(query, { strict: false })) {
    const token = getAddress(query);
    const registered = await readContract(client, {
      address: launchpad,
      abi: memeLaunchpadAbi,
      functionName: "isRegistered",
      args: [token],
    });
    if (!registered) throw new UnknownTokenError(`${token} is not registered on this launchpad`);
    return token;
  }
  const addresses = await scanTokens(client, launchpad, maxScan);
  const symbols = await Promise.all(addresses.map((a) => tokenRead(client, a, "symbol")));
  const q = query.toLowerCase();
  const exact = addresses.filter((_, i) => symbols[i]?.toLowerCase() === q);
  if (exact.length === 1) return exact[0] as Address;
  const near =
    exact.length > 1 ? exact : addresses.filter((_, i) => symbols[i]?.toLowerCase().includes(q));
  const candidates = await Promise.all(
    near.slice(0, 10).map(async (address) => ({
      address,
      name: await tokenRead(client, address, "name"),
      symbol: symbols[addresses.indexOf(address)] as string,
    })),
  );
  throw new UnknownTokenError(
    exact.length > 1
      ? `Symbol ${JSON.stringify(query)} is ambiguous: ${exact.length} tokens`
      : `No token with symbol ${JSON.stringify(query)}`,
    candidates,
  );
}

const watchedEvents = memeLaunchpadAbi.filter(
  (x) =>
    x.type === "event" &&
    (x.name === "TokenCreated" || x.name === "Trade" || x.name === "CurveCompleted"),
) as Extract<
  (typeof memeLaunchpadAbi)[number],
  { type: "event"; name: "TokenCreated" | "Trade" | "CurveCompleted" }
>[];

/** A decoded `TokenCreated`, `Trade` or `CurveCompleted` log. */
export type LaunchpadEvent = GetLogsReturnType<undefined, typeof watchedEvents, true>[number];

export interface WatchOptions {
  /** First block to report; default: the head when the watch starts. */
  fromBlock?: bigint;
  /** Default 2000 ms. */
  pollIntervalMs?: number;
  /** Blocks re-scanned on every poll, for an RPC answering behind; default 5. */
  overlap?: bigint;
  signal?: AbortSignal;
  /** Called with a failed poll, which is retried on the next tick; without it the error is thrown. */
  onError?: (error: unknown) => void;
}

/**
 * Polls `eth_getLogs` for the launchpad's `TokenCreated` / `Trade` / `CurveCompleted` and yields
 * each log once, in chain order. Every poll re-scans the last `overlap` blocks, so a log a lagging
 * (load-balanced) RPC did not return yet is still reported; logs are deduplicated by
 * `(transactionHash, logIndex)`. Ends when `signal` aborts or the consumer stops iterating.
 */
export async function* watch(
  client: Client,
  launchpad: Address,
  options: WatchOptions = {},
): AsyncGenerator<LaunchpadEvent> {
  const { pollIntervalMs = 2000, overlap = 5n, signal, onError } = options;
  const first = options.fromBlock ?? (await getBlockNumber(client, { cacheTime: 0 }));
  let scannedTo = first - 1n;
  /** `txHash:logIndex` → block of every log reported inside the re-scan window. */
  const seen = new Map<string, bigint>();
  while (!signal?.aborted) {
    try {
      const head = await getBlockNumber(client, { cacheTime: 0 });
      const lastScan = scannedTo + 1n - overlap;
      const fromBlock = lastScan > first ? lastScan : first;
      if (head >= fromBlock) {
        const logs = await getLogs(client, {
          address: launchpad,
          events: watchedEvents,
          fromBlock,
          toBlock: head,
          strict: true,
        });
        logs.sort((a, b) =>
          a.blockNumber === b.blockNumber
            ? a.logIndex - b.logIndex
            : a.blockNumber < b.blockNumber
              ? -1
              : 1,
        );
        for (const log of logs) {
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (seen.has(key)) continue;
          seen.set(key, log.blockNumber);
          yield log;
        }
        if (head > scannedTo) scannedTo = head;
        for (const [key, block] of seen) if (block <= scannedTo - overlap) seen.delete(key);
      }
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
    try {
      await sleep(pollIntervalMs, undefined, signal ? { signal } : {});
    } catch {
      return; // aborted
    }
  }
}
