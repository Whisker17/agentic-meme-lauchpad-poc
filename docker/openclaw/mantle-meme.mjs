#!/usr/bin/env node
// The `mantle-meme` on the agent's PATH: the real CLI, except `autopilot start`, which the
// container's launcher (launcher.mjs) runs. OpenClaw's exec tool kills every descendant of a command
// when it returns, so a daemon started here would die; one started by the launcher does not.
import { connect } from "node:net";
import { createInterface } from "node:readline";

const SOCKET = "/tmp/mantle-meme-launcher.sock"; // container-local, never a mounted volume
const argv = process.argv.slice(2);

if (argv[0] !== "autopilot" || argv[1] !== "start") {
  await import("../../packages/cli/dist/bin/mantle-meme.js");
} else {
  // Frames from the launcher, one JSON line each: ["o"|"e", base64 stdout|stderr] … ["x", exit code].
  let exit;
  try {
    const sock = connect(SOCKET);
    sock.write(`${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
    for await (const line of createInterface({ input: sock })) {
      const [kind, value] = JSON.parse(line);
      if (kind === "x") exit = value;
      else (kind === "o" ? process.stdout : process.stderr).write(Buffer.from(value, "base64"));
    }
  } catch (e) {
    process.stderr.write(`error: the autopilot launcher is not reachable: ${e.message}\n`);
  }
  process.exitCode = exit ?? 1;
}
