// The autopilot daemon (DESIGN §7.3): a detached process that watches the launchpad, runs the
// pure strategy engine (meme-sdk `decide`) and trades through the SDK's `execute` (send lock,
// journal). Its files live in `<agentHome>/meme/autopilot/`.
import { type ChildProcess, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "@0xwh1sker/mantle-aa-cli";
import {
  type AgentSession,
  agentPolicyHookAbi,
  type Call,
  caliburAbi,
  KeyExpiredError,
  PolicyViolationError,
  redactUrls,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  type Action,
  AutopilotStateError,
  type CurveParams,
  costBasis,
  curveState,
  decide,
  execute,
  type HeldPosition,
  type LaunchpadEvent,
  meetsTakeProfit,
  memeDir,
  minOutFor,
  type ObservedToken,
  parseStrategy,
  planBuy,
  quoteBuy,
  quoteSell,
  readCurveParams,
  readJournal,
  type Strategy,
  StrategyError,
  sellCall,
  watch,
} from "@0xwh1sker/mantle-meme-sdk";
import { type Address, type Client, erc20Abi, getAddress, type Hex, isAddressEqual } from "viem";
import { getBlock, getBlockNumber, readContract } from "viem/actions";
import { describe, type ErrorDescription, ReportedError } from "./errors.js";
import { toJson, tok, usd } from "./format.js";

/** Settings of the autopilot, besides the AA CLI's. */
export const TG_TOKEN_ENV = "MANTLE_MEME_TG_BOT_TOKEN";
export const TG_CHAT_ENV = "MANTLE_MEME_TG_CHAT_ID";
/** The Bot API base URL; default `https://api.telegram.org` (tests point it at a mock). */
export const TG_API_ENV = "MANTLE_MEME_TG_API_URL";
/** The exit-check tick in ms; default 10 000. */
export const TICK_ENV = "MANTLE_MEME_AUTOPILOT_TICK_MS";
/** The watcher's `eth_getLogs` poll in ms; default 2 000. */
export const POLL_ENV = "MANTLE_MEME_AUTOPILOT_POLL_MS";
/**
 * Tests only: the daemon SIGKILLs itself right after a trade of this kind (`buy`, `take_profit`,
 * `max_hold`) confirmed, before anything else records it, as a crash would. Unset in use.
 */
export const CRASH_ENV = "MANTLE_MEME_AUTOPILOT_TEST_CRASH_AFTER";

const KEY_EXPIRED_OR_REVOKED = 13;

/** What the daemon needs of the CLI's run context. */
export interface AutopilotContext {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly pad: Address;
  readonly book: { mockUsd: Address; agentPolicyHook: Address };
  client(): Client;
  session(): AgentSession;
  deadline(): Promise<bigint>;
  tx(hash: Hex): { hash: Hex; explorer: string | null };
}

// ---- files ------------------------------------------------------------------------------------

/** `<home>/meme/autopilot/{pid, strategy.json, state.json, events.jsonl, daemon.log}`. */
export function autopilotFiles(home: string) {
  const dir = join(memeDir(home), "autopilot");
  return {
    dir,
    pid: join(dir, "pid"),
    strategy: join(dir, "strategy.json"),
    state: join(dir, "state.json"),
    events: join(dir, "events.jsonl"),
    log: join(dir, "daemon.log"),
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readText = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
};

const readJson = (file: string) => {
  const text = readText(file);
  return text === undefined ? null : JSON.parse(text);
};

/** The pid of the running daemon, if any (a pid file naming a dead process is stale). */
export function runningPid(home: string): number | undefined {
  const pid = Number(readText(autopilotFiles(home).pid)?.trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
}

/** Writes JSON atomically (temp file + rename). */
function writeJson(file: string, value: unknown) {
  writeFileSync(`${file}.tmp`, `${toJson(value, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** A strategy file: parsed JSON and the validated strategy; a bad file is a usage error. */
export function readStrategyFile(file: string): { raw: unknown; strategy: Strategy } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read the strategy ${file}: ${(e as Error).message}`);
  }
  try {
    return { raw, strategy: parseStrategy(raw) };
  } catch (e) {
    if (e instanceof StrategyError) throw new UsageError(`invalid strategy: ${e.message}`);
    throw e;
  }
}

/** One record of `events.jsonl`: `{at (ISO wall clock), event, …fields}`. */
export interface AutopilotEvent {
  at: string;
  event: string;
  [field: string]: unknown;
}

/** The events of `events.jsonl`, oldest first; with `since` (ms), only those at or after it. */
export function readEvents(home: string, since?: number): AutopilotEvent[] {
  const text = readText(autopilotFiles(home).events) ?? "";
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AutopilotEvent];
      } catch {
        return []; // a line cut short by a crash
      }
    })
    .filter((e) => since === undefined || Date.parse(e.at) >= since);
}

