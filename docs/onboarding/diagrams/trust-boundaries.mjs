// 10 · 信任边界：链上强制 vs skill 规则 vs 容器隔离 (section 6)
import { arrow, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "信任边界图。左边是进入 agent 的输入：你的 Telegram 消息（只接受你的 chat id）、任何人都能写的链上代币名称和描述、" +
  "list 和 info 等命令输出、模型提供方的回复。中间三层，从软到硬：skill 规则只约束守规矩的模型，prompt injection 可以让它违反任何一条；" +
  "容器是凭据隔离边界，决定 agent 能拿到哪些钥匙（没有 root key、没有 docker socket），但不限制它已经拿到的 session key 能做什么，容器里的 agent 密码、bot token 和模型登录它也都读得到；" +
  "链上强制（Calibur、AgentPolicyHook、MemeLaunchpad）是交易权限的强制边界，即使 agent 被完全控制也成立：五个函数的白名单、MockUSD 总额和每日额度、" +
  "只能卖自己买的、收款人必须是账户、deadline 不超过 600 秒、24 小时过期、撤销是墓碑。右边列出被攻破的 agent 还能做和做不到的事。";

const band = (y, h, title, body, note, o = {}) => [
  rect(290, y, 600, h, { stroke: o.stroke, sw: o.sw, dashed: o.dashed }),
  text(310, y + 14, title, { size: 21, color: C.text }),
  text(310, y + 48, body, { size: 16, color: C.muted, lh: 1.5 }),
  text(310, y + h - 34, note, { size: 16, color: o.noteColor || C.text }),
];
const input = (y, t, o = {}) =>
  rect(0, y, 250, 74, { label: t, size: 16, stroke: o.stroke || C.line, color: o.color || C.text });

export const skeleton = [
  tag(0, 0, "进入 agent 的东西", C.muted, 18),
  input(36, "你的 Telegram 消息\n（只接受你的 chat id）", { stroke: C.text }),
  input(124, "代币名称、描述\n（公共测试网，谁都能发币）", { stroke: C.danger }),
  input(212, "list / info / log 的输出\n（里面就有这些名称）", { stroke: C.warn }),
  input(300, "模型提供方的回复"),
  ...[73, 161, 249, 337].map((y) =>
    arrow(
      [
        [254, y],
        [286, 150],
      ],
      { stroke: C.line },
    ),
  ),

  tag(290, 0, "三层，从软到硬", C.muted, 18),
  ...band(
    36,
    178,
    "① skill 规则 · SKILL.md · 靠模型自觉",
    "先报价再交易 · 启动 autopilot 前复述并等“是”\n只用 mantle-meme · 不碰 root key、不读不打印环境变量\n被拒绝就停，不换个办法重试",
    "prompt injection 可以让模型违反其中任何一条。",
    { stroke: C.warn, dashed: true, noteColor: C.warn },
  ),
  ...band(
    230,
    178,
    "② 容器隔离 · Docker",
    "只挂 OpenClaw 状态、agent home、skills（只读）\n没有 root key、没有 ~/.mantle-aa、没有 docker socket\n但容器里的 agent 密码、bot token、模型登录，它都读得到",
    "凭据隔离边界：拿不到 root key，但不限制 session key 能做什么。",
    { stroke: C.muted },
  ),
  ...band(
    424,
    214,
    "③ 链上强制 · Calibur + AgentPolicyHook + MemeLaunchpad",
    "白名单：approve、buy、sell、createToken、claimCreatorFees\nMockUSD 总额 + 每日额度 · 只能卖这把 key 买到的\n收款人必须是账户 · deadline ≤ 600 s · 24 h 过期 · 撤销 = 墓碑\nLaunchpad 无 owner、参数不可变、只从调用者拉钱",
    "交易权限的强制边界：agent 被完全控制，这一层照样成立。",
    { stroke: C.accent, sw: 3, noteColor: C.accent },
  ),
  arrow(
    [
      [590, 218],
      [590, 228],
    ],
    { stroke: C.line },
  ),
  arrow(
    [
      [590, 412],
      [590, 422],
    ],
    { stroke: C.line },
  ),

  tag(930, 0, "被攻破的 agent", C.muted, 18),
  rect(930, 36, 350, 290, { stroke: C.danger }),
  text(
    948,
    50,
    "还能做的\n· 在额度内乱买，比如高价接别人\n  拉起来的币\n· 以任意低价卖掉自己的持仓\n· 发币、领手续费（钱进账户）\n· 在 sponsor 的上限内烧 gas 预算\n· 把容器里的凭据发出去",
    { size: 16, color: C.text, lh: 1.55 },
  ),
  rect(930, 346, 350, 292, { stroke: C.struct }),
  text(
    948,
    360,
    "做不到的\n· 把 MockUSD 转走\n· approve 给 Launchpad 以外的地址\n· 卖你自己的、别的 key 的代币\n· 改 policy、注册新 key\n· 用账户签 ERC-1271 签名\n· 撤销之后再回来\n· 碰到 root key",
    { size: 16, color: C.text, lh: 1.55 },
  ),
];
