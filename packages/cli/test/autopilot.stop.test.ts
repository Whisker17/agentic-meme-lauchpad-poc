// A forced `autopilot stop` (DESIGN §6.3, §7.3): it cleans up after the killed daemon only, never
// the pid file and state of a replacement that started between the kill and the cleanup.
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, describe as suite } from "vitest";
import {
  acquirePid,
  autopilotFiles,
  autopilotStatus,
  readEvents,
  stopAutopilot,
} from "../src/autopilot.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let daemon: ChildProcess | undefined;
afterEach(() => {
  if (daemon?.pid && alive(daemon.pid)) daemon.kill("SIGKILL");
});

/** A home whose pid file and state name a live daemon that ignores SIGTERM (so stop must kill). */
async function stubborn() {
  daemon = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e3); console.log('ready')"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await once(daemon.stdout as NodeJS.ReadableStream, "data");
  const pid = daemon.pid as number;
  const home = mkdtempSync(join(tmpdir(), "meme-stop-"));
  const f = autopilotFiles(home);
  mkdirSync(f.dir, { recursive: true });
  writeFileSync(f.pid, String(pid));
  writeFileSync(f.state, JSON.stringify({ status: "running", pid }));
  return { home, f, pid };
}

const state = (file: string) => JSON.parse(readFileSync(file, "utf8"));

suite("autopilot forced stop", () => {
  it("a single daemon that ignores SIGTERM is killed and its pid file and state cleaned up", async () => {
    const { home, f, pid } = await stubborn();
    expect(await stopAutopilot(home, 200)).toEqual({ pid, stopped: true, forced: true });
    expect(alive(pid)).toBe(false);
    expect(autopilotStatus(home)).toMatchObject({ running: false, pid: null });
    expect(state(f.state)).toMatchObject({ pid, status: "stopped" });
    expect(readEvents(home).at(-1)).toMatchObject({ event: "stopped", reason: "killed" });
  });

  it("a replacement started between the kill and the cleanup keeps its pid file and state", async () => {
    const { home, f, pid } = await stubborn();
    const replacement = process.pid; // a live pid standing in for the new daemon
    let replaced = false;
    // The killed daemon is gone; before the stop cleans up, a start takes the stale pid file
    // and the new daemon writes its state.
    const isAlive = async (p: number) => {
      const up = alive(p);
      if (!up && !replaced) {
        replaced = true;
        await acquirePid(home, replacement);
        writeFileSync(f.state, JSON.stringify({ status: "running", pid: replacement }));
      }
      return up;
    };
    expect(await stopAutopilot(home, 200, isAlive)).toEqual({ pid, stopped: true, forced: true });
    expect(replaced).toBe(true);
    expect(readFileSync(f.pid, "utf8")).toBe(String(replacement));
    expect(state(f.state)).toEqual({ status: "running", pid: replacement });
    expect(autopilotStatus(home)).toMatchObject({ running: true, pid: replacement });
    expect(readEvents(home)).toEqual([]);
  });
});