// ---- Telegram ---------------------------------------------------------------------------------

/**
 * A Telegram pusher (Bot API `sendMessage`) when both bot variables are set, else `undefined`.
 * Messages are sent in order in the background; a failure is reported to `onError` with the bot
 * token scrubbed and never stops the caller.
 */
export function telegram(env: NodeJS.ProcessEnv, onError: (message: string) => void) {
  const token = env[TG_TOKEN_ENV];
  const chat = env[TG_CHAT_ENV];
  if (!token || !chat) return undefined;
  const base = (env[TG_API_ENV] || "https://api.telegram.org").replace(/\/+$/, "");
  const scrub = (text: string) => redactUrls(text.replaceAll(token, "<redacted>"));
  let queue = Promise.resolve();
  return {
    send(text: string) {
      queue = queue.then(async () => {
        try {
          const res = await fetch(`${base}/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`Telegram answered HTTP ${res.status}`);
        } catch (e) {
          const cause = (e as Error).cause as Error | undefined;
          onError(scrub(`${(e as Error).message}${cause?.message ? `: ${cause.message}` : ""}`));
        }
      });
    },
    /** Waits for the messages queued so far, at most `ms`. */
    flush: (ms = 10_000) =>
      Promise.race([queue, new Promise<void>((r) => setTimeout(r, ms).unref())]),
  };
}

const h = (amount: unknown) => (amount as { human?: string } | undefined)?.human ?? "?";

/** The Telegram text of an event; `undefined` for events not pushed (entry-filter skips, own errors). */
export function messageOf(e: AutopilotEvent): string | undefined {
  const link = e.explorer ? `\n${e.explorer}` : "";
  switch (e.event) {
    case "started": {
      const s = e.strategy as { entry: { amountPerToken: unknown }; exit: Record<string, unknown> };
      return `Autopilot started: ${s.entry.amountPerToken} mUSD per new token, take-profit +${s.exit.takeProfitPercent}% sells ${s.exit.takeProfitSellPercent}%, max hold ${s.exit.maxHoldMinutes} min.`;
    }
    case "stopped":
      return `Autopilot stopped (${e.reason}).`;
    case "bought":
      return `Bought ${e.symbol}: ${h(e.spent)} mUSD → ${h(e.tokens)} tokens.${link}`;
    case "sold":
      return `Sold ${e.symbol} (${e.reason === "take_profit" ? "take-profit" : "max hold"}): ${h(e.sold)} tokens → ${h(e.received)} mUSD, PnL ${h(e.pnl)} mUSD.${link}`;
    case "skipped":
      return e.reason === "unknown_cost_basis"
        ? `Not managing ${e.symbol}: its cost basis is unknown.`
        : undefined;
    case "budget_exhausted":
      return `Budget exhausted (remaining limit ${h(e.remainingLimit)} mUSD, balance ${h(e.balance)} mUSD): no more entries.`;
    case "curve_completed":
      return `${e.symbol}: curve completed, trading is disabled; the position is stranded.`;
    case "session_ended":
      return "Session ended (key expired or revoked): autopilot stopped. Re-grant from the root terminal.";
    case "error":
      return e.source === "telegram" ? undefined : `Autopilot error (${e.code}): ${e.message}`;
    default:
      return undefined;
  }
}

// ---- spawning ---------------------------------------------------------------------------------

/** The CLI's own entry point (`bin/mantle-meme.{js,ts}` next to this module). */
const BIN = fileURLToPath(
  new URL(`./bin/mantle-meme${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** What a daemon reports to `start` once it runs, or why it could not. */
export type DaemonReport =
  | { ok: true; result: Record<string, unknown> }
  | ({ ok: false } & ErrorDescription);

/**
 * `autopilot start`: refuses when a daemon runs (exit 44), then spawns a detached
 * `mantle-meme autopilot daemon` and resolves with what it reports once running.
 */
export async function startAutopilot(
  ctx: Pick<AutopilotContext, "home" | "env">,
  strategyFile: string,
  agent: string | undefined,
): Promise<Record<string, unknown>> {
  readStrategyFile(strategyFile);
  const pid = runningPid(ctx.home);
  if (pid) throw new AutopilotStateError(`Autopilot is already running (pid ${pid})`);
  const f = autopilotFiles(ctx.home);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const log = openSync(f.log, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        BIN,
        "autopilot",
        "daemon",
        "--strategy",
        strategyFile,
        ...(agent ? ["--agent", agent] : []),
      ],
      { detached: true, stdio: ["ignore", log, log, "ipc"], env: ctx.env },
    );
  } finally {
    closeSync(log);
  }
  const report = await new Promise<DaemonReport>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`The autopilot did not report within 120 s; see ${f.log}`));
    }, 120_000);
    child.once("message", (m) => {
      clearTimeout(timer);
      resolve(m as DaemonReport);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`The autopilot exited (${code}) before it started; see ${f.log}`));
    });
  });
  child.removeAllListeners("exit");
  if (child.connected) child.disconnect();
  child.unref();
  if (!report.ok) throw new ReportedError({ exitCode: report.exitCode, error: report.error });
  return report.result;
}

