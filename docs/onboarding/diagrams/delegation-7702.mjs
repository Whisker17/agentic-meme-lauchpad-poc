// 2 · 7702 升级前后，EOA 变成了什么 (section 2)
import { arrow, box, C, rect, tag, text } from "./lib.mjs";

export const alt =
  "EIP-7702 升级前后对比。左：普通 EOA，地址就是 root key 的地址，没有代码，只有 root key 能动它。" +
  "中间：sponsor 代付 gas 的一笔 type-4 交易，带 root key 签的 7702 授权（delegate 为 CaliburEntry，chainId 5003）" +
  "和一个初始化批次：approveNative(ERC20ETH, 0)、注册 session key、给它设置 hook 和 24 小时过期、在 AgentPolicyHook 上写入 policy。" +
  "右：同一个地址变成 Calibur 智能账户，余额不动，root key 仍是 admin，session key 的每次调用都经过 AgentPolicyHook。" +
  "下方：AgentPolicyHook 按 (keyHash, account) 存 policy、已花额度、inventory 和状态；账户状态机 UNDELEGATED → DELEGATED → INITIALIZED。";

const L = (x, y, t, o = {}) => text(x, y, t, { size: 18, color: C.muted, lh: 1.45, ...o });

export const skeleton = [
  tag(0, 0, "升级前", C.muted, 20),
  rect(0, 34, 330, 300, { stroke: C.muted }),
  text(20, 50, "普通 EOA", { size: 24, color: C.text }),
  L(
    20,
    94,
    "地址 0xAbc…\n= root key 的地址\n\n代码：空\n余额：MockUSD（MNT 可以是 0）\n\n只有 root key 能动它，\n而且什么都能做",
  ),

  arrow(
    [
      [346, 184],
      [826, 184],
    ],
    { sw: 3 },
  ),
  text(372, 40, "一笔 type-4 交易 · sponsor 付 gas", { size: 20, color: C.text }),
  L(372, 74, "① 7702 授权（root key 签）\n    delegate = CaliburEntry · chainId 5003"),
  L(
    372,
    204,
    "② 初始化批次（root key 签，一起成功或一起回滚）\n    approveNative(ERC20ETH, 0)\n    register(session key)\n    update(keyHash, {hook, 过期 = 现在 + 24 h})\n    hook.setPolicy(keyHash, policy)",
  ),

  tag(846, 0, "升级后", C.accent, 20),
  rect(846, 34, 354, 300, { stroke: C.accent, sw: 3 }),
  text(866, 50, "同一个地址的智能账户", { size: 24, color: C.text }),
  L(
    866,
    94,
    "地址 0xAbc…（没变），余额没动\n代码：0xef0100 ‖ CaliburEntry\n\nCalibur 里的 key：\n· root：keyHash 0，admin，不过 hook\n· session key：非 admin，有过期时间，\n  每次调用前后都调 AgentPolicyHook",
  ),

  arrow([
    [1023, 338],
    [1023, 404],
  ]),
  ...box(
    430,
    408,
    770,
    116,
    "AgentPolicyHook（单例，不可升级，所有账户共用）",
    "按 (keyHash, account) 存：policy · 已花额度（总额 + 每日）· inventory（这把 key 买到的 meme）\n· Summary{initialized, active, revoked}：revoked 是墓碑，同一把 key 永远不能再授予",
    { ts: 21, ss: 17, stroke: C.struct },
  ),
  text(0, 408, "账户状态机\nUNDELEGATED → DELEGATED → INITIALIZED", {
    size: 18,
    color: C.text,
    lh: 1.45,
  }),
  L(
    0,
    470,
    "授权在执行之前就生效：初始化批次失败，\n委托也不会撤销，账户停在 DELEGATED，\n重新跑 account init 即可。",
    { size: 16, color: C.tag },
  ),
];
