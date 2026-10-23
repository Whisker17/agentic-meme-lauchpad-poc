// 3 · 一次调用里 AgentPolicyHook 检查了什么、在哪拒绝 (sections 2, 6)
import { arrow, box, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "一笔 agent 批次要过三道关。前两道是链下的：AA SDK 在本地按 hook 的规则预检并 eth_call 模拟，不通过就不发送（退出码 10、11、12、13）；" +
  "sponsor 自己鉴权、查 allowlist、再模拟一遍，但它不是安全边界。第三道在链上，是交易权限唯一的强制点：Calibur 对批次里的每一个调用，" +
  "先调 AgentPolicyHook.beforeExecute（会话是否有效、目标不是 hook、目标和函数选择器在白名单里、按规则检查 approve 的 spender 和额度、" +
  "买卖的 recipient 必须是账户本身、deadline 在 600 秒窗口内、卖出不超过这把 key 的 inventory），再执行调用，" +
  "最后调 afterExecute（调用失败就回滚、MockUSD 净流出计入总额和每日额度、买入的 token 记进 inventory、卖出必须足额）。任何一步失败，整笔交易回滚。";

const gate = (x, title, sub, o = {}) => box(x, 30, 370, 140, title, sub, { ts: 21, ss: 17, ...o });
const L = (x, y, t, o = {}) => text(x, y, t, { size: 17, color: C.muted, lh: 1.5, ...o });

export const skeleton = [
  tag(0, 0, "三道关：前两道只让坏请求早点失败，第三道才是交易权限的边界", C.muted, 19),
  ...gate(
    0,
    "① AA SDK · simulate（本地）",
    "按 hook 的规则逐条预检，再 eth_call\n跑一遍；不通过就什么都不发。\n这里给出退出码 10 / 11 / 12 / 13",
  ),
  arrow([
    [376, 100],
    [410, 100],
  ]),
  ...gate(
    415,
    "② sponsor（链下）",
    "鉴权、allowlist、预算，再自己模拟一遍\n（不信 SDK 的模拟）。\n不是安全边界：agent 可以绕过它",
    { stroke: C.muted, dashed: true },
  ),
  arrow([
    [791, 100],
    [825, 100],
  ]),
  ...gate(
    830,
    "③ 链上 · Calibur + AgentPolicyHook",
    "交易权限唯一的强制点。\n就算 agent 绕过 SDK 和 sponsor\n直接调账户，规则一样生效",
    { stroke: C.accent, sw: 3 },
  ),

  arrow([
    [1015, 176],
    [1015, 214],
    [600, 214],
    [600, 236],
  ]),
  tag(0, 236, "Calibur 对批次里的每一个调用都走一遍：", C.text, 19),

  rect(0, 270, 520, 420, { stroke: C.struct }),
  text(18, 284, "beforeExecute（调用前）", { size: 21, color: C.text }),
  L(
    18,
    322,
    "1  账户级重入锁\n2  Summary.active，否则 SessionInactive\n3  目标不是 hook 本身，否则 TargetIsHook\n4  (to, selector) 在 permissions 白名单里\n     否则 CallNotPermitted",
  ),
  tag(448, 436, "→ exit 10", C.danger, 17),
  L(
    18,
    478,
    "5  value ≤ maxValuePerCall（这里是 0）\n6  按 ruleKind 查参数\n     APPROVE：spender 受信，amount ≤ 剩余额度\n     BUY / SELL：recipient == 账户，\n       now ≤ deadline ≤ now + 600 s，token ≠ MockUSD\n     SELL：amount ≤ 这把 key 的 inventory\n7  记下余额快照（MockUSD；买卖时还有 token）",
  ),
  tag(448, 529, "→ exit 11", C.danger, 17),
  tag(448, 605, "→ exit 12", C.danger, 17),

  arrow([
    [526, 420],
    [560, 420],
  ]),
  ...box(
    566,
    352,
    220,
    136,
    "执行调用",
    "MockUSD.approve\nLaunchpad.buy / sell\n/ createToken / claim",
    {
      ts: 21,
      ss: 17,
      stroke: C.muted,
    },
  ),
  arrow([
    [792, 420],
    [826, 420],
  ]),

  rect(832, 270, 368, 420, { stroke: C.struct }),
  text(850, 284, "afterExecute（调用后）", { size: 21, color: C.text }),
  L(
    850,
    322,
    "1  调用失败 → 回滚\n    （等于强制 revertOnFailure）\n2  MockUSD 余额的净减少\n    计入总额和当日额度，\n    超了就回滚\n3  BUY：token 余额的增加量\n    记进这把 key 的 inventory\n4  SELL：余额必须正好减少 amount，\n    否则 PartialFill\n5  释放重入锁",
  ),
  tag(1100, 373, "→ exit 11", C.danger, 17),
  L(566, 560, "任何一步 revert，\n整笔交易回滚：\n不会出现“额度扣了、\n钱没动”的状态。", {
    color: C.text,
    size: 18,
  }),
];