/** `autopilot stop`: SIGTERM, wait for the daemon to finish its step and exit (else SIGKILL). */
export async function stopAutopilot(home: string, timeoutMs = 60_000) {
  const pid = runningPid(home);
  if (!pid) throw new AutopilotStateError("Autopilot is not running");
  process.kill(pid, "SIGTERM");
  for (const until = Date.now() + timeoutMs; alive(pid); ) {
    if (Date.now() > until) {
      process.kill(pid, "SIGKILL");
      const f = autopilotFiles(home);
      rmSync(f.pid, { force: true });
      const state = readJson(f.state);
      if (state) writeJson(f.state, { ...state, status: "stopped", updatedAt: new Date() });
      appendFileSync(
        f.events,
        `${toJson({ at: new Date(), event: "stopped", reason: "killed" })}\n`,
      );
      return { pid, stopped: true, forced: true };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { pid, stopped: true, forced: false };
}

/** `autopilot status`: whether a daemon runs, its strategy and its last state. */
export function autopilotStatus(home: string) {
  const f = autopilotFiles(home);
  const pid = runningPid(home);
  return {
    running: pid !== undefined,
    pid: pid ?? null,
    strategy: readJson(f.strategy),
    state: readJson(f.state),
  };
}

// ---- the daemon -------------------------------------------------------------------------------

type PositionStatus = "open" | "closed" | "completed" | "unmanaged";

interface PositionState {
  token: Address;
  symbol: string;
  /** The buy's block. */
  openedBlock: number;
  /** Chain time of the buy's block (unix seconds); `null` until that block was read. */
  openedAt: number | null;
  status: PositionStatus;
  takeProfitDone: boolean;
}

/**
 * The autopilot trade being sent, checkpointed before the send. A trade that confirms is applied
 * to the positions at once; when the daemon died first, the next start applies it from the journal
 * (the only accounting source, D33): the session's trade of that token and side appended after
 * `journalLength` records.
 */
interface PendingTrade {
  token: Address;
  symbol: string;
  reason: "buy" | "take_profit" | "max_hold";
  journalLength: number;
}

interface DaemonState {
  status: "running" | "stopped" | "session_ended";
  pid: number;
  startedAt: string;
  updatedAt: string;
  account: Address;
  keyHash: Hex;
  fromBlock: bigint;
  budgetExhausted: boolean;
  positions: PositionState[];
  pending: PendingTrade | null;
}

/** Thrown by a step when the session key expired or was revoked (exit 13). */
class SessionEnded extends Error {
  constructor(readonly description: ErrorDescription) {
    super(description.error.message);
  }
}

/**
 * The session's own state on chain, as the AA SDK checks it before a send: the error `simulate`
 * would throw (exit 13) when the key is no longer registered, expired or revoked on the hook.
 * Read on every tick, so an idle daemon notices a revoke without trading.
 */
async function sessionCheck(
  client: Client,
  session: AgentSession,
  hook: Address,
  now: bigint,
): Promise<Error | undefined> {
  const { account, keyHash } = session;
  const at = { address: account, abi: caliburAbi } as const;
  if (!(await readContract(client, { ...at, functionName: "isRegistered", args: [keyHash] }))) {
    return new PolicyViolationError({ reason: "Session key is not registered on the account" });
  }
  const [settings, summary] = await Promise.all([
    readContract(client, { ...at, functionName: "getKeySettings", args: [keyHash] }),
    readContract(client, {
      address: hook,
      abi: agentPolicyHookAbi,
      functionName: "getSummary",
      args: [keyHash, account],
    }),
  ]);
  const expiry = Number((settings >> 160n) & 0xff_ffff_ffffn);
  if (expiry !== 0 && BigInt(expiry) < now) return new KeyExpiredError({ keyHash, expiry });
  if (summary.revoked) return new PolicyViolationError({ reason: "Session is revoked" });
  return undefined;
}

const envMs = (env: NodeJS.ProcessEnv, name: string, fallback: number) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 10) throw new UsageError(`${name} must be an integer ≥ 10`);
  return ms;
};

