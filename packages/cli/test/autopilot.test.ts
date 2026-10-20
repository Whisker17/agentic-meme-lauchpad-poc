// `mantle-meme autopilot` without a chain: strategy validation, exit 44, status and log from the
// files, a daemon that fails to start reporting through `start`, and the Telegram push against a
// local mock of the Bot API.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { autopilotFiles, messageOf, telegram } from "../src/autopilot.js";
import { mantleMeme } from "./helpers.js";

const STRATEGY = {
  entry: {
    amountPerToken: "3",
    maxAgeSeconds: 60,
    keywords: [],
    excludeOwn: true,
    maxOpenPositions: 10,
    maxEntryPriceMultiple: 2,
  },
  exit: {
    takeProfitPercent: 50,
    takeProfitSellPercent: 50,
    maxHoldMinutes: 30,
    stopLossPercent: null,
  },
  slippagePercent: 3,
};

function setup(strategy: unknown = STRATEGY) {
  const dir = mkdtempSync(join(tmpdir(), "meme-autopilot-"));
  const home = join(dir, "agent");
  const file = join(dir, "strategy.json");
  writeFileSync(file, JSON.stringify(strategy));
  return { dir, home, file, env: { MANTLE_AA_HOME: home } };
}

describe("autopilot (no chain)", { timeout: 60_000 }, () => {
  it("start refuses an invalid strategy (usage, exit 1); stop-loss is reserved", async () => {
    const bad = setup({ ...STRATEGY, exit: { ...STRATEGY.exit, stopLossPercent: 10 } });
    const r = await mantleMeme(["autopilot", "start", "--strategy", bad.file, "--json"], bad.env);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({
      ok: false,
      command: "autopilot start",
      exitCode: 1,
      error: { code: "USAGE", message: expect.stringContaining("stopLossPercent is reserved") },
    });
    const missing = await mantleMeme(["autopilot", "start", "--json"], bad.env);
    expect(missing.json.error.message).toMatch(/--strategy is required/);
    const nofile = await mantleMeme(
      ["autopilot", "start", "--strategy", join(bad.dir, "none.json"), "--json"],
      bad.env,
    );
    expect(nofile.json.error.message).toMatch(/cannot read the strategy/);
    expect(existsSync(autopilotFiles(bad.home).pid)).toBe(false);
  });

  it("stop with no daemon is exit 44; status says not running", async () => {
    const s = setup();
    const stop = await mantleMeme(["autopilot", "stop", "--json"], s.env);
    expect(stop.code).toBe(44);
    expect(stop.json).toMatchObject({
      exitCode: 44,
      error: { code: "AUTOPILOT_STATE", message: "Autopilot is not running" },
    });
    const status = await mantleMeme(["autopilot", "status", "--json"], s.env);
    expect(status.json).toEqual({
      ok: true,
      command: "autopilot status",
      result: { running: false, pid: null, strategy: null, state: null },
    });
  });

  it("start with a live pid file is exit 44; a stale one is not running", async () => {
    const s = setup();
    const f = autopilotFiles(s.home);
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.pid, String(process.pid));
    const r = await mantleMeme(["autopilot", "start", "--strategy", s.file, "--json"], s.env);
    expect(r.code).toBe(44);
    expect(r.json.error).toMatchObject({
      code: "AUTOPILOT_STATE",
      message: `Autopilot is already running (pid ${process.pid})`,
    });
    writeFileSync(f.pid, "999999999");
    const status = await mantleMeme(["autopilot", "status", "--json"], s.env);
    expect(status.json.result).toMatchObject({ running: false, pid: null });
  });

  it("a daemon that cannot start reports its error through start, and leaves no pid file", async () => {
    // No RPC URL: the daemon's own usage error comes back over IPC with its exit code.
    const s = setup();
    const r = await mantleMeme(["autopilot", "start", "--strategy", s.file, "--json"], s.env);
    expect(r.code, r.stdout).toBe(1);
    expect(r.json).toMatchObject({
      ok: false,
      command: "autopilot start",
      error: { code: "USAGE", message: expect.stringMatching(/MANTLE_AA_RPC_URL/) },
    });
    expect(existsSync(autopilotFiles(s.home).pid)).toBe(false);
  });

  it("log prints events.jsonl, --since filters by time", async () => {
    const s = setup();
    const f = autopilotFiles(s.home);
    mkdirSync(f.dir, { recursive: true });
    const old = { at: new Date(Date.now() - 2 * 3600_000).toISOString(), event: "started" };
    const recent = { at: new Date().toISOString(), event: "bought", symbol: "X" };
    writeFileSync(f.events, `${JSON.stringify(old)}\n${JSON.stringify(recent)}\n{"torn`);
    const all = await mantleMeme(["autopilot", "log", "--json"], s.env);
    expect(all.json.result).toEqual({ events: [old, recent] });
    const since = await mantleMeme(["autopilot", "log", "--since", "1h", "--json"], s.env);
    expect(since.json.result).toEqual({ events: [recent] });
    const text = await mantleMeme(["autopilot", "log", "--since", "1h"], s.env);
    expect(text.stdout).toBe(`${JSON.stringify(recent)}\n`);
    const bad = await mantleMeme(["autopilot", "log", "--since", "soon", "--json"], s.env);
    expect(bad.code).toBe(1);
  });
});

