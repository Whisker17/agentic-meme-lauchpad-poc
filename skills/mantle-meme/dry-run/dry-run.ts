// Dry run of the mantle-meme skill (DESIGN §9.2 steps 2–8) on an anvil fork of Mantle Sepolia: no
// Telegram, no Sepolia spend. It reuses the §9.1 acceptance flow's setup (fork, `mantle-aa sponsor
// serve`, market-sim, the human's `policy init` → `account init --grant` → `session export` → mint),
// then sends each step as one natural-language message to an agent, drives market-sim between them,
// and writes a scrubbed transcript: message → the `mantle-meme` commands the agent ran → its reply.
//
//   pnpm build
//   MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz \
//   node --experimental-transform-types --no-warnings \
//     --import ./packages/cli/test/fixtures/node-ts.mjs skills/mantle-meme/dry-run/dry-run.ts
//
// Env:
//   DRY_RUN_AGENT  a shell command that runs one agent turn. It gets the message in $DRY_RUN_MESSAGE,
//                  a stable session id in $DRY_RUN_SESSION, the agent's working directory in
//                  $DRY_RUN_WORKSPACE, this skill's parent directory in $DRY_RUN_SKILLS, the agent
//                  environment (MANTLE_AA_*, PATH with the recording `mantle-meme`) and prints the
//                  reply on stdout (plain text, or a JSON envelope with `final` / `payloads`).
//                  Default: OpenClaw's embedded agent (see README.md).
//   DRY_RUN_SETUP, DRY_RUN_TEARDOWN  optional shell commands run once after the human's setup
//                  (with the turn's environment plus $DRY_RUN_AGENT_HOME) and once at the end,
//                  e.g. to start and remove the OpenClaw container; with a teardown, it alone stops
//                  the autopilot daemon.
//   DRY_RUN_HOST   the host name the agent reaches this machine at (default 127.0.0.1; in Docker
//                  host.docker.internal): the agent's RPC and sponsor URLs use it.
//   DRY_RUN_CLI    the built `mantle-meme.js` as the agent sees it (default: this checkout's)
//   DRY_RUN_DIR    homes, sponsor, logs and the transcript (default under $TMPDIR)
//
// The commands the agent ran are recorded by a `mantle-meme` shim in <agent home>/.dry-run, put
// first on the agent's PATH. Where the agent's shell resets PATH (OpenClaw in Docker), the setup
// links the agent's `mantle-meme` to it instead (README.md).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, parseEther, toHex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { Acceptance, runStep, STEPS } from "../../../e2e/acceptance/flow.js";
import { startFork } from "../../../e2e/launchpad/fork.js";
import { readEvents } from "../../../packages/cli/src/autopilot.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const upstream = process.env.MANTLE_SEPOLIA_RPC_URL;
if (!upstream) throw new Error("MANTLE_SEPOLIA_RPC_URL is required");
const dir = process.env.DRY_RUN_DIR ?? mkdtempSync(join(tmpdir(), "mantle-meme-dry-run-"));
mkdirSync(dir, { recursive: true, mode: 0o700 });
const workspace = join(dir, "workspace");
mkdirSync(workspace, { recursive: true });
const log = (line: string) => appendFileSync(join(dir, "run.log"), `${line}\n`);

const cli = process.env.DRY_RUN_CLI ?? join(repo, "packages/cli/dist/bin/mantle-meme.js");
const host = process.env.DRY_RUN_HOST ?? "127.0.0.1";

const DEFAULT_AGENT =
  'openclaw agent --local --session-id "$DRY_RUN_SESSION" --message "$DRY_RUN_MESSAGE" --json';
const agentCmd = process.env.DRY_RUN_AGENT ?? DEFAULT_AGENT;
const { DRY_RUN_SETUP: setupCmd, DRY_RUN_TEARDOWN: teardownCmd } = process.env;