/**
 * `autopilot daemon` (spawned by `start`, not for direct use): takes the pid file, reports to the
 * parent over IPC, then runs until SIGTERM / SIGINT or the session ends. Open positions of a
 * previous run (its `state.json`) are managed again.
 */
export async function runDaemon(ctx: AutopilotContext, strategyFile: string): Promise<void> {
  const report = (r: DaemonReport) => {
    if (process.send && process.connected) {
      // IPC is JSON: bigints travel as decimal strings.
      process.send(JSON.parse(toJson(r)));
      process.disconnect();
    }
  };
  try {
    await daemon(ctx, strategyFile, report);
  } catch (e) {
    const { exitCode, error } = describe(e);
    report({ ok: false, exitCode, error });
    throw e;
  }
}

async function daemon(
  ctx: AutopilotContext,
  strategyFile: string,
  report: (r: DaemonReport) => void,
): Promise<void> {
  const { raw, strategy } = readStrategyFile(strategyFile);
  const f = autopilotFiles(ctx.home);
  const tickMs = envMs(ctx.env, TICK_ENV, 10_000);
  const pollMs = envMs(ctx.env, POLL_ENV, 2_000);
  mkdirSync(f.dir, { recursive: true, mode: 0o700 });

  // The pid file, exclusively: a second daemon racing this one loses with exit 44.
  for (;;) {
    try {
      writeFileSync(f.pid, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = runningPid(ctx.home);
      if (pid) throw new AutopilotStateError(`Autopilot is already running (pid ${pid})`);
      rmSync(f.pid, { force: true });
    }
  }
  const ownsPid = () => readText(f.pid)?.trim() === String(process.pid);

  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  let state: DaemonState | undefined;
  let tg: ReturnType<typeof telegram>;
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    const e: AutopilotEvent = { at: new Date().toISOString(), event, ...fields };
    appendFileSync(f.events, `${toJson(e)}\n`, { mode: 0o600 });
    const text = messageOf(JSON.parse(toJson(e)));
    if (text) tg?.send(text);
  };
  tg = telegram(ctx.env, (message) => emit("error", { source: "telegram", message }));

  let stopReason = "stop";
  try {
    const client = ctx.client();
    const session = ctx.session();
    const account = getAddress(session.account);
    const hook = ctx.book.agentPolicyHook;
    // Tokens created after the start: the head block was seen (by a previous run) or is older.
    const [params, fromBlock, head] = await Promise.all([
      readCurveParams(client, ctx.pad),
      getBlockNumber(client, { cacheTime: 0 }).then((n) => n + 1n),
      getBlock(client),
    ]);
    const ended = await sessionCheck(client, session, hook, head.timestamp);
    if (ended) throw ended;

    const previous = readJson(f.state) as DaemonState | null;
    if (previous?.pending) recover(previous, previous.pending, ctx.home, session.keyHash);
    const now = new Date().toISOString();
    state = {
      status: "running",
      pid: process.pid,
      startedAt: now,
      updatedAt: now,
      account,
      keyHash: session.keyHash,
      fromBlock,
      budgetExhausted: false,
      positions: (previous?.positions ?? []).filter((p) => p.status === "open"),
      pending: null,
    };
    writeFileSync(f.strategy, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    writeJson(f.state, state);
    const started = {
      pid: process.pid,
      account,
      keyHash: session.keyHash,
      fromBlock,
      strategy: raw,
    };
    emit("started", started);
    report({ ok: true, result: { ...started, files: f } });

    await loop(
      { ctx, strategy, params, client, session, account, hook, fromBlock, state },
      {
        tickMs,
        pollMs,
        signal: stop.signal,
        emit,
      },
    );
  } catch (e) {
    if (!(e instanceof SessionEnded)) {
      if (state) {
        stopReason = "error";
        emit("error", { source: "daemon", ...describe(e).error });
      }
      throw e;
    }
    stopReason = "session_ended";
    emit("session_ended", { exitCode: KEY_EXPIRED_OR_REVOKED, ...e.description.error });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    if (state) {
      state.status = stopReason === "session_ended" ? "session_ended" : "stopped";
      state.updatedAt = new Date().toISOString();
      writeJson(f.state, state);
      emit("stopped", { reason: stopReason });
    }
    await tg?.flush();
    if (ownsPid()) rmSync(f.pid, { force: true });
  }
}

export interface Run {
  ctx: AutopilotContext;
  strategy: Strategy;
  params: CurveParams;
  client: Client;
  session: AgentSession;
  account: Address;
  hook: Address;
  fromBlock: bigint;
  state: DaemonState;
}

export interface LoopOptions {
  tickMs: number;
  pollMs: number;
  signal: AbortSignal;
  emit: (event: string, fields?: Record<string, unknown>) => void;
}

/** Runs steps on watcher events and on every tick until aborted; a `SessionEnded` escapes. */
async function loop(run: Run, o: LoopOptions): Promise<void> {
  const queue: LaunchpadEvent[] = [];
  let wake: (() => void) | undefined;
  let lastWatchError: string | undefined;
  // The watcher stops with the loop, whether it was stopped or the session ended.
  const done = new AbortController();
  const signal = AbortSignal.any([o.signal, done.signal]);
  const watcher = (async () => {
    for await (const log of watch(run.client, run.ctx.pad, {
      fromBlock: run.fromBlock,
      pollIntervalMs: o.pollMs,
      signal,
      onError: (e) => {
        const { error } = describe(e);
        const message = redactUrls(error.message);
        if (message !== lastWatchError) o.emit("error", { source: "watch", ...error, message });
        lastWatchError = message;
      },
    })) {
      lastWatchError = undefined;
      queue.push(log);
      wake?.();
    }
  })();
  let nextTick = 0;
  const retries = new Map<string, number>();
  const keyOf = (e: LaunchpadEvent) => `${e.transactionHash}:${e.logIndex}`;
  try {
    while (!o.signal.aborted) {
      const wait = Math.max(0, nextTick - Date.now());
      if (queue.length === 0 && wait > 0) {
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            wake = undefined;
            o.signal.removeEventListener("abort", done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          wake = done;
          o.signal.addEventListener("abort", done, { once: true });
        });
      }
      if (o.signal.aborted) break;
      const tick = Date.now() >= nextTick;
      if (tick) nextTick = Date.now() + o.tickMs;
      const events = queue.splice(0);
      try {
        await step(run, events, tick, o.emit);
        for (const e of events) retries.delete(keyOf(e));
      } catch (e) {
        const d = describe(e);
        if (e instanceof SessionEnded) throw e;
        if (d.exitCode === KEY_EXPIRED_OR_REVOKED) throw new SessionEnded(d);
        o.emit("error", { source: "step", exitCode: d.exitCode, ...d.error });
        // E.g. an RPC answering a block behind the logs: the events get up to 3 more steps.
        const again = events.filter((x) => {
          const n = (retries.get(keyOf(x)) ?? 0) + 1;
          retries.set(keyOf(x), n);
          return n <= 3;
        });
        queue.unshift(...again);
        for (const x of events) if (!again.includes(x)) retries.delete(keyOf(x));
      } finally {
        save(run);
      }
    }
  } finally {
    done.abort();
    await watcher.catch(() => {});
  }
}

