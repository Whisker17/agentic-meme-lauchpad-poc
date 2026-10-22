// 8 · 撤销后 agent 和 autopilot 怎样停下 (sections 2, 5)
import { arrow, C, line, rect, tag, text } from "./lib.mjs";

export const alt =
  "撤销流程，六列：你（root 终端）、sponsor、链、容器里的 autopilot daemon、容器里的 agent、你（Telegram）。" +
  "你在 root 终端运行 mantle-aa session revoke，root key 签一个管理批次，经 sponsor 的管理预算上链：Calibur 删除这把 key，" +
  "AgentPolicyHook 把它标成墓碑，MockUSD 对 Launchpad 的授权清零。daemon 在下一个 tick（默认 10 秒）读到 key 已不在，" +
  "记 session_ended，推送“Session ended … Re-grant from the root terminal.”和“Autopilot stopped (session_ended).”，然后退出。" +
  "之后你在 Telegram 说“再买 2U ZORK”，agent 运行 buy，AA SDK 在本地模拟时就发现 key 未注册，退出码 13，什么都没发送，" +
  "agent 请你在本地终端重新授权。墓碑不可撤销：要继续，只能在 root 终端授予一把新 key 并重新导出到空的 agent home。";

const COL = { root: 0, sp: 216, chain: 432, daemon: 648, agent: 864, tg: 1080 };
const W = 184;
const at = (k, y, h, t, o = {}) =>
  rect(COL[k], y, o.w || W, h, {
    label: t,
    size: o.size || 16,
    stroke: o.stroke || C.line,
    color: o.color || C.text,
    sw: o.sw,
  });
const mid = (k) => COL[k] + W / 2;

export const skeleton = [
  at("root", 0, 56, "你 · root 终端", { stroke: C.text, sw: 3, size: 18 }),
  at("sp", 0, 56, "sponsor", { size: 18 }),
  at("chain", 0, 56, "链", { size: 18, stroke: C.struct }),
  at("daemon", 0, 56, "容器 · daemon", { size: 18 }),
  at("agent", 0, 56, "容器 · agent", { size: 18 }),
  at("tg", 0, 56, "你 · Telegram", { stroke: C.text, sw: 3, size: 18 }),
  ...Object.keys(COL).map((k) =>
    line(
      [
        [mid(k), 60],
        [mid(k), 760],
      ],
      { dashed: true, stroke: C.line },
    ),
  ),

  at("root", 88, 118, "mantle-aa session\nrevoke --agent trader\n\nroot key 签管理批次", {
    stroke: C.text,
  }),
  arrow(
    [
      [188, 147],
      [212, 147],
    ],
    { stroke: C.text },
  ),
  at("sp", 88, 118, "走单独的管理预算\n（业务请求用不掉它）\nrelayer 付 gas"),
  arrow([
    [404, 147],
    [428, 147],
  ]),
  at(
    "chain",
    88,
    160,
    "一个批次：\nCalibur revoke(key)\nhook.revoke(key)\n→ 墓碑\nMockUSD approve\n(Launchpad, 0)",
    {
      stroke: C.accent,
      sw: 3,
    },
  ),

  arrow(
    [
      [620, 230],
      [mid("daemon"), 230],
      [mid("daemon"), 270],
    ],
    { dashed: true, stroke: C.muted },
  ),
  tag(650, 200, "下一个 tick 读链上状态", C.muted, 15),
  at(
    "daemon",
    276,
    150,
    "tick（默认 10 s）：\nkey 还注册着吗？过期？\nrevoked？\n→ session_ended\n→ stopped，删 pid，退出",
    { stroke: C.struct },
  ),
  arrow(
    [
      [836, 330],
      [1076, 330],
    ],
    { dashed: true, stroke: C.muted },
  ),
  arrow(
    [
      [836, 400],
      [1076, 400],
    ],
    { dashed: true, stroke: C.muted },
  ),
  at("tg", 290, 80, "推送：Session ended …\nRe-grant from the root\nterminal."),
  at("tg", 380, 50, "推送：Autopilot\nstopped (session_ended)."),

  at("tg", 476, 56, "“再买 2U ZORK”", { stroke: C.text }),
  arrow(
    [
      [1076, 504],
      [1052, 504],
    ],
    { stroke: C.text },
  ),
  at(
    "agent",
    476,
    170,
    "buy ZORK --amount 2\n--json\n\nAA SDK 本地模拟：\nSession key is not\nregistered on the account\n→ exit 13，什么都没发",
  ),
  arrow(
    [
      [1052, 600],
      [1076, 600],
    ],
    { dashed: true, stroke: C.muted },
  ),
  at("tg", 560, 86, "“会话密钥已撤销或过期，\n请在你的本地终端\n重新授权。”"),

  rect(0, 682, 1264, 96, { stroke: C.line }),
  text(
    18,
    696,
    "墓碑不能撤销：同一把 key 永远回不来。要继续，在 root 终端 session grant（得到一把新 key），\n再 session export 到一个空的 agent home，然后重启容器。agent 自己做不了任何一步。",
    { size: 17, color: C.text, lh: 1.5 },
  ),
];
