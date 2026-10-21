#!/usr/bin/env node
// A mock Telegram Bot API, for rehearsing the demo without a real bot (DEMO_MOCK_TELEGRAM=1 or
// DEMO_FORK=1 in scripts/demo-up.sh). OpenClaw's Telegram channel (long polling) and the autopilot's
// pushes both talk to it; you write to the bot as the owner with `say`.
//
//   node scripts/mock-telegram.mjs serve <port> <chat id>   the Bot API (demo-up starts it)
//   node scripts/mock-telegram.mjs say "<message>"          a DM from the owner; prints the replies
//   node scripts/mock-telegram.mjs sent                     everything the bot sent (pushes too)
//
// `say` and `sent` reach the mock at DEMO_MOCK_TELEGRAM_URL (default http://127.0.0.1:8081).
import { createServer } from "node:http";

const [cmd, ...args] = process.argv.slice(2);
const base = process.env.DEMO_MOCK_TELEGRAM_URL ?? "http://127.0.0.1:8081";
const call = async (path, body) => {
  const res = await fetch(`${base}${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  return (await res.json()).result;
};
/** The bot's messages, oldest first: the latest text of each (replies stream as edits). */
const texts = (sent) => [...new Map(sent.map((m) => [m.message_id, m])).values()];

if (cmd === "serve") serve(Number(args[0]), Number(args[1]));
else if (cmd === "say" && args[0]) {
  const before = new Set((await call("/sent")).messages.map((m) => m.message_id));
  await call("/inject", { text: args[0] });
  // The turn is over once the bot has replied and then stopped typing for 20 s (at most 10 min).
  const start = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2_000));
    const { messages, idleMs } = await call("/sent");
    const sent = messages.filter((m) => !before.has(m.message_id));
    if ((sent.length && idleMs > 20_000) || Date.now() - start > 600_000) {
      for (const m of texts(sent)) console.log(`bot> ${m.text}\n`);
      if (!sent.length) console.log("(no reply within 10 min)");
      break;
    }
  }
} else if (cmd === "sent") {
  for (const m of texts((await call("/sent")).messages)) console.log(`[${m.at}] ${m.text}\n`);
} else {
  console.error("usage: mock-telegram.mjs serve <port> <chat id> | say <message> | sent");
  process.exit(1);
}

function serve(port, chat) {
  const owner = { id: chat, is_bot: false, first_name: "Owner" };
  const bot = { id: 1, is_bot: true, first_name: "Demo", username: "mock_demo_bot" };
  const updates = [];
  const sent = [];
  const waiting = [];
  // Ids above those of an earlier run of the mock: OpenClaw drops an update or message id it has seen.
  let updateId = Math.floor(Date.now() / 1000);
  let messageId = updateId;
  let active = Date.now(); // the bot's last send or chat action ("typing…")
  const now = () => Math.floor(Date.now() / 1000);
  createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    let p = {};
    try {
      p = body ? JSON.parse(body) : {};
    } catch {
      p = Object.fromEntries(new URLSearchParams(body));
    }
    const url = new URL(req.url, "http://mock");
    for (const [k, v] of url.searchParams) p[k] = v;
    const reply = (result) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
    };
    const chatOf = (id) => ({ id: Number(id), type: "private", first_name: "Owner" });
    if (url.pathname === "/sent") return reply({ messages: sent, idleMs: Date.now() - active });
    if (url.pathname === "/inject") {
      const message = {
        message_id: messageId++,
        from: owner,
        chat: chatOf(chat),
        date: now(),
        text: String(p.text),
      };
      updates.push({ update_id: updateId++, message });
      for (const w of waiting.splice(0)) w();
      return reply(message);
    }
    const method = url.pathname.split("/").pop();
    if (/^(send|edit)/.test(method)) active = Date.now();
    switch (method) {
      case "getMe":
        return reply(bot);
      case "getUpdates": {
        // Like Telegram: an offset confirms (and drops) the updates before it.
        const offset = Number(p.offset ?? 0);
        while (updates.length && updates[0].update_id < offset) updates.shift();
        if (!updates.length && Number(p.timeout) > 0) {
          await new Promise((r) => {
            waiting.push(r);
            setTimeout(r, Math.min(Number(p.timeout), 25) * 1000);
          });
        }
        return reply(updates);
      }
      case "sendMessage":
      case "editMessageText": {
        const id = p.message_id ? Number(p.message_id) : messageId++;
        const at = new Date().toISOString();
        sent.push({ message_id: id, chat_id: String(p.chat_id), text: String(p.text), at });
        return reply({
          message_id: id,
          chat: chatOf(p.chat_id),
          date: now(),
          text: p.text,
          from: bot,
        });
      }
      case "deleteMessage": {
        const i = sent.findIndex((m) => m.message_id === Number(p.message_id));
        if (i >= 0) sent.splice(i, 1);
        return reply(true);
      }
      case "getWebhookInfo":
        return reply({ url: "", has_custom_certificate: false, pending_update_count: 0 });
      case "getMyCommands":
        return reply([]);
      default:
        return reply(true);
    }
  }).listen(port, "127.0.0.1", () => console.log(`mock Telegram Bot API on 127.0.0.1:${port}`));
}