/** Checkpoints the daemon state to `state.json`. */
function save(run: Run) {
  run.state.updatedAt = new Date().toISOString();
  writeJson(autopilotFiles(run.ctx.home).state, run.state);
}

/** Applies a confirmed autopilot trade: a buy opens its position, a sale marks or closes it. */
function apply(state: DaemonState, t: PendingTrade, blockNumber: bigint) {
  const p = state.positions.find((x) => isAddressEqual(x.token, t.token));
  if (t.reason === "buy") {
    if (p) return;
    state.positions.push({
      token: t.token,
      symbol: t.symbol,
      openedBlock: Number(blockNumber),
      openedAt: null,
      status: "open",
      takeProfitDone: false,
    });
  } else if (p) {
    if (t.reason === "take_profit") p.takeProfitDone = true;
    else p.status = "closed";
  }
}

/** Applies the pending trade of a daemon that died during it, if the journal shows it confirmed. */
function recover(state: DaemonState, t: PendingTrade, home: string, keyHash: Hex) {
  const side = t.reason === "buy" ? "buy" : "sell";
  const confirmed = readJournal(home)
    .slice(t.journalLength)
    .find(
      (r) =>
        r.keyHash.toLowerCase() === keyHash.toLowerCase() &&
        isAddressEqual(r.token, t.token) &&
        r.side === side,
    );
  if (confirmed) apply(state, t, confirmed.blockNumber);
}

