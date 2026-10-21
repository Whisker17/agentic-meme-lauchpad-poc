// The container's main process (under tini, outside OpenClaw's process tree). It runs the
// `autopilot start` calls the agent's `mantle-meme` (mantle-meme.mjs) forwards, so the daemon they
// spawn is its descendant and outlives the agent's command. Output and exit code are relayed as is.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:net";
import { constants } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const SOCKET = "/tmp/mantle-meme-launcher.sock"; // container-local, never a mounted volume
const CLI = fileURLToPath(new URL("../../packages/cli/dist/bin/mantle-meme.js", import.meta.url));
const USAGE = "usage: mantle-meme autopilot start --strategy <file> [--agent <name>] [--json]";

/** The only call accepted: `autopilot start --strategy <file> [--agent <name>] [--json]`. */
function command({ argv, cwd }) {
  if (argv[0] !== "autopilot" || argv[1] !== "start") throw new Error("not autopilot start");
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("no working directory");
  const { values } = parseArgs({
    args: argv.slice(2),
    options: { strategy: { type: "string" }, agent: { type: "string" }, json: { type: "boolean" } },
    strict: true,
  });
  if (values.strategy === undefined) throw new Error("--strategy is required");
  return [
    ...["autopilot", "start", "--strategy", resolve(cwd, values.strategy)],
    ...(values.agent === undefined ? [] : ["--agent", values.agent]),
    ...(values.json ? ["--json"] : []),
  ];
}

rmSync(SOCKET, { force: true }); // left over by a restarted container
createServer((sock) => {
  sock.on("error", () => {}); // a caller that goes away must not stop the launcher
  const send = (kind, value) => sock.write(`${JSON.stringify([kind, value])}\n`);
  const out = (kind, text) => send(kind, Buffer.from(text).toString("base64"));
  const done = (code) => {
    if (sock.writableEnded) return; // a failed spawn emits both error and close
    send("x", code);
    sock.end();
  };
  createInterface({ input: sock }).once("line", (line) => {
    let req;
    let args;
    try {
      req = JSON.parse(line);
      args = command(req);
    } catch (e) {
      const message = `${USAGE} (${e.message})`;
      if (Array.isArray(req?.argv) && req.argv.includes("--json")) {
        const error = { code: "USAGE", type: "UsageError", message };
        out(
          "o",
          `${JSON.stringify({ ok: false, command: "autopilot start", exitCode: 1, error })}\n`,
        );
      } else out("e", `error: ${message}\n`);
      return done(1);
    }
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: req.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => send("o", d.toString("base64")));
    child.stderr.on("data", (d) => send("e", d.toString("base64")));
    child.on("error", (e) => {
      out("e", `error: ${e.message}\n`);
      done(1);
    });
    child.on("close", (code, signal) => done(code ?? 128 + constants.signals[signal]));
  });
}).listen(SOCKET);
