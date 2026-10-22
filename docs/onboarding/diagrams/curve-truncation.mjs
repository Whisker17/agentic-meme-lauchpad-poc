// 6 · bonding curve 和最后一笔买入截断 (section 3)
import { box, C, dot, line, rect, tag, text } from "./lib.mjs";

export const alt =
  "bonding curve 示意。横轴是已卖出的代币（0 到 8 亿枚），纵轴是相对发射价的价格倍数（1 到 16 倍）。" +
  "恒定乘积 vQ·vT = k，虚拟储备起点是 1,066,666,667 枚和 200 mUSD，价格是 vQ 除以 vT。" +
  "起点每枚约 1.875×10⁻⁷ mUSD；卖完 8 亿枚时价格是 16 倍，vQ 为 800 mUSD，买满一共约 606 mUSD（含 1% 手续费）。" +
  "另外 2 亿枚是为将来毕业预留的，本版没有代码能动它。右侧：最后一笔买入会被截断，只收买完剩余代币所需的 amountInUsed，" +
  "在 fork 上实测买下剩余 2,015,113.1 枚正好收了 6.060607 mUSD。SDK 平时先把 approve 和 amountIn 夹到这个值，链上截断只兜底竞态。" +
  "之后状态变为 Completed，买卖都会 revert（exit 40），仓位搁浅。";

const V0 = 1066.666667; // virtual token reserve at launch, millions
const X0 = 90;
const PX = 0.75; // px per million tokens sold
const Y0 = 560;
const PY = 30; // px per ×1 of the launch price
const px = (sold) => X0 + sold * PX;
const py = (mult) => Y0 - (mult - 1) * PY;
const mult = (sold) => (V0 / (V0 - sold)) ** 2;
const curve = Array.from({ length: 33 }, (_, i) => i * 25).map((s) => [px(s), py(mult(s))]);

export const skeleton = [
  // axes
  line(
    [
      [X0, 90],
      [X0, Y0],
      [px(1000) + 10, Y0],
    ],
    { stroke: C.muted, sw: 2 },
  ),
  ...[0, 200, 400, 600, 800].map((s) => tag(px(s) - 12, Y0 + 10, String(s), C.tag, 17)),
  tag(px(1000) - 140, Y0 + 36, "已卖出（百万枚）", C.muted, 17),
  ...[1, 4, 9, 16].map((m) => tag(X0 - 52, py(m) - 10, `×${m}`, C.tag, 17)),
  tag(0, 60, "价格（相对发射价）", C.muted, 17),

  // the curve and the reserve
  line(curve, { stroke: C.struct, sw: 3.5 }),
  dot(px(0), py(1), 7),
  dot(px(800), py(16), 8, C.text),
  rect(px(800) + 6, 100, px(1000) - px(800) - 6, Y0 - 102, {
    stroke: C.line,
    bg: "transparent",
    dashed: true,
  }),
  text(px(800) + 20, 300, "预留 2 亿枚\n给将来的“毕业”\n本版没有任何\n代码能动它", {
    size: 17,
    color: C.tag,
    lh: 1.4,
  }),

  // annotations
  ...box(
    130,
    180,
    390,
    132,
    "恒定乘积 + 虚拟储备",
    "vQ · vT = k（取整永远偏向曲线）\n起点 vT = 1,066,666,667 枚，vQ = 200 mUSD\n价格 = vQ / vT",
    {
      ts: 20,
      ss: 17,
      stroke: C.line,
    },
  ),
  text(px(0) + 16, py(1) - 74, "起点：每枚 ≈ 1.875 × 10⁻⁷ mUSD\n10 亿枚的估值 ≈ 187.5 mUSD", {
    size: 17,
    color: C.muted,
  }),
  text(
    px(800) - 330,
    py(16) - 6,
    "终点：价格 ×16，vQ = 800 mUSD\n买满大约 606 mUSD（含 1% 手续费）",
    {
      size: 17,
      color: C.text,
    },
  ),

  // the truncated final buy
  tag(910, 60, "最后一笔买入：截断，而不是 revert", C.text, 20),
  rect(910, 96, 420, 290, { stroke: C.struct }),
  text(
    928,
    112,
    "曲线只剩 r 枚，你的 amountIn 买得比 r 还多：\n合约只收买完 r 枚所需的 amountInUsed，\n给你全部 r 枚，状态 → Completed。\n\nnetNeeded = ⌈k / (vT − r)⌉ − vQ\namountInUsed = ⌈netNeeded × 10000 / 9900⌉\n\nfork 实测：剩余 2,015,113.1 枚，\n正好收 6.060607 mUSD（手续费 0.060607）",
    { size: 17, color: C.muted, lh: 1.45 },
  ),
  text(
    910,
    404,
    "SDK 平时先把 approve 和 buy 的 amountIn\n都夹到 amountInUsed：hook 会拒绝超过\n剩余额度的 approve。链上截断只兜底\n“报价之后、上链之前有人插队”的情况。",
    { size: 17, color: C.muted, lh: 1.45 },
  ),
  ...box(
    910,
    512,
    420,
    88,
    "Completed 之后",
    "买和卖都 revert（exit 40）。手里的仓位卖不掉：\n是“搁浅”，不是“毕业”。",
    {
      ts: 19,
      ss: 17,
      stroke: C.accent,
      sw: 3,
    },
  ),
];
