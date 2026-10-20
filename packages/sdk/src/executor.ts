import { setTimeout as sleep } from "node:timers/promises";
import {
  type AddressBook,
  AgentSession,
  type Call,
  ExecutionRevertedError,
  type Executor,
  getProfile,
  loadProfileSigner,
  type Profile,
  readProfiles,
  SponsorBusyError,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  type Client,
  decodeFunctionData,
  erc20Abi,
  type Hex,
  isAddressEqual,
  type TransactionReceipt,
} from "viem";
import { getTransactionReceipt, readContract } from "viem/actions";
import { InsufficientBalanceError, SlippageError, toMemeError } from "./errors.js";
import { memeLaunchpadAbi } from "./generated.js";
import { appendJournal, type JournalRecord, tradesOf } from "./journal.js";
import { type SendLockOptions, withSendLock } from "./lock.js";

/**
 * The agent profile of a home: `name`, or the only `role: "agent"` profile. Works in an exported
 * agent home, which holds no root profile.
 */
export function agentProfile(home: string, name?: string): { name: string; profile: Profile } {
  if (name !== undefined) {
    const profile = getProfile(name, { home });
    if (profile.role !== "agent") throw new Error(`Profile ${name} is not an agent profile`);
    return { name, profile };
  }
  const agents = Object.entries(readProfiles({ home })).filter(([, p]) => p.role === "agent");
  if (agents.length !== 1) {
    throw new Error(
      agents.length === 0
        ? `No agent profile in ${home}`
        : `Several agent profiles in ${home} (${agents.map(([n]) => n).join(", ")}); pick one`,
    );
  }
  const [only] = agents as [[string, Profile]];
  return { name: only[0], profile: only[1] };
}

export interface OpenAgentSessionOptions {
  /** The agent home (`MANTLE_AA_HOME`). */
  home: string;
  /** The agent profile; default: the only one. */
  agent?: string;
  /** The keystore password; default `MANTLE_AA_KEYSTORE_PASSWORD`. */
  password?: string;
  client: Client;
  /** Needed to send. */
  executor?: Executor;
  addresses?: AddressBook;
}

/** An `AgentSession` for the home's agent profile, its key decrypted and checked against it. */
export function openAgentSession(o: OpenAgentSessionOptions): AgentSession {
  const { name, profile } = agentProfile(o.home, o.agent);
  const signer = loadProfileSigner(name, {
    home: o.home,
    ...(o.password !== undefined && { password: o.password }),
  });
  return new AgentSession({
    client: o.client,
    account: profile.account,
    keyHash: profile.keyHash,
    signer,
    ...(o.executor && { executor: o.executor }),
    ...(o.addresses && { addresses: o.addresses }),
  });
}

/** Pauses between `SPONSOR_BUSY` retries: 0.5 s doubling to 8 s. */
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8_000);

/**
 * Retries `fn` while it throws the AA SDK's `SponsorBusyError` (the sponsor has a request of this
 * account in flight), with backoff, for at most `maxMs` (default 60 s); then the error surfaces.
 */
export async function retrySponsorBusy<T>(fn: () => Promise<T>, maxMs = 60_000): Promise<T> {
  const until = Date.now() + maxMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const pause = backoff(attempt);
      if (!(e instanceof SponsorBusyError) || Date.now() + pause > until) throw e;
      await sleep(pause);
    }
  }
}

export interface ExecuteOptions {
  session: AgentSession;
  /** Reads the receipt. */
  client: Client;
  /** The agent home: lock and journal live in `<home>/meme/`. */
  home: string;
  /** The launchpad whose `Trade` logs are journalled. */
  launchpad: Address;
  calls: readonly Call[];
  via?: Executor["kind"];
  /** Longest `SPONSOR_BUSY` backoff; default 60 s. */
  busyMaxMs?: number;
  lock?: SendLockOptions;
  /** Longest wait for the receipt once the sponsor settled; default 60 s. */
  receiptTimeoutMs?: number;
}

export interface ExecuteResult {
  hash: Hex;
  receipt: TransactionReceipt;
  /** The journal records written for this transaction (its own `Trade` logs). */
  trades: JournalRecord[];
}

async function receiptOf(client: Client, hash: Hex, timeoutMs: number) {
  for (const until = Date.now() + timeoutMs; ; await sleep(250)) {
    const r = await getTransactionReceipt(client, { hash }).catch(() => undefined);
    if (r) return r;
    if (Date.now() > until) throw new Error(`No receipt for ${hash} within ${timeoutMs} ms`);
  }
}

