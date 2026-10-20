import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `mantle-meme` from its TypeScript sources (no build needed). */
export const MEME_BIN = fileURLToPath(new URL("../src/bin/mantle-meme.ts", import.meta.url));
const TS_HOOKS = fileURLToPath(new URL("./fixtures/node-ts.mjs", import.meta.url));
/** The published `mantle-aa` binary (a dependency of the CLI). */
export const AA_BIN = join(
  dirname(createRequire(import.meta.url).resolve("@0xwh1sker/mantle-aa-cli")),
  "bin.js",
);

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as one JSON object, when it is one. */
  // biome-ignore lint/suspicious/noExplicitAny: the shape is what the test asserts
  json: any;
}

/**
 * Runs `node <args>` with `env` on top of this process's environment minus every `MANTLE_AA_*`
 * variable (so nothing of the developer's own setup leaks in); `input` is written to stdin.
 */
export function runNode(
  args: string[],
  env: Record<string, string>,
  input?: string,
  timeoutMs = 120_000,
): Promise<Ran> {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("MANTLE_AA_")),
  );
  const proc = spawn(process.execPath, args, { env: { ...base, ...env } });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => {
    stdout += d;
  });
  proc.stderr.on("data", (d) => {
    stderr += d;
  });
  proc.stdin.end(input ?? "");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`node ${args.at(-1)} timed out after ${timeoutMs} ms: ${stderr}`));
    }, timeoutMs);
    proc.once("error", reject);
    proc.once("close", (code) => {
      clearTimeout(timer);
      let json: unknown;
      try {
        json = JSON.parse(stdout);
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
  });
}

/** The node arguments that run `mantle-meme` from source. */
export const memeArgs = (args: string[]) => [
  "--experimental-transform-types",
  "--no-warnings",
  "--import",
  TS_HOOKS,
  MEME_BIN,
  ...args,
];

export const mantleMeme = (args: string[], env: Record<string, string>, input?: string) =>
  runNode(memeArgs(args), env, input);

export const mantleAa = (args: string[], env: Record<string, string>, input?: string) =>
  runNode([AA_BIN, ...args], env, input);