/**
 * Sends one autopilot trade: checkpointed as pending first, applied to the positions and
 * checkpointed again as soon as it confirmed, before anything else can fail.
 */
async function send(
  run: Run,
  a: { token: Address; symbol: string; reason: PendingTrade["reason"] },
  calls: readonly Call[],
) {
  const { ctx, client, session, state } = run;
  const pending = {
    token: a.token,
    symbol: a.symbol,
    reason: a.reason,
    journalLength: readJournal(ctx.home).length,
  };
  state.pending = pending;
  save(run);
  try {
    const result = await execute({ session, client, home: ctx.home, launchpad: ctx.pad, calls });
    if (ctx.env[CRASH_ENV] === a.reason) process.kill(process.pid, "SIGKILL");
    apply(state, pending, result.receipt.blockNumber);
    return result;
  } finally {
    state.pending = null; // a send that failed journalled nothing
    save(run);
  }
}

/** One decision: read what the engine needs, decide, act on each action in order. */
async function step(
  run: Run,
  events: LaunchpadEvent[],
  tick: boolean,
  emit: LoopOptions["emit"],
): Promise<void> {
  const { client, session, account, ctx, state } = run;
  const pad = ctx.pad;
  const now = (await getBlock(client)).timestamp;
  if (tick) {
    const ended = await sessionCheck(client, session, run.hook, now);
    if (ended) throw new SessionEnded(describe(ended));
  }
  const open = state.positions.filter((p) => p.status === "open");
  const held = (t: Address) => open.find((p) => isAddressEqual(p.token, t));

  const created = events.flatMap((e) =>
    e.eventName === "TokenCreated" && !held(e.args.token) ? [e.args] : [],
  );
  const observed: ObservedToken[] = await Promise.all(
    created.map(async (a) => {
      const s = await curveState(client, pad, a.token);
      return {
        token: getAddress(a.token),
        name: a.name,
        symbol: a.symbol,
        creator: getAddress(a.creator),
        createdAt: s.createdAt,
        observedAt: now,
        priceE18: s.priceE18,
        trading: s.status === "trading",
      };
    }),
  );
  const touched = new Set(
    events.flatMap((e) => (e.eventName === "TokenCreated" ? [] : [e.args.token.toLowerCase()])),
  );
  const evaluate = tick ? open : open.filter((p) => touched.has(p.token.toLowerCase()));

  const quote = ctx.book.mockUsd;
  const budget =
    observed.length === 0 || state.budgetExhausted
      ? { remainingLimit: 0n, balance: 0n }
      : await Promise.all([
          readContract(client, {
            address: run.hook,
            abi: agentPolicyHookAbi,
            functionName: "remainingLimit",
            args: [session.keyHash, account, quote],
          }),
          readContract(client, {
            address: quote,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account],
          }),
        ]).then(([remainingLimit, balance]) => ({ remainingLimit, balance }));

  const journal = evaluate.length ? readJournal(ctx.home) : [];
  const positions: HeldPosition[] = [];
  for (const p of evaluate) {
    const [s, inventory] = await Promise.all([
      curveState(client, pad, p.token),
      readContract(client, {
        address: run.hook,
        abi: agentPolicyHookAbi,
        functionName: "inventory",
        args: [session.keyHash, account, p.token],
      }),
    ]);
    if (inventory === 0n && s.status === "trading") {
      p.status = "closed"; // sold (by the autopilot or by hand)
      continue;
    }
    p.openedAt ??= Number(
      (await getBlock(client, { blockNumber: BigInt(p.openedBlock) })).timestamp,
    );
    positions.push({
      token: p.token,
      symbol: p.symbol,
      openedAt: BigInt(p.openedAt),
      inventory,
      costBasis: costBasis(journal, session.keyHash, p.token, inventory),
      reserves: s.status === "trading" ? { vT: s.virtualToken, vQ: s.virtualQuote } : null,
      takeProfitDone: p.takeProfitDone,
    });
  }

  const actions = decide({
    strategy: run.strategy,
    params: run.params,
    account,
    now,
    observed,
    positions,
    openPositions: open.filter((p) => p.status === "open").length,
    budget,
    budgetExhausted: state.budgetExhausted,
  });
  await actOn(run, actions, now, emit);
}

