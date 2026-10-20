import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Starts anvil forking Mantle Sepolia with the Prague hardfork (EIP-7702) on a port the OS picks,
 * and resolves once it listens. anvil exits when the upstream RPC fails while it builds the fork
 * (e.g. a rate limit), so an exited start is retried twice. Output is never echoed with its URLs.
 */
export async function startFork(
  rpcUrl: string,
  timeoutMs = 30_000,
): Promise<{ url: string; stop: () => void }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startAnvil(rpcUrl, timeoutMs);
    } catch (e) {
      if (attempt === 3 || !(e as Error).message.startsWith("anvil exited")) throw e;
      await sleep(1_000 * attempt);
    }
  }
}

function startAnvil(rpcUrl: string, timeoutMs: number): Promise<{ url: string; stop: () => void }> {
  const anvil = spawn("anvil", ["--fork-url", rpcUrl, "--port", "0", "--hardfork", "prague"]);
  let output = "";
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer);
      anvil.kill();
      const tail = output
        .replace(/\w+:\/\/[^\s)]+/g, "<url>")
        .slice(-1_000)
        .trim();
      reject(new Error(`anvil ${why}: ${tail || "(no output)"}`));
    };
    const timer = setTimeout(() => fail(`did not listen within ${timeoutMs} ms`), timeoutMs);
    anvil.once("error", (e) => fail(e.message));
    anvil.once("close", (code, signal) => fail(`exited with ${code ?? signal}`));
    const keep = (data: Buffer) => {
      output += data;
      const port = /Listening on [\d.]+:(\d+)/.exec(output)?.[1];
      if (!port) return;
      clearTimeout(timer);
      anvil.removeAllListeners("close");
      // From here on drain both pipes without keeping anything, so anvil never blocks on one.
      anvil.stdout.off("data", keep).resume();
      anvil.stderr.off("data", keep).resume();
      resolve({ url: `http://127.0.0.1:${port}`, stop: () => anvil.kill() });
    };
    anvil.stdout.on("data", keep);
    anvil.stderr.on("data", keep);
  });
}
