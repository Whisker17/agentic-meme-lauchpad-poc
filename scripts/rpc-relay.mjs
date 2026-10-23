#!/usr/bin/env node
// A local JSON-RPC relay in front of a rate-limited public RPC (scripts/demo-up.sh starts it for
// Mantle Sepolia). It forwards every request unchanged, at most MAX at a time, and retries one the
// upstream refused for its rate limit (HTTP 429 or a "rate limit" error), so bursts such as
// `portfolio`'s parallel reads arrive spread out instead of failing. It logs no URL and no body.
//
//   RPC_RELAY_UPSTREAM=<RPC URL> node scripts/rpc-relay.mjs <port>
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const upstream = process.env.RPC_RELAY_UPSTREAM;
const MAX = 4;
let active = 0;
const queue = [];
// At most MAX upstream calls in flight; a finished one hands its slot to the next in line.
const slot = () => {
  if (active < MAX) {
    active++;
    return Promise.resolve();
  }
  return new Promise((r) => queue.push(r));
};
const release = () => (queue.length ? queue.shift()() : active--);
const limited = (status, text) => status === 429 || /rate limit/i.test(text);

async function forward(body) {
  for (let attempt = 1; ; attempt++) {
    await slot();
    let status;
    let text;
    try {
      const res = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      [status, text] = [res.status, await res.text()];
    } catch (e) {
      [status, text] = [502, JSON.stringify({ error: `relay: ${e.cause?.code ?? e.name}` })];
    } finally {
      release();
    }
    if (!limited(status, text) || attempt === 8) return { status, text };
    await new Promise((r) => setTimeout(r, 250 * attempt));
  }
}

createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const { status, text } = await forward(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}).listen(port, "127.0.0.1", () => console.log(`JSON-RPC relay on 127.0.0.1:${port}`));