describe("Telegram push (mock Bot API)", () => {
  const TOKEN = "123456:SECRET-bot-token";
  const received: { url: string; body: { chat_id: string; text: string } }[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ url: req.url ?? "", body: JSON.parse(body) });
    res.statusCode = status;
    res.end(JSON.stringify({ ok: status === 200 }));
  });
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const env = (o: Record<string, string> = {}) => ({
    MANTLE_MEME_TG_BOT_TOKEN: TOKEN,
    MANTLE_MEME_TG_CHAT_ID: "42",
    MANTLE_MEME_TG_API_URL: url,
    ...o,
  });

  it("is off unless both bot variables are set", () => {
    expect(telegram({ MANTLE_MEME_TG_BOT_TOKEN: TOKEN }, () => {})).toBeUndefined();
    expect(telegram({ MANTLE_MEME_TG_CHAT_ID: "1" }, () => {})).toBeUndefined();
  });

  it("sends sendMessage to the chat, in order", async () => {
    received.length = 0;
    const errors: string[] = [];
    const tg = telegram(env(), (m) => errors.push(m));
    tg?.send("one");
    tg?.send("two");
    await tg?.flush();
    expect(received).toEqual([
      {
        url: `/bot${TOKEN}/sendMessage`,
        body: expect.objectContaining({ chat_id: "42", text: "one" }),
      },
      {
        url: `/bot${TOKEN}/sendMessage`,
        body: expect.objectContaining({ chat_id: "42", text: "two" }),
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("a failed delivery is reported without the token and does not throw", async () => {
    status = 500;
    const errors: string[] = [];
    const tg = telegram(env(), (m) => errors.push(m));
    tg?.send("x");
    await tg?.flush();
    status = 200;
    // An unreachable API and a malformed base URL (whose fetch error quotes the whole URL).
    for (const base of ["http://127.0.0.1:9", "not a url"]) {
      const t = telegram(env({ MANTLE_MEME_TG_API_URL: base }), (m) => errors.push(m));
      t?.send("y");
      await t?.flush();
    }
    expect(errors).toHaveLength(3);
    expect(errors[0]).toBe("Telegram answered HTTP 500");
    for (const e of errors) expect(e).not.toContain("SECRET");
  });

  it("templates: trades, budget, completion and session end are pushed; filter skips are not", () => {
    const at = new Date().toISOString();
    expect(
      messageOf({
        at,
        event: "bought",
        symbol: "MOON",
        spent: { human: "3" },
        tokens: { human: "100" },
        explorer: "https://x/tx/1",
      }),
    ).toBe("Bought MOON: 3 mUSD → 100 tokens.\nhttps://x/tx/1");
    expect(
      messageOf({
        at,
        event: "sold",
        symbol: "MOON",
        reason: "take_profit",
        sold: { human: "50" },
        received: { human: "2.5" },
        pnl: { human: "1" },
      }),
    ).toMatch(/^Sold MOON \(take-profit\)/);
    expect(messageOf({ at, event: "session_ended" })).toMatch(/Session ended/);
    expect(messageOf({ at, event: "budget_exhausted", remainingLimit: { human: "1" } })).toMatch(
      /Budget exhausted/,
    );
    expect(messageOf({ at, event: "curve_completed", symbol: "M" })).toMatch(/stranded/);
    expect(messageOf({ at, event: "skipped", reason: "keywords" })).toBeUndefined();
    expect(messageOf({ at, event: "skipped", reason: "unknown_cost_basis" })).toMatch(/unknown/);
    expect(messageOf({ at, event: "error", source: "telegram", message: "x" })).toBeUndefined();
  });
});