/** Carries out one decision's actions in order, checkpointing the state after each. */
export async function actOn(
  run: Run,
  actions: readonly Action[],
  now: bigint,
  emit: LoopOptions["emit"],
): Promise<void> {
  for (const a of actions) {
    // A buy refused for budget (11 / 43) ends the entries of this decision too; exits still run.
    if (a.type === "buy" && run.state.budgetExhausted) continue;
    await act(run, a, now, emit);
    save(run);
  }
}

/** Carries out one engine action; its failure is an event, except a session that ended. */
async function act(run: Run, a: Action, now: bigint, emit: LoopOptions["emit"]): Promise<void> {
  const { state } = run;
  const position = (t: Address) => state.positions.find((p) => isAddressEqual(p.token, t));
  const setStatus = (t: Address, status: PositionStatus) => {
    const p = position(t);
    if (p) p.status = status;
  };
  switch (a.type) {
    case "skip":
      if (a.reason === "unknown_cost_basis") setStatus(a.token, "unmanaged");
      emit("skipped", { token: a.token, symbol: a.symbol, reason: a.reason });
      return;
    case "budget_exhausted":
      state.budgetExhausted = true;
      emit("budget_exhausted", {
        needed: usd(a.needed),
        remainingLimit: usd(a.remainingLimit),
        balance: usd(a.balance),
      });
      return;
    case "curve_completed":
      setStatus(a.token, "completed");
      emit("curve_completed", { token: a.token, symbol: a.symbol });
      return;
  }
  try {
    if (a.type === "buy") await buy(run, a, emit);
    else await sell(run, a, emit);
  } catch (e) {
    const d = describe(e);
    if (d.exitCode === KEY_EXPIRED_OR_REVOKED) throw new SessionEnded(d);
    const base = { token: a.token, symbol: a.symbol };
    if (d.error.code === "CURVE_COMPLETED") {
      if (a.type === "buy") emit("skipped", { ...base, reason: "not_trading" });
      else {
        setStatus(a.token, "completed");
        emit("curve_completed", base);
      }
      return;
    }
    if (a.type === "buy" && ["LIMIT_EXCEEDED", "INSUFFICIENT_BALANCE"].includes(d.error.code)) {
      state.budgetExhausted = true;
      emit("budget_exhausted", { ...base, needed: usd(a.amountIn), cause: d.error });
      return;
    }
    emit("error", { source: a.type, ...base, chainTime: now, exitCode: d.exitCode, ...d.error });
  }
}