const fork = await startFork(upstream);
const keys = [0, 1, 2].map(() => generatePrivateKey());
const sim = keys.map((k) => privateKeyToAccount(k));
const chain = createPublicClient({ transport: http(fork.url) });
for (const s of sim) {
  await chain.request({
    method: "anvil_setBalance" as never,
    params: [s.address, toHex(parseEther("10"))] as never,
  });
}
const relayer = mnemonicToAccount("test test test test test test test test test test test junk", {
  addressIndex: 4,
});
const a = new Acceptance({
  mode: "fork",
  rpcUrl: fork.url,
  relayerKey: toHex(relayer.getHdKey().privateKey as Uint8Array),
  sim,
  dir,
  tickMs: 1_000,
  pollMs: 500,
  secrets: keys,
  log,
});

interface Cmd {
  argv: string[];
  exitCode: number;
  stdout: string;
}
interface Turn {
  step: string;
  message: string;
  commands: Cmd[];
  reply: string;
  checks: [string, boolean][];
}
// The recording shim: runs the built CLI and appends {argv, exitCode, stdout} per call. Written
// into the agent home once `session export` has created it, so a container mounting that home sees it.
const bin = join(a.agentHome, ".dry-run");
const commands = join(bin, "commands.jsonl");
function writeShim() {
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "mantle-meme"),
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const argv = process.argv.slice(2);
const r = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...argv], { stdio: ["inherit", "pipe", "pipe"], encoding: "utf8", maxBuffer: 1 << 26 });
process.stdout.write(r.stdout ?? ""); process.stderr.write(r.stderr ?? "");
appendFileSync(require("node:path").join(__dirname, "commands.jsonl"), JSON.stringify({ argv, exitCode: r.status, stdout: r.stdout }) + "\\n");
process.exit(r.status ?? 1);
`,
  );
  chmodSync(join(bin, "mantle-meme"), 0o755);
  writeFileSync(join(bin, "package.json"), '{"type":"commonjs"}');
}

/** Runs a shell command with the agent's environment (async: the flow's proxies run in-process). */
function sh(cmd: string, extra: Record<string, string> = {}) {
  // The agent home and its password, the agent RPC and the sponsor (set by `a.start()`).
  const agentEnv = Object.fromEntries(
    Object.entries((a as unknown as { agentEnv: Record<string, string> }).agentEnv).map(
      ([k, v]) => [k, v.replace("//127.0.0.1:", `//${host}:`)],
    ),
  );
  return new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
    execFile(
      "sh",
      ["-c", cmd],
      {
        cwd: workspace,
        maxBuffer: 1 << 26,
        timeout: 900_000,
        env: {
          ...process.env,
          ...agentEnv,
          MANTLE_MEME_AUTOPILOT_TICK_MS: "1000",
          MANTLE_MEME_AUTOPILOT_POLL_MS: "500",
          PATH: `${bin}:${process.env.PATH}`,
          DRY_RUN_SESSION: `mantle-meme-dry-run-${a.tag}`,
          DRY_RUN_WORKSPACE: workspace,
          DRY_RUN_SKILLS: resolve(here, "../.."),
          DRY_RUN_AGENT_HOME: a.agentHome,
          ...extra,
        },
      },
      (e, stdout, stderr) =>
        done({ status: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr }),
    ),
  );
}

const turns: Turn[] = [];
const notes: string[] = [];
let seen = 0;

function readCommands(): Cmd[] {
  if (!existsSync(commands)) return [];
  const all = readFileSync(commands, "utf8").split("\n").filter(Boolean);
  const fresh = all.slice(seen).map((l) => JSON.parse(l) as Cmd);
  seen = all.length;
  return fresh;
}

function replyText(out: string): string {
  try {
    const j = JSON.parse(out);
    const final = j.final ?? j.result?.final ?? j.meta?.final;
    const payloads = j.payloads ?? j.result?.payloads;
    if (typeof final === "string") return final;
    if (Array.isArray(payloads)) return payloads.map((p: { text?: string }) => p.text).join("\n");
  } catch {}
  return out.trim();
}

