// The CLI without a chain: the exit-code mapping table (DESIGN §6.3), the `--json` envelope of
// usage errors, `policy init`'s file, and the binary's entry point.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_CODES, UsageError } from "@0xwh1sker/mantle-aa-cli";
import {
  DeadlineOutOfRangeError,
  ExecutionRevertedError,
  InventoryExceededError,
  KeyExpiredError,
  LimitExceededError,
  loadDeployments,
  PolicyViolationError,
  RuleKind,
  SELECTORS,
  SponsorBusyError,
  SponsorRejectedError,
  saveProfile,
} from "@0xwh1sker/mantle-aa-sdk";
import {
  AutopilotStateError,
  CurveCompletedError,
  InsufficientBalanceError,
  loadDeployments as memeDeployments,
  memeLaunchpadAbi,
  SlippageError,
  UnknownTokenError,
} from "@0xwh1sker/mantle-meme-sdk";
import {
  type Address,
  decodeFunctionData,
  encodeErrorResult,
  type Hex,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from "viem";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { CURVE_COMPLETED_TEXT, describe as describeError, EXIT } from "../src/errors.js";
import { mantleMeme } from "./helpers.js";

const TOKEN = "0x00000000000000000000000000000000000000a1" as Address;
const revert = (errorName: "CurveAlreadyCompleted" | "InsufficientOutput" | "UnknownToken") =>
  encodeErrorResult({ abi: memeLaunchpadAbi, errorName });
const callFailed = parseAbi(["error CallFailed(bytes reason)"]);

/** Every row of the mapping: an error the CLI can meet → exit code and `error.code`. */
const TABLE: [string, unknown, number, string][] = [
  ["usage", new UsageError("--amount is required"), 1, "USAGE"],
  ["unknown error", new Error("boom"), 1, "ERROR"],
  [
    "policy violation",
    new PolicyViolationError({ reason: "x", callIndex: 0 }),
    10,
    "POLICY_VIOLATION",
  ],
  ["deadline out of range", new DeadlineOutOfRangeError({ deadline: 1 }), 10, "POLICY_VIOLATION"],
  [
    "limit",
    new LimitExceededError({ asset: TOKEN, remaining: 1n, requested: 2n }),
    11,
    "LIMIT_EXCEEDED",
  ],
  [
    "inventory",
    new InventoryExceededError({ token: TOKEN, held: 1n, requested: 2n }),
    12,
    "INVENTORY_EXCEEDED",
  ],
  [
    "key expired",
    new KeyExpiredError({ keyHash: zeroHash, expiry: 1 }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "session revoked",
    new PolicyViolationError({ reason: "Session is revoked" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  [
    "sponsor: key inactive",
    new SponsorRejectedError({ reason: "KEY_INACTIVE" }),
    13,
    "KEY_EXPIRED_OR_REVOKED",
  ],
  ["sponsor rejected", new SponsorRejectedError({ reason: "BUDGET" }), 20, "SPONSOR_REJECTED"],
  ["sponsor busy", new SponsorBusyError(), 21, "SPONSOR_BUSY"],
  ["reverted", new ExecutionRevertedError({ reason: "reverted" }), 30, "EXECUTION_REVERTED"],
  // Calibur's bare CallFailed() (measured): no launchpad revert to decode, so 30 unless the SDK diagnosed it.
  [
    "bare CallFailed()",
    new ExecutionRevertedError({ data: "0x3204506f" }),
    30,
    "EXECUTION_REVERTED",
  ],
  ["curve completed", new CurveCompletedError(), 40, "CURVE_COMPLETED"],
  ["slippage", new SlippageError(), 41, "SLIPPAGE"],
  ["unknown token", new UnknownTokenError(), 42, "UNKNOWN_TOKEN"],
  [
    "insufficient balance",
    new InsufficientBalanceError({ balance: 1n, needed: 2n }),
    43,
    "INSUFFICIENT_BALANCE",
  ],
  ["autopilot state", new AutopilotStateError("already running"), 44, "AUTOPILOT_STATE"],
  // Launchpad reverts, plain or wrapped in Calibur's CallFailed(bytes).
  [
    "revert CurveAlreadyCompleted",
    new ExecutionRevertedError({ data: revert("CurveAlreadyCompleted") }),
    40,
    "CURVE_COMPLETED",
  ],
  [
    "revert InsufficientOutput",
    new ExecutionRevertedError({ data: revert("InsufficientOutput") }),
    41,
    "SLIPPAGE",
  ],
  [
    "revert UnknownToken",
    new ExecutionRevertedError({ data: revert("UnknownToken") }),
    42,
    "UNKNOWN_TOKEN",
  ],
  [
    "CallFailed(InsufficientOutput)",
    new ExecutionRevertedError({
      data: encodeErrorResult({
        abi: callFailed,
        errorName: "CallFailed",
        args: [revert("InsufficientOutput")],
      }),
    }),
    41,
    "SLIPPAGE",
  ],
  // `execute` diagnoses a failed batch into a meme error whose cause is the AA error: the meme code wins.
  [
    "diagnosed revert",
    Object.assign(new InsufficientBalanceError({ balance: 0n, needed: 1n }), {
      cause: new ExecutionRevertedError({ reason: "reverted" }),
    }),
    43,
    "INSUFFICIENT_BALANCE",
  ],
];

describe("exit-code mapping (DESIGN §6.3)", () => {
  const rows = TABLE.map(([name, error, exitCode, code]) => ({ name, error, exitCode, code }));
  it.each(rows)("$name → exit $exitCode ($code)", ({ error, exitCode, code }) => {
    const d = describeError(error);
    expect(d).toMatchObject({ exitCode, error: { code } });
    expect(typeof d.error.type).toBe("string");
    expect(typeof d.error.message).toBe("string");
  });

  it("AA codes pass through unchanged and the meme codes are 40–44", () => {
    expect(EXIT).toEqual({
      OK: 0,
      ERROR: 1,
      POLICY_VIOLATION: 10,
      LIMIT_EXCEEDED: 11,
      INVENTORY_EXCEEDED: 12,
      KEY_EXPIRED_OR_REVOKED: 13,
      SPONSOR_REJECTED: 20,
      SPONSOR_BUSY: 21,
      EXECUTION_REVERTED: 30,
      CURVE_COMPLETED: 40,
      SLIPPAGE: 41,
      UNKNOWN_TOKEN: 42,
      INSUFFICIENT_BALANCE: 43,
      AUTOPILOT_STATE: 44,
    });
    expect(Object.entries(EXIT_CODES).every(([k, v]) => EXIT[k as keyof typeof EXIT] === v)).toBe(
      true,
    );
  });

  it("exit 40 says the §4.5 text verbatim, never 'graduated'", () => {
    const d = describeError(new CurveCompletedError("anything"));
    expect(d.error.message).toBe(
      "Curve completed; trading is disabled. This v1 launchpad has no migration path, so the position is stranded.",
    );
    expect(CURVE_COMPLETED_TEXT).not.toMatch(/graduat/i);
  });

  it("the error carries the structured fields: candidates, balance and limit amounts", () => {
    const candidates = [{ address: TOKEN, name: "Pepe", symbol: "PEPE" }];
    expect(describeError(new UnknownTokenError("ambiguous", candidates)).error).toMatchObject({
      candidates,
    });
    expect(
      describeError(new InsufficientBalanceError({ balance: 1n, needed: 2n })).error,
    ).toMatchObject({ balance: 1n, needed: 2n });
    expect(
      describeError(new LimitExceededError({ asset: TOKEN, remaining: 1n, requested: 2n })).error,
    ).toMatchObject({ asset: TOKEN, remaining: 1n, requested: 2n });
  });
});

/** Runs the CLI in process; `stdout` parsed as JSON. */
async function cli(argv: string[], env: NodeJS.ProcessEnv = {}) {
  let out = "";
  let err = "";
  const code = await run(argv, {
    env,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  });
  // biome-ignore lint/suspicious/noExplicitAny: the shape is what the tests assert
  let json: any;
  try {
    json = JSON.parse(out);
  } catch {}
  return { code, out, err, json };
}

describe("usage errors", () => {
  it.each([
    [["frob", "--json"], null, /unknown command/],
    [["buy", "--json", "PEPE"], "buy", /--amount is required/],
    [["buy", "PEPE", "--amount", "1.0000001", "--json"], "buy", /at most 6 decimals/],
    [["buy", "PEPE", "--amount", "0", "--json"], "buy", /greater than 0/],
    [["buy", "PEPE", "--amount", "1", "--slippage", "101", "--json"], "buy", /at most 100/],
    [["sell", "PEPE", "--all", "--percent", "5", "--json"], "sell", /exactly one/],
    [["sell", "PEPE", "--json"], "sell", /exactly one/],
    [["quote", "PEPE", "--json"], "quote", /exactly one/],
    [["claim", "--json"], "claim", /either <token> or --all/],
    [["list", "--status", "graduated", "--json"], "list", /trading or completed/],
    [["list", "--limit", "0", "--json"], "list", /--limit/],
    [["info", "A", "B", "--json"], "info", /unexpected argument "B"/],
    [["portfolio", "--bogus", "--json"], "portfolio", /bogus/],
    [["buy", "PEPE", "--amount", "1", "--json"], "buy", /no RPC URL: set MANTLE_AA_RPC_URL/],
    [["policy", "init", "--total", "10", "--per-day", "20", "--json"], "policy init", /--per-day/],
    [
      ["policy", "init", "--total", "10", "--per-day", "5", "--expiry", "2h", "--json"],
      "policy init",
      /--expiry must be 24h/,
    ],
  ])("%j → exit 1, USAGE", async (argv, command, message) => {
    const { code, json } = await cli(argv as string[]);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, command, exitCode: 1, error: { code: "USAGE" } });
    expect(json.error.message).toMatch(message);
  });

  it("without --json an error is one line on stderr", async () => {
    const { code, out, err } = await cli(["buy", "PEPE"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("error: --amount is required\n");
  });

  it("no arguments prints the usage and fails; --help succeeds", async () => {
    expect((await cli([])).code).toBe(1);
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^usage: mantle-meme/);
  });
});

describe("policy init (DESIGN §6.2)", () => {
  const book = memeDeployments();
  const pad = book.memeLaunchpad as Address;

  it("writes the grant policy: MockUSD limits, the launchpad as trusted spender, five permissions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meme-policy-"));
    const out = join(dir, "policy.json");
    const { code, json } = await cli(
      ["policy", "init", "--total", "100", "--per-day", "50.5", "--out", out, "--json"],
      { MANTLE_AA_HOME: join(dir, "home") },
    );
    expect(code).toBe(0);
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(json).toEqual({
      ok: true,
      command: "policy init",
      result: {
        file: out,
        agent: "trader",
        expirySeconds: 86400,
        policy: file,
        next: expect.any(Array),
      },
    });
    expect(file).toEqual({
      maxValuePerCall: "0",
      mntLimit: { token: zeroAddress, totalCap: "0", periodCap: "0" },
      quoteLimits: [{ token: book.mockUsd, totalCap: "100000000", periodCap: "50500000" }],
      periodLength: 86400,
      permissions: [
        { target: book.mockUsd, selector: "approve(address,uint256)", ruleKind: "ERC20_APPROVE" },
        {
          target: pad,
          selector: "buy(address,uint256,uint256,uint256,address)",
          ruleKind: "LAUNCHPAD_BUY",
        },
        {
          target: pad,
          selector: "sell(address,uint256,uint256,uint256,address)",
          ruleKind: "LAUNCHPAD_SELL",
        },
        {
          target: pad,
          selector: "createToken(string,string,string,string,bytes32)",
          ruleKind: "NONE",
        },
        { target: pad, selector: "claimCreatorFees(address)", ruleKind: "NONE" },
      ],
      trustedSpenders: [pad],
      maxDeadlineWindow: 600,
    });
    // The signatures are the ones the published AA SDK's hook rules know, with its rule kinds.
    const [approve, buy, sell, create, claim] = file.permissions.map(
      (p: { selector: string; ruleKind: keyof typeof RuleKind }) => [
        toFunctionSelector(p.selector),
        RuleKind[p.ruleKind],
      ],
    );
    expect([approve, buy, sell]).toEqual([
      [SELECTORS.approve, RuleKind.ERC20_APPROVE],
      [SELECTORS.buy, RuleKind.LAUNCHPAD_BUY],
      [SELECTORS.sell, RuleKind.LAUNCHPAD_SELL],
    ]);
    expect(create).toEqual([memeSelector("createToken"), RuleKind.NONE]);
    expect(claim).toEqual([memeSelector("claimCreatorFees"), RuleKind.NONE]);
    expect(book.chainId).toBe(loadDeployments().chainId);
  });

  it("prints the human's next mantle-aa commands; with a root profile, the exact mint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meme-policy-"));
    const home = join(dir, "home");
    const account = "0x00000000000000000000000000000000000000b2" as Address;
    saveProfile(
      "owner",
      { account, keyHash: zeroHash, keyfile: "owner.json", role: "root" },
      { home },
    );
    const out = join(dir, "p.json");
    const { json } = await cli(
      [
        "policy",
        "init",
        "--total",
        "7",
        "--per-day",
        "7",
        "--out",
        out,
        "--agent",
        "bot",
        "--json",
      ],
      { MANTLE_AA_HOME: home },
    );
    const next = json.result.next;
    expect(next.slice(0, 2)).toEqual([
      `mantle-aa account init --grant ${out} --agent bot`,
      "mantle-aa session export --agent bot --out ~/.mantle-meme-agent",
    ]);
    const calls = JSON.parse(/--calls '(.*)'$/.exec(next[2] as string)?.[1] as string);
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe(memeDeployments().mockUsd);
    const mint = parseAbi(["function mint(address to, uint256 amount)"]);
    expect(decodeFunctionData({ abi: mint, data: calls[0].data as Hex }).args).toEqual([
      account,
      7_000_000n,
    ]);

    // Without a root profile the human creates the root key first.
    const fresh = await cli(
      ["policy", "init", "--total", "1", "--per-day", "1", "--out", out, "--json"],
      {
        MANTLE_AA_HOME: join(dir, "empty"),
      },
    );
    expect(fresh.json.result.next[0]).toBe("mantle-aa keys new --name owner");
  });

  it("without --json prints the next steps as text", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meme-policy-"));
    const out = join(dir, "policy.json");
    const { code, out: text } = await cli(
      ["policy", "init", "--total", "1", "--per-day", "1", "--out", out],
      {
        MANTLE_AA_HOME: join(dir, "home"),
      },
    );
    expect(code).toBe(0);
    expect(text).toContain(`Wrote ${out}`);
    expect(text).toContain(`mantle-aa account init --grant ${out} --agent trader`);
  });
});

const memeSelector = (name: string) =>
  toFunctionSelector(
    memeLaunchpadAbi.find((x) => x.type === "function" && x.name === name) as never,
  );

describe("the mantle-meme binary", () => {
  it("runs from its entry point with the envelope and exit code", async () => {
    const r = await mantleMeme(["info", "PEPE", "--json"], {});
    expect(r.code).toBe(1);
    expect(r.json).toEqual({
      ok: false,
      command: "info",
      exitCode: 1,
      error: { code: "USAGE", type: "UsageError", message: "no RPC URL: set MANTLE_AA_RPC_URL" },
    });
  });
});
