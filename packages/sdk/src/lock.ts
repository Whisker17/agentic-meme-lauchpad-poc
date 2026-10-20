import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/** `<home>/meme`: the meme state of an agent home (send lock, journal). */
export const memeDir = (home: string) => join(home, "meme");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Creates `file` exclusively (`O_EXCL`); false when it exists. */
function create(file: string, content: string): boolean {
  try {
    writeFileSync(file, content, { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

/**
 * Removes the lock if the process that holds it is gone, or if it names no pid and is older than
 * 10 s (its creator died between the exclusive create and the pid write; a live one is that old
 * only for microseconds). Breaking it is serialised by a short-lived `.break` file, under which the
 * holder is read again, so a waiter never removes a lock another waiter has just taken.
 */
function breakIfStale(lock: string): void {
  const guard = `${lock}.break`;
  if (!create(guard, String(process.pid))) {
    // Held for microseconds; one older than 10 s belongs to a crashed process.
    try {
      if (Date.now() - statSync(guard).mtimeMs > 10_000) rmSync(guard, { force: true });
    } catch {}
    return;
  }
  try {
    const owner = readFileSync(lock, "utf8").trim();
    const stale = /^[1-9]\d*$/.test(owner)
      ? !alive(Number(owner))
      : Date.now() - statSync(lock).mtimeMs > 10_000;
    if (stale) rmSync(lock, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  } finally {
    rmSync(guard, { force: true });
  }
}

export interface SendLockOptions {
  /** How long to wait for the lock; default 300 s (a send holds it until its receipt). */
  timeoutMs?: number;
  /** Pause between attempts; default 100 ms. */
  retryMs?: number;
}

/**
 * Runs `fn` while holding the cross-process lock `<home>/meme/send.lock` (an `O_EXCL` file holding
 * the owner's pid), so one process at a time sends for the account. A lock left by a process that
 * no longer runs is broken.
 */
export async function withSendLock<T>(
  home: string,
  fn: () => Promise<T>,
  { timeoutMs = 300_000, retryMs = 100 }: SendLockOptions = {},
): Promise<T> {
  mkdirSync(memeDir(home), { recursive: true, mode: 0o700 });
  const lock = join(memeDir(home), "send.lock");
  const until = Date.now() + timeoutMs;
  while (!create(lock, String(process.pid))) {
    breakIfStale(lock);
    if (Date.now() > until) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${lock}`);
    await sleep(retryMs);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