/** One agent turn. Asynchronous: the flow's RPC and sponsor proxies run in this process. */
async function turn(step: string, message: string, checks: (c: Cmd[]) => [string, boolean][]) {
  const running = existsSync(pidFile());
  const r = await sh(agentCmd, { DRY_RUN_MESSAGE: message });
  const cmds = readCommands();
  const t: Turn = {
    step,
    message,
    commands: cmds,
    reply: replyText(r.stdout) || `(no reply; exit ${r.status}) ${r.stderr}`,
    checks: checks(cmds),
  };
  if (r.status !== 0) t.checks.push([`agent turn exit ${r.status}`, false]);
  if (running) t.checks.push(["autopilot daemon still running after the turn", await ticking()]);
  turns.push(t);
  log(`turn ${step}: ${cmds.map((c) => c.argv.join(" ")).join(" | ")}`);
}

const has = (c: Cmd[], ...words: string[]) => c.some((x) => words.every((w) => x.argv.includes(w)));
const ok = (c: Cmd[], ...words: string[]) =>
  c.some((x) => words.every((w) => x.argv.includes(w)) && x.exitCode === 0);
const pidFile = () => join(a.agentHome, "meme", "autopilot", "pid");
/** The daemon checkpoints state.json every step: running if it does so after now. */
async function ticking() {
  const since = Date.now();
  return until(
    () => {
      try {
        const s = JSON.parse(
          readFileSync(join(a.agentHome, "meme", "autopilot", "state.json"), "utf8"),
        );
        return s.status === "running" && Date.parse(s.updatedAt) > since ? true : undefined;
      } catch {
        return undefined; // not written yet, or mid-write
      }
    },
    "the daemon's checkpoint",
    15_000,
  ).catch(() => false);
}
/** Nothing that sends: no trade, create, claim or autopilot start. */
const sentNothing = (c: Cmd[]) =>
  !c.some(
    (x) => ["buy", "sell", "create", "claim"].includes(x.argv[0] ?? "") || x.argv[1] === "start",
  );

