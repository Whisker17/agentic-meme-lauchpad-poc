// 9 · 容器、launcher、gateway、daemon 的进程树与挂载 (section 4)
import { arrow, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "容器结构图。左边是 Docker 容器 mantle-meme-openclaw 里的进程树：tini 是 PID 1，下面是主进程 launcher.mjs，" +
  "它监听容器内的 /tmp/mantle-meme-launcher.sock；launcher 启动 OpenClaw gateway（只绑 loopback），gateway 为每轮对话跑 agent，" +
  "agent 的 exec 工具是一个 child subreaper，命令返回时会杀掉它留下的所有进程。所以 agent 调用的 mantle-meme 是一个 wrapper：" +
  "普通命令直接跑真 CLI，只有 autopilot start 经 socket 交给 launcher，由 launcher 启动的 daemon 是 launcher 的后代，能活过这一轮对话；" +
  "如果直接从 exec 启动，daemon 会在启动后约 16 毫秒被停掉。容器只挂三个目录：OpenClaw 状态（读写）、agent home（读写）、仓库的 skills（只读）。" +
  "右边是宿主机：root 终端和 root home 从不挂进容器；sponsor 在 127.0.0.1:8548，relayer 私钥只在它的环境变量里；" +
  "RPC relay 在 127.0.0.1:8547，最多 4 个并发并重试被限流的请求；market-sim；可选的 https 代理。容器通过 host.docker.internal 访问它们。";

const proc = (x, y, w, h, title, sub, o = {}) => [
  rect(x, y, w, h, { stroke: o.stroke || C.muted, sw: o.sw, dashed: o.dashed }),
  text(x + 14, y + 10, title, { size: 18, color: o.color || C.text }),
  ...(sub ? [text(x + 14, y + 36, sub, { size: 15, color: C.muted, lh: 1.4 })] : []),
];
const host = (y, h, title, sub, o = {}) => proc(850, y, 400, h, title, sub, o);

export const skeleton = [
  rect(0, 0, 1280, 880, { stroke: C.line, bg: "transparent" }),
  tag(16, 10, "你的 Mac（宿主机）", C.muted, 18),

  rect(20, 44, 800, 816, { stroke: C.struct, sw: 3, bg: "transparent" }),
  tag(
    36,
    54,
    "容器 mantle-meme-openclaw · OpenClaw 2026.10.5 镜像 + 内置 mantle-meme · 沙箱关闭，容器就是边界",
    C.struct,
    16,
  ),

  ...proc(40, 90, 220, 44, "tini（PID 1）"),
  arrow(
    [
      [80, 138],
      [80, 158],
    ],
    { stroke: C.line },
  ),
  ...proc(
    60,
    160,
    740,
    70,
    "node launcher.mjs（容器主进程）",
    "监听 /tmp/mantle-meme-launcher.sock（容器内，不在挂载卷上）；只接受 autopilot start",
    {
      stroke: C.struct,
    },
  ),
  arrow(
    [
      [110, 234],
      [110, 254],
    ],
    { stroke: C.line },
  ),
  ...proc(
    90,
    256,
    710,
    66,
    "openclaw gateway --bind loopback",
    "MANTLE_MEME_GATEWAY=1 时由 launcher 启动；Telegram 通道，每条消息一轮对话",
  ),
  arrow(
    [
      [140, 326],
      [140, 346],
    ],
    { stroke: C.line },
  ),
  ...proc(
    120,
    348,
    680,
    66,
    "agent 这一轮 → exec 工具（child subreaper）",
    "命令返回时，它留下的进程全被杀掉；这一轮结束时，还在跑的也被停掉",
    {
      stroke: C.warn,
    },
  ),
  arrow(
    [
      [170, 418],
      [170, 438],
    ],
    { stroke: C.line },
  ),
  ...proc(
    150,
    440,
    650,
    66,
    "mantle-meme（wrapper，在 agent 的 PATH 上）",
    "portfolio / buy / sell / create / … 直接跑真 CLI；autopilot start 交给 launcher",
  ),

  arrow(
    [
      [790, 474],
      [810, 474],
      [810, 195],
      [804, 195],
    ],
    { stroke: C.struct },
  ),
  tag(616, 516, "autopilot start → socket", C.struct, 15),
  arrow(
    [
      [60, 230],
      [44, 230],
      [44, 600],
      [58, 600],
    ],
    { stroke: C.struct },
  ),
  ...proc(
    60,
    556,
    420,
    80,
    "autopilot daemon",
    "launcher 的后代，不在 OpenClaw 的进程树里：\n活过这一轮对话，直到 stop、撤销或容器停止",
    {
      stroke: C.accent,
      sw: 3,
    },
  ),
  ...proc(500, 556, 300, 80, "直接从 exec 启动的 daemon", "实测：启动后几毫秒就被停掉", {
    stroke: C.danger,
    dashed: true,
    color: C.muted,
  }),

  tag(40, 660, "挂载（只有这三个）", C.muted, 16),
  text(40, 686, "/home/node/.openclaw", { size: 15, color: C.text }),
  text(290, 686, "← ~/.mantle-meme-openclaw", { size: 15, color: C.text }),
  text(500, 686, "读写：OpenClaw 状态、模型登录、会话", { size: 15, color: C.muted }),
  text(40, 712, "/home/node/.mantle-meme-agent", { size: 15, color: C.text }),
  text(290, 712, "← ~/.mantle-meme-agent", { size: 15, color: C.text }),
  text(500, 712, "读写：session key、journal、autopilot 文件", { size: 15, color: C.muted }),
  text(40, 738, "/skills", { size: 15, color: C.text }),
  text(290, 738, "← 仓库的 skills/", { size: 15, color: C.text }),
  text(500, 738, "只读：SKILL.md", { size: 15, color: C.muted }),
  text(
    40,
    780,
    "环境变量：MANTLE_AA_HOME = agent home · MANTLE_AA_KEYSTORE_PASSWORD = agent 的密码（docker inspect 可见）\n· RPC / sponsor URL 指向 host.docker.internal · Telegram bot token 和 chat id · HTTPS_PROXY（可选）",
    { size: 15, color: C.muted, lh: 1.6 },
  ),

  ...host(
    56,
    92,
    "root 终端 · root home",
    "root key 和 root 密码只在这里。\n从不挂进容器，demo 脚本也不碰它",
    {
      stroke: C.text,
    },
  ),
  ...host(
    170,
    92,
    "sponsor · 127.0.0.1:8548",
    "mantle-aa sponsor serve；allowlist 只有你的账户。\nrelayer 私钥只在它自己的环境变量里",
  ),
  ...host(
    284,
    92,
    "rpc-relay · 127.0.0.1:8547",
    "公共 RPC 会拒绝突发请求：最多 4 个并发，\n被限流的请求重试",
  ),
  ...host(398, 72, "market-sim", "普通 EOA，自己付 gas：发币、随机买卖"),
  ...host(492, 72, "https 代理（可选）", "Telegram 只能走代理的网络里，容器也走它"),
  arrow(
    [
      [824, 216],
      [846, 216],
    ],
    { stroke: C.muted },
  ),
  arrow(
    [
      [824, 330],
      [846, 330],
    ],
    { stroke: C.muted },
  ),
  arrow(
    [
      [824, 528],
      [846, 528],
    ],
    { stroke: C.muted },
  ),
  tag(850, 590, "容器经 host.docker.internal 访问这些服务", C.muted, 15),
  text(850, 650, "从不挂载：\n~/.mantle-aa、root home、~/.ssh、\n~/.openclaw、docker socket", {
    size: 17,
    color: C.text,
    lh: 1.5,
  }),
];
