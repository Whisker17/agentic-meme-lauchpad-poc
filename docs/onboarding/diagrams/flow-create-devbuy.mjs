// 5 · 发币 + 首买如何在一个批次里完成 (sections 3, 5)
import { arrow, box, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "发币加首买在一个批次里完成。左：CLI 先在链下准备，随机生成 salt，用 CREATE2 公式离线算出代币地址" +
  "（salt 先和账户地址一起哈希），代币还不存在，所以按发射时的曲线在本地算首买报价和 minOut。" +
  "中：一个批次三个调用：createToken、approve(MockUSD 给 Launchpad 5 mUSD)、buy(预测地址, 5 mUSD, minOut, deadline, 账户)。" +
  "右：hook 对每个调用分别检查。createToken 规则是 NONE，只查白名单，Launchpad 部署代币并把 10 亿枚全部铸给自己；" +
  "approve 检查 spender 受信、数额不超过剩余额度；buy 的 beforeExecute 读预测地址的余额，这时代币已经由上一个调用部署好了，" +
  "afterExecute 把 MockUSD 净流出计入额度，把收到的代币记进 inventory。任何一步失败整批回滚；salt 绑定调用者，地址抢不走。";

const call = (y, n, sig, rule) => [
  rect(380, y, 400, 104, { stroke: C.struct }),
  text(398, y + 14, `${n}  ${sig}`, { size: 18, color: C.text, lh: 1.35 }),
  tag(398, y + 72, `ruleKind ${rule}`, C.struct, 16),
];
const why = (y, t) => text(830, y, t, { size: 17, color: C.muted, lh: 1.45 });

export const skeleton = [
  tag(0, 0, "CLI 先在链下算好", C.muted, 19),
  rect(0, 34, 340, 344, { stroke: C.muted }),
  text(
    18,
    50,
    "1  随机 salt（32 字节）\n\n2  predictTokenAddress(\n      账户, salt, name, symbol)\n    离线算出 CREATE2 地址；\n    salt' = keccak256(账户, salt)\n\n3  代币还不存在：按发射时的\n    曲线在本地算首买报价\n    → minOut = 报价 − 5%",
    { size: 18, color: C.text, lh: 1.45 },
  ),
  arrow([
    [346, 206],
    [374, 206],
  ]),

  tag(380, 0, "一个批次、一次 sponsor 请求、一笔交易", C.muted, 19),
  ...call(34, "①", 'createToken("ZORK", "ZORK",\n     "", "", salt)', "NONE"),
  ...call(150, "②", "approve(Launchpad, 5 mUSD)\n     目标：MockUSD", "ERC20_APPROVE"),
  ...call(266, "③", "buy(预测地址, 5 mUSD, minOut,\n     deadline, 账户)", "LAUNCHPAD_BUY"),

  tag(830, 0, "hook 对每个调用单独检查", C.muted, 19),
  why(
    40,
    "只查白名单。Launchpad 用 CREATE2 部署\nMemeToken，10 亿枚全部铸给自己，曲线\n开始交易。不收钱，也不给调用者代币。",
  ),
  why(158, "spender 必须是受信的 Launchpad，\n5 mUSD 不能超过剩余额度。"),
  why(
    268,
    "调用前：读 balanceOf(预测地址)。\n①已经把代币部署好，所以读得到。\n调用后：MockUSD 净流出 5 计入额度，\n收到的代币记进这把 key 的 inventory。",
  ),
  ...[86, 202, 318].map((y) =>
    arrow(
      [
        [786, y],
        [820, y],
      ],
      { stroke: C.line },
    ),
  ),

  ...box(
    0,
    410,
    1200,
    96,
    "为什么能放进一个批次",
    "Calibur 在每个调用前后分别调 hook，不是整批只调一次；③ 的检查发生在 ① 部署代币之后。\n任何一步失败，整批回滚。salt 和调用者绑在一起，别人用同一个 salt 部署不到这个地址。",
    { ts: 20, ss: 17, stroke: C.accent, sw: 3 },
  ),
];