async function buy(run: Run, a: Extract<Action, { type: "buy" }>, emit: LoopOptions["emit"]) {
  const { ctx, client, session } = run;
  // Re-quote right before the send (DESIGN §7.3).
  const quote = await quoteBuy(client, ctx.pad, a.token, a.amountIn);
  const plan = planBuy({
    launchpad: ctx.pad,
    quoteToken: ctx.book.mockUsd,
    token: a.token,
    recipient: session.account,
    amountIn: a.amountIn,
    quote,
    slippageBps: run.strategy.slippageBps,
    deadline: await ctx.deadline(),
  });
  const { hash, trades } = await send(
    run,
    { token: a.token, symbol: a.symbol, reason: "buy" },
    plan.calls,
  );
  const trade = trades.find((t) => isAddressEqual(t.token, a.token));
  emit("bought", {
    token: a.token,
    symbol: a.symbol,
    ...ctx.tx(hash),
    ageSeconds: a.ageSeconds,
    spent: usd(trade?.quotePulled ?? plan.amountIn),
    tokens: tok(trade?.tokens ?? 0n),
    fee: usd(trade?.fee ?? 0n),
    minOut: tok(plan.minOut),
  });
}

async function sell(run: Run, a: Extract<Action, { type: "sell" }>, emit: LoopOptions["emit"]) {
  const { ctx, client, session } = run;
  // The local model decided; the view decides again right before the send.
  const quote = await quoteSell(client, ctx.pad, a.token, a.amount);
  if (a.reason === "take_profit" && !meetsTakeProfit(run.strategy, quote.amountOut, a.costBasis)) {
    return;
  }
  const minOut = minOutFor(quote.amountOut, run.strategy.slippageBps);
  const call = sellCall(ctx.pad, {
    token: a.token,
    amount: a.amount,
    minOut,
    deadline: await ctx.deadline(),
    recipient: session.account,
  });
  const { hash, trades } = await send(run, a, [call]);
  const trade = trades.find((t) => isAddressEqual(t.token, a.token));
  const received = trade?.quotePulled ?? 0n;
  emit("sold", {
    token: a.token,
    symbol: a.symbol,
    reason: a.reason,
    ...ctx.tx(hash),
    sold: tok(trade?.tokens ?? a.amount),
    received: usd(received),
    fee: usd(trade?.fee ?? 0n),
    minOut: usd(minOut),
    costBasis: usd(a.costBasis),
    pnl: usd(received - a.costBasis),
  });
}
