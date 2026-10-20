// Command-mode building blocks without a chain: the watcher against a lagging RPC, the journal and
// cost basis, the revert → meme error mapping, SPONSOR_BUSY backoff and the cross-process send lock.
import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type AgentSession,
  ExecutionRevertedError,
  SponsorBusyError,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  type Address,
  createClient,
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  type Hex,
  keccak256,
  parseAbi,
  type TransactionReceipt,
  toHex,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  appendJournal,
  CurveCompletedError,
  CurveModelError,
  costBasis,
  execute,
  InsufficientBalanceError,
  type JournalRecord,
  journalPath,
  type LaunchpadEvent,
  memeLaunchpadAbi,
  memeTokenAbi,
  readJournal,
  retrySponsorBusy,
  SlippageError,
  toMemeError,
  tradesOf,
  UnknownTokenError,
  watch,
  withSendLock,
} from "../src/index.js";

const PAD: Address = "0x00000000000000000000000000000000000000aa";
const TOKEN: Address = "0x00000000000000000000000000000000000000bb";
const ME: Address = "0x00000000000000000000000000000000000000cc";
const OTHER: Address = "0x00000000000000000000000000000000000000dd";
const KEY: Hex = keccak256("0x01");

/** A `Trade` log in RPC form. */
function tradeLog(o: {
  block: bigint;
  logIndex: number;
  tx: Hex;
  trader?: Address;
  address?: Address;
  isBuy?: boolean;
  quote?: bigint;
  tokens?: bigint;
  fee?: bigint;
}) {
  return {
    address: o.address ?? PAD,
    topics: encodeEventTopics({
      abi: memeLaunchpadAbi,
      eventName: "Trade",
      args: { token: TOKEN, trader: o.trader ?? ME },
    }),
    data: encodeAbiParameters(
      [
        { type: "address" },
        { type: "bool" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [o.trader ?? ME, o.isBuy ?? true, o.quote ?? 1n, o.tokens ?? 2n, o.fee ?? 0n, 0n, 0n],
    ),
    blockNumber: toHex(o.block),
    blockHash: keccak256(toHex(o.block)),
    transactionHash: o.tx,
    transactionIndex: "0x0",
    logIndex: toHex(o.logIndex),
    removed: false,
  };
}

describe("watch", () => {
  /**
   * A load-balanced RPC: `eth_blockNumber` reaches a node at the tip (which grows a block per
   * poll up to `end`), every `eth_getLogs` a node `lag` polls behind.
   */
  function laggingRpc(logs: ReturnType<typeof tradeLog>[], start: bigint, end: bigint, lag = 2) {
    const heights: bigint[] = [];
    let height = start;
    const transport = custom({
      async request({ method, params }) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_blockNumber") {
          if (height < end) height++;
          heights.push(height);
          return toHex(height);
        }
        if (method === "eth_getLogs") {
          const [{ fromBlock, toBlock }] = params as [{ fromBlock: Hex; toBlock: Hex }];
          const behind = heights[heights.length - 1 - lag] ?? start;
          const to = BigInt(toBlock) < behind ? BigInt(toBlock) : behind;
          return logs.filter((l) => {
            const b = BigInt(l.blockNumber);
            return b >= BigInt(fromBlock) && b <= to;
          });
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    return { client: createClient({ transport }), polls: () => heights.length };
  }

  // Several logs per block, per transaction, and in consecutive blocks.
  const logs = [
    tradeLog({ block: 101n, logIndex: 0, tx: keccak256("0xa1") }),
    tradeLog({ block: 101n, logIndex: 1, tx: keccak256("0xa1") }),
    tradeLog({ block: 102n, logIndex: 0, tx: keccak256("0xa2") }),
    tradeLog({ block: 104n, logIndex: 3, tx: keccak256("0xa4") }),
    tradeLog({ block: 104n, logIndex: 5, tx: keccak256("0xa5") }),
    tradeLog({ block: 105n, logIndex: 0, tx: keccak256("0xa6") }),
    tradeLog({ block: 109n, logIndex: 2, tx: keccak256("0xa9") }),
    tradeLog({ block: 110n, logIndex: 0, tx: keccak256("0xaa") }),
  ];
  const id = (l: { transactionHash: Hex | null; logIndex: number | null }) =>
    `${l.transactionHash}:${l.logIndex}`;

  it("reports every log exactly once, in chain order, although getLogs answers from a node behind", async () => {
    const rpc = laggingRpc(logs, 100n, 110n);
    const stop = new AbortController();
    const seen: LaunchpadEvent[] = [];
    const done = (async () => {
      for await (const log of watch(rpc.client, PAD, {
        fromBlock: 101n,
        pollIntervalMs: 1,
        signal: stop.signal,
      })) {
        seen.push(log);
      }
    })();
    while (rpc.polls() < 25) await sleep(5);
    stop.abort();
    await done;
    expect(seen.map(id)).toEqual(logs.map((l) => `${l.transactionHash}:${BigInt(l.logIndex)}`));
    expect(seen[0]).toMatchObject({ eventName: "Trade", args: { token: TOKEN, trader: ME } });
  });

  it("without the overlap re-scan the lagging node's missing logs would be lost (control)", async () => {
    const rpc = laggingRpc(logs, 100n, 110n);
    const stop = new AbortController();
    const seen: LaunchpadEvent[] = [];
    const done = (async () => {
      for await (const log of watch(rpc.client, PAD, {
        fromBlock: 101n,
        pollIntervalMs: 1,
        overlap: 0n,
        signal: stop.signal,
      })) {
        seen.push(log);
      }
    })();
    while (rpc.polls() < 25) await sleep(5);
    stop.abort();
    await done;
    expect(seen.length).toBeLessThan(logs.length);
  });

  it("a failed poll goes to onError and is retried; without onError it throws", async () => {
    let fail = true;
    const transport = custom(
      {
        async request({ method }) {
          if (method === "eth_blockNumber") {
            if (fail) {
              fail = false;
              throw new Error("rate limited");
            }
            return "0x65";
          }
          if (method === "eth_getLogs") return [logs[0]];
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    );
    const client = createClient({ transport });
    const errors: unknown[] = [];
    for await (const log of watch(client, PAD, {
      fromBlock: 101n,
      pollIntervalMs: 1,
      onError: (e) => errors.push(e),
    })) {
      expect(id(log)).toBe(`${logs[0]?.transactionHash}:0`);
      break;
    }
    expect(errors).toHaveLength(1);
    fail = true;
    await expect(watch(client, PAD, { fromBlock: 101n }).next()).rejects.toThrow(/rate limited/);
  });
});

describe("journal", () => {
  const receipt = (logs: ReturnType<typeof tradeLog>[]) =>
    ({
      transactionHash: keccak256("0xfeed"),
      blockNumber: 42n,
      logs: logs.map((l) => ({
        ...l,
        blockNumber: BigInt(l.blockNumber),
        logIndex: Number(l.logIndex),
        transactionIndex: 0,
      })),
    }) as unknown as TransactionReceipt;

  it("takes the records from the transaction's own Trade logs of this account on this launchpad", () => {
    const tx = keccak256("0xfeed");
    const records = tradesOf(
      receipt([
        tradeLog({ block: 42n, logIndex: 0, tx, quote: 5_000_000n, tokens: 7n, fee: 50_000n }),
        tradeLog({ block: 42n, logIndex: 1, tx, trader: OTHER }),
        tradeLog({ block: 42n, logIndex: 2, tx, address: OTHER }),
        tradeLog({ block: 42n, logIndex: 3, tx, isBuy: false, quote: 1n, tokens: 3n, fee: 2n }),
      ]),
      PAD,
      ME,
      KEY,
    );
    expect(records).toEqual([
      {
        keyHash: KEY,
        txHash: tx,
        token: TOKEN,
        side: "buy",
        quotePulled: 5_000_000n,
        tokens: 7n,
        fee: 50_000n,
        blockNumber: 42n,
      },
      {
        keyHash: KEY,
        txHash: tx,
        token: TOKEN,
        side: "sell",
        quotePulled: 1n,
        tokens: 3n,
        fee: 2n,
        blockNumber: 42n,
      },
    ]);
  });

  const rec = (side: "buy" | "sell", quotePulled: bigint, tokens: bigint, keyHash = KEY) =>
    ({
      keyHash,
      txHash: zeroHash,
      token: TOKEN,
      side,
      quotePulled,
      tokens,
      fee: 0n,
      blockNumber: 1n,
    }) satisfies JournalRecord;

  it("weighted cost basis: buys add their quote incl. fee, sells remove their average cost", () => {
    const records = [rec("buy", 100n, 10n), rec("buy", 300n, 10n), rec("sell", 999n, 5n)];
    // 400 for 20 tokens; selling 5 removes a quarter of the cost, whatever the proceeds.
    expect(costBasis(records, KEY, TOKEN, 15n)).toBe(300n);
    // Another session's records are not this key's cost.
    expect(costBasis([...records, rec("buy", 7n, 1n, zeroHash)], KEY, TOKEN, 15n)).toBe(300n);
  });

  it("is unknown (null) unless the journal accounts for exactly the inventory", () => {
    expect(costBasis([], KEY, TOKEN, 10n)).toBeNull();
    expect(costBasis([rec("buy", 100n, 10n)], KEY, TOKEN, 11n)).toBeNull();
    expect(costBasis([rec("buy", 100n, 10n)], KEY, TOKEN, 9n)).toBeNull();
    expect(costBasis([rec("sell", 1n, 1n), rec("buy", 100n, 10n)], KEY, TOKEN, 10n)).toBeNull();
    expect(costBasis([rec("buy", 100n, 10n), rec("sell", 1n, 10n)], KEY, TOKEN, 0n)).toBeNull();
  });

  it("appends JSON lines under <home>/meme and reads them back; no journal reads as empty", () => {
    const home = mkdtempSync(join(tmpdir(), "meme-journal-"));
    expect(readJournal(home)).toEqual([]);
    const records = [rec("buy", 100n, 10n), rec("sell", 50n, 4n)];
    appendJournal(home, records.slice(0, 1));
    appendJournal(home, records.slice(1));
    expect(journalPath(home)).toBe(join(home, "meme", "journal.jsonl"));
    expect(readJournal(home)).toEqual(records);
  });

  it("a last line cut short by a crash is read past and repaired by the next append", () => {
    const home = mkdtempSync(join(tmpdir(), "meme-journal-"));
    const [a, b, c] = [rec("buy", 100n, 10n), rec("sell", 50n, 4n), rec("buy", 7n, 1n)];
    appendJournal(home, [a]);
    appendFileSync(journalPath(home), '{"keyHash":');
    expect(readJournal(home)).toEqual([a]);
    appendJournal(home, [b]);
    expect(readJournal(home)).toEqual([a, b]);
    expect(readFileSync(journalPath(home), "utf8")).not.toContain('{"keyHash":{');

    // A complete record whose newline was lost is kept, and the next one starts on its own line.
    const line = readFileSync(journalPath(home), "utf8").trimEnd().split("\n").at(-1) as string;
    appendFileSync(journalPath(home), line);
    expect(readJournal(home)).toEqual([a, b, b]);
    appendJournal(home, [c]);
    expect(readJournal(home)).toEqual([a, b, b, c]);
  });

  it("corruption before the last line still throws", () => {
    const home = mkdtempSync(join(tmpdir(), "meme-journal-"));
    appendJournal(home, [rec("buy", 100n, 10n)]);
    appendFileSync(journalPath(home), '{"keyHash":\n');
    expect(() => readJournal(home)).toThrow();
    appendJournal(home, [rec("buy", 7n, 1n)]);
    expect(() => readJournal(home)).toThrow();
  });
});

describe("toMemeError", () => {
  const callFailed = parseAbi(["error CallFailed(bytes reason)"]);
  const pad = (errorName: "CurveAlreadyCompleted" | "InsufficientOutput" | "UnknownToken") =>
    encodeErrorResult({ abi: memeLaunchpadAbi, errorName });
  const wrapped = (data: Hex) =>
    new ExecutionRevertedError({
      data: encodeErrorResult({ abi: callFailed, errorName: "CallFailed", args: [data] }),
    });

  it("maps the launchpad reverts, unwrapped from Calibur's CallFailed", () => {
    expect(toMemeError(wrapped(pad("CurveAlreadyCompleted")))).toBeInstanceOf(CurveCompletedError);
    expect(toMemeError(wrapped(pad("InsufficientOutput")))).toBeInstanceOf(SlippageError);
    const unknown = toMemeError(new ExecutionRevertedError({ data: pad("UnknownToken") }));
    expect(unknown).toBeInstanceOf(UnknownTokenError);
    expect((unknown as UnknownTokenError).code).toBe("UNKNOWN_TOKEN");
  });

  it("maps an ERC20 balance revert to InsufficientBalanceError with the amounts", () => {
    const data = encodeErrorResult({
      abi: memeTokenAbi,
      errorName: "ERC20InsufficientBalance",
      args: [ME, 3n, 5n],
    });
    const e = toMemeError(wrapped(data)) as InsufficientBalanceError;
    expect(e).toBeInstanceOf(InsufficientBalanceError);
    expect([e.code, e.balance, e.needed]).toEqual(["INSUFFICIENT_BALANCE", 3n, 5n]);
  });

  it("maps the local model's completed curve; anything else passes through unchanged", () => {
    expect(toMemeError(new CurveModelError("CurveAlreadyCompleted"))).toBeInstanceOf(
      CurveCompletedError,
    );
    for (const e of [
      new CurveModelError("ZeroOutput"),
      new ExecutionRevertedError({ data: "0xdeadbeef" }),
      new ExecutionRevertedError({ reason: "Transaction reverted" }),
      new SponsorBusyError(),
      new Error("x"),
    ]) {
      expect(toMemeError(e)).toBe(e);
    }
  });
});

describe("execute", () => {
  /** `execute` of one call whose receipt (status `status`) holds one Trade log of this account. */
  async function sent(status: "0x0" | "0x1", correlationId?: string) {
    const hash = keccak256("0xbad");
    // As the published AgentSession.exec resolves when the executor (the sponsor's word) says success.
    const session = {
      account: ME,
      keyHash: KEY,
      exec: async () => ({ hash, success: true }),
    } as unknown as AgentSession;
    const receipt = {
      transactionHash: hash,
      transactionIndex: "0x0",
      blockHash: keccak256("0x2a"),
      blockNumber: "0x2a",
      from: OTHER,
      to: ME,
      contractAddress: null,
      cumulativeGasUsed: "0x1",
      gasUsed: "0x1",
      effectiveGasPrice: "0x1",
      logsBloom: `0x${"00".repeat(256)}`,
      logs: [tradeLog({ block: 42n, logIndex: 0, tx: hash })],
      status,
      type: "0x2",
    };
    const client = createClient({
      transport: custom({
        async request({ method }) {
          if (method === "eth_getTransactionReceipt") return receipt;
          throw new Error(`unexpected ${method}`);
        },
      }),
    });
    const home = mkdtempSync(join(tmpdir(), "meme-execute-"));
    const calls = [{ to: OTHER, data: "0x" as Hex, value: 0n }];
    const result = await execute({
      session,
      client,
      home,
      launchpad: PAD,
      calls,
      ...(correlationId !== undefined && { correlationId }),
    }).catch((e: unknown) => e);
    return { hash, home, result };
  }

  it("a reverted receipt is ExecutionRevertedError with its hash, though the executor reported success; nothing is journalled", async () => {
    // The chain's receipt says reverted. Its Trade log is never on chain; it shows nothing is parsed.
    const { hash, home, result: err } = await sent("0x0");
    expect(err).toBeInstanceOf(ExecutionRevertedError);
    expect((err as ExecutionRevertedError).message).toContain(hash);
    expect(readJournal(home)).toEqual([]);
  });

  it("journals the caller's correlationId with the transaction's records; without one, records are as before", async () => {
    const tagged = await sent("0x1", "trade-1");
    expect(readJournal(tagged.home)).toEqual([
      expect.objectContaining({ txHash: tagged.hash, side: "buy", correlationId: "trade-1" }),
    ]);
    expect((tagged.result as { trades: JournalRecord[] }).trades[0]?.correlationId).toBe("trade-1");

    const plain = await sent("0x1");
    const [record] = readJournal(plain.home);
    expect(record).toMatchObject({ txHash: plain.hash, side: "buy" });
    expect(Object.keys(record as object)).not.toContain("correlationId");
  });
});

describe("retrySponsorBusy", () => {
  it("retries SPONSOR_BUSY with backoff until the request goes through", async () => {
    let calls = 0;
    const result = await retrySponsorBusy(async () => {
      if (++calls < 3) throw new SponsorBusyError();
      return "sent";
    });
    expect([result, calls]).toEqual(["sent", 3]);
  });

  it("surfaces SPONSOR_BUSY once the backoff budget is spent, and any other error at once", async () => {
    let calls = 0;
    const busy = () => {
      calls++;
      return Promise.reject(new SponsorBusyError());
    };
    await expect(retrySponsorBusy(busy, 100)).rejects.toBeInstanceOf(SponsorBusyError);
    expect(calls).toBe(1);
    const other = new Error("rejected");
    await expect(retrySponsorBusy(() => Promise.reject(other))).rejects.toBe(other);
  });
});

describe("send lock", () => {
  const child = fileURLToPath(new URL("./fixtures/locked-request.ts", import.meta.url));
  const hooks = fileURLToPath(new URL("./fixtures/node-ts.mjs", import.meta.url));
  const run = (home: string, url: string) =>
    promisify(execFile)(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", "--import", hooks, child, home, url],
      { timeout: 20_000 },
    );

  /** A sponsor with one in-flight request per account, each taking 400 ms; counts refusals. */
  async function sponsor() {
    const s = { url: "", busy: 0, close: () => {} };
    let inFlight = 0;
    const server = createServer(async (_req, res) => {
      if (inFlight > 0) {
        s.busy++;
        res.end("SPONSOR_BUSY");
        return;
      }
      inFlight++;
      await sleep(400);
      inFlight--;
      res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    s.close = () => server.close();
    return s;
  }

  it("serialises two OS processes sending for one account: neither sees SPONSOR_BUSY", async () => {
    const s = await sponsor();
    try {
      const home = mkdtempSync(join(tmpdir(), "meme-lock-"));
      const answers = await Promise.all([run(home, s.url), run(home, s.url)]);
      expect(answers.map((a) => a.stdout)).toEqual(["ok", "ok"]);
      expect(s.busy).toBe(0);

      // Control: the same two requests without the lock collide.
      await Promise.all([fetch(s.url, { method: "POST" }), sleep(50).then(() => fetch(s.url))]);
      expect(s.busy).toBe(1);
    } finally {
      s.close();
    }
  }, 30_000);

  it("breaks a lock left by a process that is gone, and times out on a live one", async () => {
    const home = mkdtempSync(join(tmpdir(), "meme-lock-"));
    mkdirSync(join(home, "meme"));
    const lock = join(home, "meme", "send.lock");

    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.once("exit", r));
    writeFileSync(lock, String(gone.pid));
    expect(await withSendLock(home, async () => "ran")).toBe("ran");

    writeFileSync(lock, String(process.ppid));
    await expect(
      withSendLock(home, async () => "ran", { timeoutMs: 300, retryMs: 20 }),
    ).rejects.toThrow(/send\.lock/);
    rmSync(lock);
  });

  /** A lock file with `content`, last written `age` ms ago. */
  const leftLock = (home: string, content: string, age: number) => {
    const lock = join(home, "meme", "send.lock");
    mkdirSync(join(home, "meme"), { recursive: true });
    writeFileSync(lock, content);
    const t = (Date.now() - age) / 1000;
    utimesSync(lock, t, t);
    return lock;
  };

  it("breaks an empty or garbage lock older than 10 s (a creator that died before its pid), never a fresh one", async () => {
    const home = mkdtempSync(join(tmpdir(), "meme-lock-"));
    const quick = { timeoutMs: 300, retryMs: 20 };
    for (const content of ["", "garbage", "12x"]) {
      const lock = leftLock(home, content, 11_000);
      expect(await withSendLock(home, async () => "ran", quick)).toBe("ran");
      expect(existsSync(lock)).toBe(false);
    }
    // A creator between its exclusive create and its pid write is not robbed.
    const lock = leftLock(home, "", 5_000);
    await expect(withSendLock(home, async () => "ran", quick)).rejects.toThrow(/send\.lock/);
    expect(readFileSync(lock, "utf8")).toBe("");
  });

  it("two OS processes recovering one empty crash-left lock hold it one at a time", async () => {
    const s = await sponsor();
    try {
      const home = mkdtempSync(join(tmpdir(), "meme-lock-"));
      leftLock(home, "", 11_000);
      const answers = await Promise.all([run(home, s.url), run(home, s.url)]);
      expect(answers.map((a) => a.stdout)).toEqual(["ok", "ok"]);
      expect(s.busy).toBe(0);
    } finally {
      s.close();
    }
  }, 30_000);
});
