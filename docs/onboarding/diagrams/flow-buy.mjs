// 4 · 一次命令买入从 Telegram 到链上的完整时序（含 gasless relayer 路径） (sections 2, 5)
import { arrow, C, line, rect, tag, text } from "./lib.mjs";

export const alt =
  "命令买入的时序图，六条生命线：你（Telegram）、OpenClaw（LLM 加 skill）、mantle-meme CLI 和 meme-sdk、AA SDK、sponsor、链。" +
  "你发“买 2U 的 DOGE9”；agent 先跑 quote，链上 quoteBuy 给出报价；再跑 buy。CLI 解析符号、确认曲线还在交易、重新报价、" +
  "算出 minOut（报价减 5%）和 deadline（最新区块时间加 300 秒），组成 approve 加 buy 的批次，拿发送锁，交给 AA SDK。" +
  "AA SDK 在本地按 hook 规则模拟，用 session key 签名（executor 是 relayer，2 分钟有效），发给 sponsor。" +
  "sponsor 鉴权、检查 allowlist 和同一账户只能有一个在途请求、自己再模拟、预留费用，然后由 relayer 发交易并付 MNT gas。" +
  "链上 Calibur 验签，每个调用前后调 AgentPolicyHook，Launchpad.buy 发出 Trade 事件。CLI 拿到回执，把 Trade 日志写进 journal，释放锁，" +
  "把带交易链接的 JSON 交给 agent，agent 回复你。root key 全程不参与，你和 agent 都不需要 MNT。";

const X = { you: 70, oc: 270, cli: 490, aa: 710, sp: 920, ch: 1120 };
const head = (k, title, sub, o = {}) =>
  rect(X[k] - 95, 0, 190, 70, {
    label: `${title}\n${sub}`,
    size: 18,
    stroke: o.stroke || C.muted,
    sw: o.sw,
    color: o.color || C.text,
  });
const life = (k, o = {}) =>
  line(
    [
      [X[k], 74],
      [X[k], 1140],
    ],
    { dashed: true, stroke: o.stroke || C.line },
  );
const msg = (a, b, y, label, o = {}) => {
  const [x1, x2] = [X[a], X[b]];
  const dir = x2 > x1 ? 1 : -1;
  return [
    arrow(
      [
        [x1 + dir * 6, y],
        [x2 - dir * 6, y],
      ],
      { dashed: o.reply, stroke: o.stroke || (o.reply ? C.muted : C.struct), sw: o.sw },
    ),
    text(Math.min(x1, x2) + 14, y - 26, label, { size: 16, color: o.color || C.text }),
  ];
};
const note = (k, y, h, t, o = {}) =>
  rect(X[k] - (o.w || 190) / 2 + (o.dx || 0), y, o.w || 190, h, {
    label: t,
    size: 16,
    stroke: o.stroke || C.line,
    bg: C.fill,
    color: o.color || C.muted,
  });

export const skeleton = [
  ...["you", "oc", "cli", "aa", "sp", "ch"].map((k) =>
    life(k, k === "you" ? { stroke: C.muted } : {}),
  ),
  head("you", "你", "Telegram 私聊", { stroke: C.text, sw: 3 }),
  head("oc", "OpenClaw", "LLM + skill"),
  head("cli", "mantle-meme", "CLI + meme-sdk"),
  head("aa", "AA SDK", "AgentSession"),
  head("sp", "sponsor", "relayer 热钱包"),
  head("ch", "Mantle Sepolia", "链上合约", { stroke: C.struct }),

  ...msg("you", "oc", 118, "“买 2U 的 DOGE9”", { stroke: C.text }),
  ...msg("oc", "cli", 164, "quote DOGE9 --buy 2 --json"),
  ...msg("cli", "ch", 210, "quoteBuy(token, 2 mUSD)：只读调用，不花 gas"),
  ...msg("oc", "cli", 256, "buy DOGE9 --amount 2 --json"),
  note(
    "cli",
    272,
    124,
    "解析符号；曲线已完成 → exit 40\n重新报价；会买空曲线就夹到 amountInUsed\nminOut = 报价 − 5%\ndeadline = 最新区块时间 + 300 s\n批次 [approve, buy]，拿 send.lock",
    { w: 340 },
  ),
  ...msg("cli", "aa", 436, "AgentSession.exec(calls)"),
  note(
    "aa",
    452,
    104,
    "simulate：按 hook 规则逐条预检\n+ eth_call；不过就不发（exit 10–13）\nsession key 签 SignedBatchedCall\n（executor = relayer，2 分钟有效）",
    { w: 320 },
  ),
  ...msg("aa", "sp", 592, "sponsor_relay（批次 + 请求签名）"),
  note(
    "sp",
    608,
    104,
    "鉴权 · allowlist · 每日预算\n同一账户只许一个在途请求\n（否则 SPONSOR_BUSY，SDK 退避重试）\n自己再模拟，预留最坏情况的费用",
    { w: 340, dx: -20 },
  ),
  ...msg("sp", "ch", 748, "relayer 发交易", { stroke: C.accent, sw: 3 }),
  tag(X.sp + 14, 758, "execute(批次, 签名)\ngas 由 relayer 付（MNT）", C.accent, 16),
  note(
    "ch",
    808,
    92,
    "Calibur 验 session key 签名\n每个调用前后调 AgentPolicyHook\nLaunchpad.buy → Trade 事件",
    { w: 250, dx: -30, stroke: C.struct },
  ),
  ...msg("ch", "aa", 940, "交易哈希（经 sponsor 转回）", { reply: true }),
  ...msg("aa", "cli", 980, "hash", { reply: true }),
  note("cli", 994, 56, "等回执（status 必须是 success）\n写 journal，释放 send.lock", { w: 300 }),
  ...msg("cli", "oc", 1090, "{ok, result: {hash, explorer, spent, tokens…}}", { reply: true }),
  ...msg("oc", "you", 1134, "报价 + “已买入，交易链接 …”", { reply: true, stroke: C.text }),
  text(
    0,
    1164,
    "你只发了一句话，root key 全程不参与。账户和 agent 都可以是 0 MNT：gas 由 sponsor 的 relayer 付。",
    { size: 18, color: C.text },
  ),
];
