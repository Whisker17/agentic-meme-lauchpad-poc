// 1 · 三层是什么、谁持有哪把钥匙 (sections 0, 1)
import { arrow, box, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "系统总览。左边是一次请求自上而下经过的组件，分三层：Agent 层（Telegram 私聊、容器里的 OpenClaw gateway、LLM 加 mantle-meme skill），" +
  "Launchpad 层（mantle-meme CLI、meme-sdk，以及旁边的 autopilot daemon），7702 账户层（AA SDK 的 AgentSession、sponsor 的 relayer、" +
  "Mantle Sepolia 上的账户、AgentPolicyHook、MemeLaunchpad 和 MockUSD）。右边是三把钥匙：root key 在你自己的 root 终端，" +
  "管理账户；session key 在容器里的 agent home，只能在 AgentPolicyHook 允许的范围内签名；relayer 热钱包在 sponsor 进程里，只付 gas，不是账户密钥。";

const X = 24;
const W = 400;
const H = 58;
const step = (y, title, sub, o = {}) =>
  box(X, y, W, H + (sub ? 22 : 0), title, sub, { ts: 21, ss: 17, ...o });
const down = (y1, y2) =>
  arrow([
    [X + W / 2, y1 + 4],
    [X + W / 2, y2 - 4],
  ]);
const band = (y, h, label) => [
  rect(0, y, 660, h, { stroke: C.line, bg: "transparent", dashed: true }),
  tag(456, y + 10, label, C.struct),
];

const keyCard = (y, title, lines, o = {}) =>
  box(740, y, 470, 150, title, lines, { ts: 22, ss: 17, gap: 10, sw: 2.5, ...o });

export const skeleton = [
  // the request path
  ...step(0, "Telegram 私聊（你）", "你打字，agent 回复；autopilot 也往这里推送"),
  down(80, 140),
  ...band(104, 248, "AGENT 层 · Docker 容器里"),
  ...step(140, "OpenClaw gateway", "Telegram 通道；只接受你的 chat id"),
  down(220, 250),
  ...step(250, "LLM + mantle-meme skill", "SKILL.md：规则 + 命令表 + 退出码话术"),
  down(330, 402),
  ...band(366, 248, "LAUNCHPAD 层"),
  ...step(402, "mantle-meme CLI", "skill 只让 agent 用它；--json 输出，退出码"),
  down(482, 512),
  ...step(512, "meme-sdk", "报价 · 批次 · 发送锁 · journal"),
  rect(456, 440, 180, 116, {
    label: "autopilot daemon\n确定性程序\n不是 LLM",
    size: 17,
    stroke: C.muted,
    dashed: true,
    color: C.muted,
  }),
  arrow([
    [452, 540],
    [430, 552],
  ]),
  down(592, 664),
  ...band(628, 362, "7702 账户层"),
  ...step(664, "AA SDK · AgentSession", "本地按 hook 规则模拟，再用 session key 签名"),
  down(744, 774),
  ...step(774, "sponsor（relayer）", "鉴权、再模拟一遍、预留费用、付 gas 上链"),
  down(854, 884),
  ...box(
    X,
    884,
    612,
    86,
    "Mantle Sepolia",
    "账户（Calibur）+ AgentPolicyHook · MemeLaunchpad · MockUSD",
    {
      ts: 21,
      ss: 17,
      stroke: C.accent,
      sw: 3,
    },
  ),

  // who holds which key
  tag(740, 0, "谁持有哪把钥匙", C.muted, 22),
  ...keyCard(
    40,
    "root key · 人",
    "在你的 root 终端（root home），从不进容器。\n它就是账户本身：升级账户、授予 / 撤销\n会话、panic、把钱转走，都只能它来。",
  ),
  ...keyCard(
    250,
    "session key · agent",
    "在导出的 agent home（容器里，单独的密码）。\n它签的每一笔都要过 AgentPolicyHook：只能\n买、卖、发币、领手续费；24 小时后过期。",
    { stroke: C.struct },
  ),
  ...keyCard(
    460,
    "relayer 热钱包 · sponsor",
    "在你 Mac 上的 sponsor 进程里。\n只付 MNT gas、把签好的批次送上链。\n它不是账户的钥匙，动不了账户里的钱。",
    { stroke: C.muted, dashed: true },
  ),
  arrow(
    [
      [736, 330],
      [690, 330],
      [690, 704],
      [430, 704],
    ],
    { dashed: true },
  ),
  tag(560, 678, "签名", C.struct),
  arrow(
    [
      [736, 540],
      [712, 540],
      [712, 814],
      [430, 814],
    ],
    { dashed: true, stroke: C.muted },
  ),
  tag(560, 788, "付 gas", C.muted),
  arrow(
    [
      [1214, 115],
      [1240, 115],
      [1240, 927],
      [640, 927],
    ],
    { dashed: true, stroke: C.text },
  ),
  tag(
    760,
    872,
    "root key 管理账户：init · grant · revoke · panic\n（同样经 sponsor 上链，走单独的管理预算）",
    C.muted,
    16,
  ),
  text(
    760,
    660,
    "三把钥匙互不替代：\n拿到 relayer 的钥匙，动不了账户；\n拿到 session key，越不过 hook。",
    {
      size: 19,
      color: C.text,
    },
  ),
];
