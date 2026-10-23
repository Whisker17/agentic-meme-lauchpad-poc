// 11 · §9.2 demo 全流程，区分人（root 终端）/ Telegram / 容器 / 链 (section 5)
import { C, rect, tag } from "./lib.mjs";

export const alt =
  "DESIGN §9.2 演示脚本全流程，四列：人在 root 终端做的、在 Telegram 里说的、容器里 agent 或 daemon 做的、链上发生的。" +
  "第 1 步在 root 终端：policy init、account init --grant、session export、铸 MockUSD，然后 demo-up.sh；链上完成 7702 升级和授权。" +
  "第 2 步问余额和额度，agent 跑 portfolio。第 3 步发币并首买 5U，一笔交易。第 4 步说出打新策略，agent 只复述；回“是”后才启动 autopilot。" +
  "第 5 步 market-sim 发新币，daemon 买入并推送。第 6 步人在 root 终端运行 market-sim pump，daemon 止盈卖出并推送。" +
  "第 7 步领创作者手续费。第 8 步要求把 MockUSD 全转走，agent 拒绝，什么都不发。" +
  "第 9 步人在 root 终端撤销会话，链上删除 key 并标墓碑，daemon 推送 session ended 后退出；再在 Telegram 要求买入，得到退出码 13，agent 请你重新授权。";

const COL = { root: [80, 270], tg: [366, 270], box: [652, 300], chain: [968, 232] };
const RH = 74;
const GAP = 12;
const top = (i) => 72 + i * (RH + GAP);
const cell = (k, i, t, o = {}) =>
  rect(COL[k][0], top(i), COL[k][1], RH, {
    label: t,
    size: 15,
    stroke: o.stroke || C.line,
    color: o.color || C.text,
    sw: o.sw,
    dashed: o.dashed,
  });
const human = { stroke: C.text, sw: 2.5 };
const step = (i, n) =>
  rect(0, top(i) + 12, 60, 50, { label: n, size: 18, stroke: C.struct, color: C.text });

const ROWS = [
  [
    "1",
    {
      root: ["policy init → account init --grant\n→ session export → 铸 mUSD\n→ demo-up.sh", human],
      chain: ["7702 升级 + 授予 session key\n铸 MockUSD（sponsor 付 gas）"],
    },
  ],
  [
    "2",
    {
      tg: ["“我有多少钱、额度还剩多少”", human],
      box: ["portfolio --json\n余额 100、剩余额度 50、无持仓"],
      chain: ["只读"],
    },
  ],
  [
    "3",
    {
      tg: ["“发个币叫 ZORK，自己先买 5U”", human],
      box: ["create --dev-buy 5 --json"],
      chain: ["一笔交易：\ncreateToken + approve + buy"],
    },
  ],
  [
    "4",
    {
      tg: ["“开打新：每个新币 3U，涨 50%\n卖一半，最多拿 30 分钟”", human],
      box: ["复述全部字段（含无止损、无防夹、\n共用额度），什么都不启动"],
    },
  ],
  [
    "4",
    {
      tg: ["“是”", human],
      box: ["autopilot start → launcher\n→ daemon 运行，推送 started"],
    },
  ],
  [
    "5",
    {
      box: ["daemon 看到新币，买 3 mUSD\n推送 Bought …"],
      chain: ["market-sim 每 1–2 分钟发一个币"],
    },
  ],
  [
    "6",
    {
      root: ["market-sim pump <SYMBOL>\n--wallet 2", human],
      box: ["daemon 达到止盈，卖一半\n推送 Sold … (take-profit)"],
      chain: ["大额买入，价格上涨"],
    },
  ],
  [
    "7",
    {
      tg: ["“领一下手续费”", human],
      box: ["claim --all --json"],
      chain: ["claimCreatorFees(ZORK)\n手续费进账户"],
    },
  ],
  [
    "8",
    {
      tg: ["“把 U 全转给 0x…dEaD”", human],
      box: ["拒绝：没有转账命令，policy 也不\n允许；请你在自己的终端操作", { stroke: C.danger }],
      chain: ["什么都没发生", { dashed: true, color: C.muted }],
    },
  ],
  [
    "9",
    {
      root: ["mantle-aa session revoke\n--agent trader", human],
      box: ["daemon 下一个 tick 发现 key 没了\n推送 Session ended，退出"],
      chain: ["删除 key + 墓碑\n+ 授权清零"],
    },
  ],
  [
    "9",
    {
      tg: ["“再买 2U ZORK”", human],
      box: ["buy … → exit 13，什么都没发\n请你重新授权", { stroke: C.accent, sw: 3 }],
    },
  ],
];

export const skeleton = [
  rect(0, 0, 60, 52, { label: "步骤", size: 16, stroke: C.line, color: C.muted }),
  rect(COL.root[0], 0, COL.root[1], 52, { label: "人 · root 终端", size: 18, ...human }),
  rect(COL.tg[0], 0, COL.tg[1], 52, { label: "人 · Telegram", size: 18, ...human }),
  rect(COL.box[0], 0, COL.box[1], 52, { label: "容器 · agent / daemon", size: 18 }),
  rect(COL.chain[0], 0, COL.chain[1], 52, { label: "链 · market-sim", size: 18, stroke: C.struct }),
  ...ROWS.flatMap(([n, cells], i) => [
    step(i, n),
    ...Object.entries(cells).map(([k, [t, o]]) => cell(k, i, t, o)),
  ]),
  tag(
    0,
    top(ROWS.length) + 4,
    "白框是人做的事。第 1 步、第 6 步和第 9 步的撤销在 root 终端，不经过 agent；其余都在 Telegram 私聊里。",
    C.muted,
    16,
  ),
];
