// The daemon's pid file (DESIGN §6.3, §7.3): of two starts racing over a stale pid file exactly one
// acquires, the other is exit 44; a sequential second start is 44; a stale file alone is reclaimed.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it, describe as suite } from "vitest";
import { acquirePid, autopilotFiles } from "../src/autopilot.js";
import { describe } from "../src/errors.js";

const STALE = 111;
const [A, B] = [222, 333];

const home = () => mkdtempSync(join(tmpdir(), "meme-pid-"));
const live = new Set([A, B]);
const isLive = (pid: number) => live.has(pid);
const exitOf = (r: PromiseSettledResult<void>) =>
  r.status === "rejected" ? describe(r.reason).exitCode : 0;

suite("autopilot pid file", () => {
  it("two starts racing over a stale pid file: exactly one acquires, the other is 44", async () => {
    const h = home();
    const f = autopilotFiles(h);
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(f.pid, String(STALE)); // a pid file whose owner has died
    let b: Promise<void> | undefined;
    // A has just judged the stale owner dead; B runs its whole acquisition right then.
    const aAlive = async (pid: number) => {
      if (pid === STALE && !b) {
        b = acquirePid(h, B, isLive);
        await Promise.race([b.catch(() => {}), sleep(500)]);
      }
      return isLive(pid);
    };
    const a = await Promise.allSettled([acquirePid(h, A, aAlive)]);
    const results = [...a, ...(await Promise.allSettled([b as Promise<void>]))];

    expect(results.map(exitOf).sort()).toEqual([0, 44]);
    const winner = results[0]?.status === "fulfilled" ? A : B;
    expect(readFileSync(f.pid, "utf8")).toBe(String(winner));
  });

  it("a sequential second start is 44; a stale pid file alone is reclaimed", async () => {
    const h = home();
    const f = autopilotFiles(h);
    await acquirePid(h, A, isLive);
    const again = await Promise.allSettled([acquirePid(h, B, isLive)]);
    expect(again.map(exitOf)).toEqual([44]);
    expect(readFileSync(f.pid, "utf8")).toBe(String(A));

    writeFileSync(f.pid, "999999999"); // a dead holder, checked for real
    await acquirePid(h, process.pid);
    expect(readFileSync(f.pid, "utf8")).toBe(String(process.pid));
  });
});