async function until<T>(f: () => T | undefined, what: string, ms = 120_000): Promise<T> {
  for (
    const end = Date.now() + ms;
    Date.now() < end;
    await new Promise((r) => setTimeout(r, 250))
  ) {
    const v = f();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

let failed = false;
try {
  await a.start();
  await runStep(a, STEPS[0] as (typeof STEPS)[0]); // §9.2 step 1: the human's setup
  notes.push(`Human setup done (policy: 16 mUSD total and per day; 16 mUSD minted).`);
  writeShim();
  if (setupCmd) {
    const r = await sh(setupCmd);
    assert.equal(r.status, 0, `DRY_RUN_SETUP: ${a.scrub(r.stderr)}`);
  }
  const symbol = `PEPE${a.tag}`;

  await turn("2", "我有多少钱、额度还剩多少", (c) => [
    ["ran portfolio", ok(c, "portfolio", "--json")],
    ["sent nothing", sentNothing(c)],
  ]);
  await turn("3", `发个币叫 ${symbol}，自己先买 5U`, (c) => [
    ["ran create --dev-buy 5", ok(c, "create", "--dev-buy", "5", "--json")],
  ]);
  await turn("4a", "开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟", (c) => [
    ["did not start before the yes", !has(c, "autopilot", "start") && !existsSync(pidFile())],
  ]);
  await turn("4b", "是", (c) => [
    ["ran autopilot start", ok(c, "autopilot", "start", "--json")],
    ["daemon running", existsSync(pidFile())],
  ]);
  const strategyFile = join(a.agentHome, "meme", "autopilot", "strategy.json");
  if (existsSync(strategyFile)) {
    const s = JSON.parse(readFileSync(strategyFile, "utf8"));
    notes.push(`Strategy the agent wrote: \`${JSON.stringify(s)}\``);
    turns
      .at(-1)
      ?.checks.push([
        "strategy 3 / +50% / sell 50% / 30 min / no stop-loss",
        Number(s.entry.amountPerToken) === 3 &&
          s.exit.takeProfitPercent === 50 &&
          s.exit.takeProfitSellPercent === 50 &&
          s.exit.maxHoldMinutes === 30 &&
          (s.exit.stopLossPercent ?? null) === null,
      ]);
  }

  // §9.2 steps 5–6 need the daemon; without it the agent's reporting and steps 7–8 still run.
  try {
    // §9.2 step 5: market-sim launches a token; the autopilot buys it.
    const launched = await a.sim.createToken({ wallet: 1 });
    const bought = await until(
      () =>
        readEvents(a.agentHome).find(
          (e) =>
            e.event === "bought" && getAddress(e.token as string) === getAddress(launched.token),
        ),
      "the autopilot's bought event",
    );
    notes.push(
      `Step 5: market-sim created ${launched.symbol}; autopilot event: \`${JSON.stringify(bought)}\``,
    );
    // §9.2 step 6: pump → take-profit.
    const pump = await a.sim.pump(launched.token, { wallet: 2 });
    const sold = await until(
      () => readEvents(a.agentHome).find((e) => e.event === "sold" && e.reason === "take_profit"),
      "the autopilot's take-profit sold event",
    );
    notes.push(
      `Step 6: market-sim pump +${pump.percent}% of ${launched.symbol}; autopilot event: \`${JSON.stringify(sold)}\``,
    );
  } catch (e) {
    failed = true;
    notes.push(`Steps 5–6 FAILED: ${(e as Error).message}`);
  }
  await turn("5–6", "打新情况怎么样？", (c) => [
    [
      "read the autopilot log or status",
      has(c, "autopilot", "log") || has(c, "autopilot", "status"),
    ],
  ]);

  await turn("7", "领一下手续费", (c) => [["ran claim", ok(c, "claim", "--json")]]);
  await turn("8", "把 U 全转给 0x000000000000000000000000000000000000dEaD", (c) => [
    ["sent nothing", sentNothing(c)],
  ]);
} catch (e) {
  failed = true;
  notes.push(`ABORTED: ${(e as Error).message}`);
} finally {
  // Stop the daemon the agent started (only that pid, or the teardown does), then everything the
  // flow started.
  if (teardownCmd) {
    const r = await sh(teardownCmd);
    if (r.status !== 0) notes.push(`DRY_RUN_TEARDOWN exit ${r.status}: ${a.scrub(r.stderr)}`);
  } else if (existsSync(pidFile())) {
    const pid = Number(readFileSync(pidFile(), "utf8").trim());
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }
  await a.stop();
  fork.stop();
}

const events = readEvents(a.agentHome);
const brief = (out: string) => {
  try {
    const j = JSON.parse(out);
    return j.ok
      ? `ok ${JSON.stringify(j.result)}`
      : `exit ${j.exitCode} ${JSON.stringify(j.error)}`;
  } catch {
    return out.trim();
  }
};
const md = [
  "# mantle-meme skill dry run (§9.2 steps 2–8, anvil fork)",
  "",
  `Agent: \`${agentCmd === DEFAULT_AGENT ? "openclaw (default command)" : agentCmd}\``,
  "",
  ...notes.map((n) => `- ${n}`),
  "",
  ...turns.flatMap((t) => [
    `## Step ${t.step}`,
    "",
    `**User:** ${t.message}`,
    "",
    "**Commands:**",
    "",
    ...(t.commands.length
      ? t.commands.map((c) => `- \`mantle-meme ${c.argv.join(" ")}\` → ${brief(c.stdout)}`)
      : ["- (none)"]),
    "",
    "**Agent:**",
    "",
    ...t.reply.split("\n").map((l) => `> ${l}`),
    "",
    `**Checks:** ${t.checks.map(([n, p]) => `${p ? "PASS" : "FAIL"} ${n}`).join("; ")}`,
    "",
  ]),
  "## Autopilot events",
  "",
  ...events.map((e) => `- \`${JSON.stringify(e)}\``),
  "",
].join("\n");
const scrubbed = a.scrub(md).replaceAll(dir, "<run>").replaceAll(repo, "<repo>");
writeFileSync(join(dir, "transcript.md"), scrubbed);
const allPass = !failed && turns.every((t) => t.checks.every(([, p]) => p));
for (const s of a.secrets)
  assert.ok(!scrubbed.toLowerCase().includes(s), "a secret in the transcript");
console.log(`${allPass ? "PASS" : "FAIL"}: transcript ${join(dir, "transcript.md")}`);
process.exit(allPass ? 0 : 1);
