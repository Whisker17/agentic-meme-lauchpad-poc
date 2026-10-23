// 7 · autopilot：启动 → 买入 → 止盈，以及崩溃后怎样恢复 (sections 3, 5)
import { arrow, C, line, rect, tag, text } from "./lib.mjs";

export const alt =
  "autopilot 泳道图，五列：你（Telegram）、你（root 终端）、OpenClaw agent、容器里的 launcher 和 autopilot daemon、链。" +
  "启动：你在 Telegram 说出策略，agent 写 strategy.json 并逐项复述，什么都不启动；你回“是”，agent 才运行 autopilot start，" +
  "wrapper 把它转给容器的 launcher，launcher 运行真正的 CLI，CLI 启动一个分离的 daemon；daemon 独占 pid 文件、读链上会话状态、" +
  "写 state.json、记 started 事件并回报，然后直接通过 Bot API 推送 Autopilot started，不经过 LLM。" +
  "买入：market-sim 发新币，daemon 的 watcher 每 2 秒拉日志，按发现时的链上年龄、关键词、是否自己发的、价格倍数、持仓数过滤，" +
  "检查剩余额度和余额，先把 pending 交易连同 id 存盘，再带着这个 id 发送；确认后开仓并推送 Bought。" +
  "止盈：你在 root 终端运行 market-sim pump，持仓代币的 Trade 事件触发评估，卖一半的净卖出值达到成本的 1.5 倍就用 quoteSell 复核后卖出，推送 Sold。" +
  "崩溃恢复：重启时用 state.json 里 pending 的 id 去 journal 找带同一 correlationId 的记录，有就补记，没有就当没发生；手动交易不带 id，不会被误认。";

const COL = {
  tg: [0, 200],
  root: [220, 190],
  agent: [432, 262],
  daemon: [716, 352],
  chain: [1090, 200],
};
const at = (k, y, h, t, o = {}) =>
  rect(COL[k][0], y, COL[k][1], h, {
    label: t,
    size: o.size || 16,
    stroke: o.stroke || C.line,
    color: o.color || C.text,
    sw: o.sw,
    dashed: o.dashed,
  });
const right = (k) => COL[k][0] + COL[k][1];
const push = (y, t) => [
  arrow(
    [
      [COL.daemon[0] - 4, y],
      [right("tg") + 6, y],
    ],
    { dashed: true, stroke: C.muted },
  ),
  text(right("tg") + 16, y - 26, t, { size: 16, color: C.muted }),
];
const phase = (y, t) => [
  line(
    [
      [0, y],
      [1290, y],
    ],
    { stroke: C.line, dashed: true },
  ),
  tag(0, y + 6, t, C.struct, 17),
];

export const skeleton = [
  // headers: the two human columns stand out
  at("tg", 0, 56, "你 · Telegram", { stroke: C.text, sw: 3, size: 18 }),
  at("root", 0, 56, "你 · root 终端", { stroke: C.text, sw: 3, size: 18 }),
  at("agent", 0, 56, "OpenClaw agent（LLM）", { size: 18 }),
  at("daemon", 0, 56, "容器：launcher + autopilot daemon", { size: 18 }),
  at("chain", 0, 56, "链 + market-sim", { size: 18, stroke: C.struct }),

  ...phase(70, "启动"),
  at("tg", 100, 96, "“开打新：每个新币 3U，\n涨 50% 卖一半，\n最多拿 30 分钟”"),
  arrow(
    [
      [204, 148],
      [428, 148],
    ],
    { stroke: C.text },
  ),
  at(
    "agent",
    100,
    110,
    "写 strategy.json，逐项复述\n（含默认值；无止损、无防夹、\n和手动交易共用额度）\n先不启动",
  ),
  at("tg", 228, 50, "“是”"),
  arrow(
    [
      [204, 253],
      [428, 253],
    ],
    { stroke: C.text },
  ),
  at("agent", 228, 92, "autopilot start\n--strategy strategy.json\nwrapper → launcher 的 socket"),
  arrow([
    [698, 274],
    [712, 274],
  ]),
  at(
    "daemon",
    228,
    150,
    "launcher 跑真 CLI，CLI 启动分离的 daemon\ndaemon：独占 pid 文件（在 send.lock 下）\n→ 读链上会话状态 → 写 state.json\n→ started 事件 → 经 IPC 回报\nagent 的命令返回，daemon 留下",
    { stroke: C.struct },
  ),
  ...push(400, "Bot API 直接推送：Autopilot started …（不经过 LLM）"),

  ...phase(430, "买入"),
  at("chain", 462, 84, "market-sim 发新币\n→ TokenCreated"),
  arrow([
    [1086, 504],
    [1072, 504],
  ]),
  at(
    "daemon",
    462,
    132,
    "watcher 每 2 s 拉一次日志\n过滤：发现时 ≤ 60 s（链上时间）\n· 关键词 · 不是自己发的\n· 价格 ≤ 2× 发射价 · 持仓 < 10\n预算：剩余额度和余额都 ≥ 3 mUSD",
  ),
  at(
    "daemon",
    608,
    92,
    "先把 pending = {id} 存盘\nexecute(…, correlationId = id)\n确认后开仓，再存盘",
    {
      stroke: C.struct,
    },
  ),
  arrow([
    [1072, 654],
    [1086, 654],
  ]),
  at("chain", 608, 92, "approve + buy\n同一条 sponsor 路径"),
  ...push(736, "推送 Bought ZORK: 3 mUSD → … tokens."),

  ...phase(766, "止盈"),
  at("root", 798, 84, "market-sim pump\n<SYMBOL> --wallet 2", { stroke: C.text }),
  arrow(
    [
      [414, 840],
      [1086, 840],
    ],
    { stroke: C.text },
  ),
  text(430, 806, "人的操作，不经过 agent", { size: 16, color: C.muted }),
  at("chain", 798, 84, "大额买入，价格上涨\n→ Trade 事件"),
  at(
    "daemon",
    896,
    110,
    "持仓代币的 Trade 事件触发评估\n卖 50% 的净卖出值 ≥ 成本 × 1.5？\n→ quoteSell 复核 → 卖出（只止盈一次）",
  ),
  arrow([
    [1088, 882],
    [1072, 920],
  ]),
  ...push(1030, "推送 Sold ZORK (take-profit): … PnL … mUSD."),

  rect(0, 1066, 1290, 112, { stroke: C.accent, sw: 3 }),
  text(
    18,
    1080,
    "崩溃恢复：daemon 在“交易已上链、还没存盘”时被杀怎么办？\n重启时读 state.json 的 pending.id，去 journal 找 correlationId = id 的记录：有就补记（开仓 / 标记已止盈 / 平仓），\n没有就当这笔没发生。手动交易不带 id，永远不会被当成 autopilot 的交易。",
    { size: 17, color: C.text, lh: 1.5 },
  ),
];