/** Calibur's bare `CallFailed()`: the failed call's revert data is lost. */
const BARE_CALL_FAILED = "0x3204506f";

/**
 * Explains a failed batch in meme terms. Calibur reports a failed call as a bare `CallFailed()`
 * (the launchpad's revert data is not bubbled), and a batch that reverts on chain carries no data
 * at all, so for such an opaque failure each launchpad `buy` / `sell` of the batch is checked
 * against the chain now, in the contract's order: the quote view's revert (`UnknownTokenError`,
 * `CurveCompletedError`), the account's balance against the quote's actual input
 * (`InsufficientBalanceError`), then the quoted output against `minOut` (`SlippageError`). A buy
 * of a token the same batch creates is checked for balance only. Revert data that names another
 * error is kept: anything else is returned as `toMemeError(error)`.
 */
export async function diagnoseFailure(
  client: Client,
  launchpad: Address,
  account: Address,
  calls: readonly Call[],
  error: unknown,
): Promise<unknown> {
  const mapped = toMemeError(error);
  if (mapped !== error || !(error instanceof ExecutionRevertedError)) return mapped;
  const data = error.data?.toLowerCase();
  if (data && data !== "0x" && data !== BARE_CALL_FAILED) return error;
  const decoded = calls
    .filter((c) => isAddressEqual(c.to, launchpad))
    .flatMap((c) => {
      try {
        return [decodeFunctionData({ abi: memeLaunchpadAbi, data: c.data })];
      } catch {
        return [];
      }
    });
  const creates = decoded.some((f) => f.functionName === "createToken");
  for (const f of decoded) {
    if (f.functionName !== "buy" && f.functionName !== "sell") continue;
    const [token, amount, minOut] = f.args;
    const isBuy = f.functionName === "buy";
    const found = await (async (): Promise<Error | undefined> => {
      // The quote view reverts as the trade would (unknown token, completed curve); a buy pulls
      // only the quote's `amountInUsed`. A token the batch creates has no quote yet.
      let out: bigint | undefined;
      let needed = amount;
      if (!(isBuy && creates)) {
        const quote = { address: launchpad, abi: memeLaunchpadAbi, args: [token, amount] } as const;
        if (isBuy) {
          [out, needed] = await readContract(client, { ...quote, functionName: "quoteBuy" });
        } else {
          [out] = await readContract(client, { ...quote, functionName: "quoteSell" });
        }
      }
      const asset = isBuy
        ? await readContract(client, {
            address: launchpad,
            abi: memeLaunchpadAbi,
            functionName: "quoteToken",
          })
        : token;
      const balance = await readContract(client, {
        address: asset,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account],
      });
      if (balance < needed) return new InsufficientBalanceError({ balance, needed });
      return out !== undefined && out < minOut
        ? new SlippageError(`Output ${out} below minOut ${minOut}`)
        : undefined;
    })().catch((e: unknown) => {
      const m = toMemeError(e);
      return m !== e ? (m as Error) : undefined;
    });
    if (found) return Object.assign(found, { cause: error });
  }
  return error;
}

/**
 * Sends a batch for the session (DESIGN §7.1): takes the account's send lock, then
 * `AgentSession.exec` (simulate, then submit through the executor), retrying `SPONSOR_BUSY`; reads
 * the receipt and appends the transaction's own `Trade` logs to the journal. A reverted receipt is
 * an `ExecutionRevertedError` naming the hash, whatever the executor reported; nothing is
 * journalled. A failure is explained by `diagnoseFailure`; AA SDK errors pass through.
 */
export async function execute(o: ExecuteOptions): Promise<ExecuteResult> {
  try {
    return await withSendLock(
      o.home,
      async () => {
        const { hash } = await retrySponsorBusy(
          () => o.session.exec(o.calls, o.via ? { via: o.via } : {}),
          o.busyMaxMs,
        );
        const receipt = await receiptOf(o.client, hash, o.receiptTimeoutMs ?? 60_000);
        // The executor's `success` is the sponsor's word; the receipt is the chain's.
        if (receipt.status !== "success") {
          throw new ExecutionRevertedError({ reason: `Transaction ${hash} reverted` });
        }
        const trades = tradesOf(receipt, o.launchpad, o.session.account, o.session.keyHash);
        appendJournal(o.home, trades);
        return { hash, receipt, trades };
      },
      o.lock,
    );
  } catch (e) {
    throw await diagnoseFailure(o.client, o.launchpad, o.session.account, o.calls, e);
  }
}
