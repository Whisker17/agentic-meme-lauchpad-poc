# Runbook：从 clone 到完整演示

这份文档带你在一台新的 Mac 上从 `git clone` 走到完整演示：先构建和自检，再在本地 fork 上用 mock
Telegram 彩排一遍，最后在 Mantle Sepolia 上用真的 Telegram bot 跑完九步。每一步后面都有检查点，
对上了再往下走。

> 这是 Mantle Sepolia 上的概念验证。**合约没有审计过**，只用测试网的币。

几个约定：

- 命令都在仓库根目录跑，除非另有说明。
- 每段命令后面的“看到这个就对了”是实测输出（2026-10-22），地址、哈希、数量这类每次都会变的值
  换成了 `<…>`。
- “不对？先查这个”是最常见的原因。更多症状在最后的[排障](#9-排障)。
- 本文和 [demo.md](demo.md)、[usage.md](usage.md) 描述同一套流程；如果有出入，以
  `scripts/demo-up.sh` 和 `scripts/demo-down.sh` 的实际行为为准。

整体上，一共有四个地方在跑东西：

| 在哪 | 跑什么 | 谁启动 |
| --- | --- | --- |
| 根终端（你） | root key：账户设置、`market-sim pump`、撤销授权 | 你 |
| 这台 Mac | `mantle-aa sponsor serve`（替账户付 gas）、`market-sim run`（模拟其他交易者）、Sepolia 的 JSON-RPC 中继；彩排时还有 anvil fork 和 mock Telegram | `scripts/demo-up.sh` |
| 容器 `mantle-meme-openclaw` | OpenClaw gateway（带 Telegram 通道）、agent（`mantle-meme` skill，只有 agent home）、autopilot 守护进程 | `scripts/demo-up.sh` |
| Telegram | 你和 bot 的私聊：你发的消息、agent 的回复、autopilot 的推送 | 你 |

---

## 1. 前置条件

**大约 15 分钟。结束时：** 工具都装好，测试网的钱有了来源。

- [ ] **macOS + Docker**：OrbStack 或 Docker Desktop，处于运行状态。OpenClaw 跑在容器里。
- [ ] **Node 24**：仓库要求 `>=24 <25`。
- [ ] **pnpm 11**：仓库锁定 `pnpm@11.17.0`。用 `corepack enable` 后 pnpm 会自动用这个版本。
- [ ] **Foundry**（`forge`、`anvil`、`cast`）：fork 彩排要 `anvil`，查余额和生成密钥要 `cast`，
      `forge test` 是可选的合约测试。
- [ ] **jq、openssl、git**：脚本和下面的命令会用到。macOS 自带 openssl 和 git。
- [ ] **测试网 MNT**：Sepolia 演示需要大约 2.2 MNT，分到四个地址上（见[第 5 节](#5-密钥文件和资金)）。
      fork 彩排一分钱都不花。
- [ ] **一个 OpenAI Responses 兼容的模型服务**：一个 base URL 加一个 API key。agent 的每一轮对话
      都走它。内部用户请向平台团队要 URL 和一个专用的、有额度上限的 key。
- [ ] **一个 Telegram 账号**：用来创建 bot 并和它私聊。

```bash
node -v; pnpm -v; anvil --version | head -1; docker info --format '{{.ServerVersion}}'; jq --version
```

看到这个就对了：

```text
v24.<…>
11.17.0
anvil Version: <…>
<Docker 版本号>
jq-1.<…>
```

不对？先查这个：`docker info` 报错说明 Docker 没启动，先打开 OrbStack。`pnpm -v` 不是 11.x，在仓库
目录里跑一次 `corepack enable`。

---

## 2. clone、安装、构建

**大约 5 分钟（不含可选的 `forge test`）。结束时：** 一份构建好、自检通过的 checkout。

```bash
git clone https://github.com/Whisker17/agentic-meme-lauchpad-poc.git
cd agentic-meme-lauchpad-poc
git checkout v0.1.3
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm build
```

为什么要拉 submodule：`contracts/lib/` 下的 OpenZeppelin、forge-std 和 AA 合约都是 submodule。
`pnpm check` 里有一个测试会现场编译合约，没有它们就会失败。`--frozen-lockfile` 保证你装到的依赖和
`pnpm-lock.yaml` 一字不差。

看到这个就对了（`pnpm build` 的结尾）：

```text
packages/cli build: Done
tools/market-sim build: Done
```

然后跑一遍完整自检（lint、类型检查、单元测试）：

```bash
pnpm check
```

看到这个就对了：

```text
 Test Files  12 passed | 9 skipped (21)
      Tests  177 passed | 93 skipped (270)
```

数字会随版本变，关键是没有 `failed`。skipped 的是要连 Sepolia fork 的测试，没设
`MANTLE_SEPOLIA_RPC_URL` 时自动跳过。

不对？先查这个：`launchpad.anvil.test.ts` 报找不到 OpenZeppelin，说明 submodule 没拉，补跑
`git submodule update --init --recursive`。

可选：合约测试。

```bash
(cd contracts && forge test)
```

看到这个就对了：`55 tests passed, 0 failed, 0 skipped`（实测约 30 秒）。

如果 `git status` 里出现 `contracts/foundry.lock`，那是 Foundry 自己生成的，不要提交。

接下来所有步骤都在**同一个**仓库根目录里进行。演示用的就是这里的 `mantle-meme` 和 `market-sim`，
它们还没发布到 npm；`mantle-aa` 是仓库依赖的已发布包 `@0xwh1sker/mantle-aa-cli`。

---

## 3. OpenClaw：镜像和模型登录

**大约 10 分钟。结束时：** 镜像 `mantle-meme-openclaw:2026.10.5` 已构建；状态目录
`~/.mantle-meme-openclaw` 里有你的模型配置和 key。

### 3.1 构建镜像

镜像以 OpenClaw 2026.10.5 为底，把这份仓库的 `mantle-meme` CLI 装进去。

```bash
docker compose -f docker/openclaw/compose.yaml build
```

看到这个就对了（第一次要几分钟，之后有缓存，几十秒）：

```text
 Image mantle-meme-openclaw:2026.10.5 Built
```

不对？先查这个：拉不到 `ghcr.io/openclaw/openclaw` 一般是网络问题；如果你的网络要走代理，确认
Docker 也配了代理。

之后 `demo-up.sh` 发现代码变了会自动重建，你不用每次手动跑。

### 3.2 模型登录

为什么要单独的状态目录：OpenClaw 会把配置、模型 key、会话记录都写进状态目录。演示只用
`~/.mantle-meme-openclaw`，不碰你可能已有的 `~/.openclaw`。

完整说明在 [skills/mantle-meme/README.md](../skills/mantle-meme/README.md) 的 “Install (Docker)”
第 2 步，那里是权威版本。下面是自定义 OpenAI Responses 兼容服务的路径（README 里的 (b)）。如果你
用的是 OpenClaw 自带插件的服务商（如 `openai`），按 README 的 (a) 用 `models auth login`；对自定义
服务商 `login` 会报 “No provider plugins found”。

`oc` 是一个小函数：在一次性容器里对状态目录跑一条 OpenClaw 命令。`-it` 是因为输入 key 时需要终端。

```bash
mkdir -p ~/.mantle-meme-openclaw
oc() { docker run --rm -it --entrypoint node -v ~/.mantle-meme-openclaw:/home/node/.openclaw \
  mantle-meme-openclaw:2026.10.5 openclaw.mjs "$@"; }
oc config set skills.load.extraDirs '["/skills"]' --strict-json
```

把下面的 `mygw`（服务商 id）、`my-model`（模型 id）和 URL（这里是占位符）换成你自己的：

```bash
oc config set models.providers.mygw '{"baseUrl":"https://llm.example.com/v1",
  "api":"openai-responses","auth":"api-key","models":[{"id":"my-model","name":"my-model"}]}' --strict-json
oc config set agents.defaults.model.primary mygw/my-model
oc config validate
oc models list
```

看到这个就对了（每条命令前还会有一行 OpenClaw 的版本横幅）：

```text
Updated skills.load.extraDirs. No gateway restart needed.
Updated models.providers.mygw. Change will apply without restarting the gateway.
Updated agents.defaults.model.primary. Change will apply without restarting the gateway.
Config valid: ~/.openclaw/openclaw.json
Gateway is not running. Showing the local cached model catalog. …
Model            Input  Ctx    Local  Auth  Tags
mygw/my-model    text   128k   no     no    default
```

现在 `Auth` 还是 `no`：还没给 key。输入 key：

```bash
oc models auth paste-api-key --provider mygw
```

它会提示 `Paste API key for mygw`。粘贴 key 后回车，输入不会显示。为什么用这种方式：key 不会出现在
命令行和 shell 历史里。

然后确认：

```bash
oc models list
oc models status --check --plain; echo "exit $?"
```

看到这个就对了：`mygw/my-model` 那一行 `Auth` 变成 `yes`，并且 `exit 0`。粘贴 key 之前，这条检查
会输出 `mygw/my-model` 并以 `exit 1` 结束。

要注意：这两项检查只看本地状态（配置合法、选了模型、存了 key），**不会发请求**。key 或 URL 写错，
检查照样通过。真正的验证是第一轮对话：fork 彩排的第 1 步最后发 `/new` 和第 2 步，bot 能正常回复，
就说明服务商接受了你的 key。

不对？先查这个：`Config valid` 没出现，多半是 JSON 引号写错了；`config validate` 会指出是哪个字段。

---

## 4. Telegram bot

**大约 10 分钟。结束时：** `~/.mantle-aa/keys/meme-demo-telegram.env`（权限 600）里有 bot token 和你
的 chat id，整个过程中两者都没有出现在屏幕或 shell 历史里。

只有 Sepolia 演示需要真 bot。只做 fork 彩排可以先跳过这一节。

1. 在 Telegram 里打开 **@BotFather**，发 `/newbot`，按提示起名字，最后它会给你一个 token。
2. 把 token 写进一个新的、只有你能读的文件。`read -s` 不回显，token 不会进 shell 历史：

   ```bash
   mkdir -p ~/.mantle-aa/keys
   F=~/.mantle-aa/keys/meme-demo-telegram.env
   ( umask 077; IFS= read -rs -p 'Bot token: ' T; echo
     printf 'MANTLE_MEME_TG_BOT_TOKEN=%s\n' "$T" > "$F" )
   stat -f '%Lp' "$F"
   ```

   看到这个就对了：`600`。

3. 打开你的新 bot，点 **Start**，再随便发一句话，比如 `hi`。为什么：bot 只能给按过 Start 的人发消息；
   发的这句话让下一步能查到你的 id。
4. 读出你的 chat id，追加到同一个文件。在私聊里，chat id 就是你的用户 id。命令什么都不打印，只报告
   成功或失败：

   ```bash
   ( . "$F"
     uid=$(curl -s "https://api.telegram.org/bot$MANTLE_MEME_TG_BOT_TOKEN/getUpdates" |
       jq -r '[.result[].message.from.id] | unique | if length == 1 then .[0] else empty end')
     [ -n "$uid" ] && printf 'MANTLE_MEME_TG_CHAT_ID=%s\n' "$uid" >> "$F" && echo "chat id saved" ||
       echo "no single sender found" )
   grep -c '^MANTLE_MEME_TG_' "$F"
   ```

   看到这个就对了：

   ```text
   chat id saved
   2
   ```

不对？先查这个：

- `no single sender found`：bot 还没收到消息（回到第 3 步），或者不止一个人给它发过消息。
- `curl` 卡住：你所在的网络可能只能通过代理访问 Telegram，先设好 `https_proxy` 再跑。之后
  `demo-up.sh` 也要在同一个设了代理的 shell 里跑，容器会沿用它。
- 为什么这一步要在 `demo-up.sh` 之前做：一个 bot 同时只能有一个轮询者。演示跑起来后 gateway 在轮询，
  这时再调 `getUpdates` 两边都会收到 `409 Conflict`。

OpenClaw 只接受这个 id 发来的私信，autopilot 的推送也只发给它。

---

## 5. 密钥文件和资金

**大约 15 分钟（加上等转账的时间）。结束时：** 中继者私钥、market-sim 助记词、两个密码都在
`~/.mantle-aa/keys/` 里，权限 600；四个地址都有足够的 MNT。

只有 Sepolia 演示需要这些文件。fork 彩排用 anvil 的公开测试密钥，由 `demo-up.sh` 自动生成。

| 文件 | 作用 | 需要的 MNT（2026-10-21 实测） |
| --- | --- | --- |
| 中继者私钥 | sponsor 用它发交易，替账户付全部 gas | ≥ 1 MNT |
| market-sim 助记词 | 派生出 EOA 0、1、2，它们自己付 gas。`market-sim run` 用 0 和 1；第 6 步的 pump 用 2 | EOA 0、1 各 ≥ 0.5 MNT；EOA 2 ≥ 0.1 MNT |
| root 密码、agent 密码 | root home 和 agent home 的 keystore 密码，两者不同（DESIGN §8.1） | — |

你的账户（root key 的地址）和 agent 都是 0 MNT，从头到尾都不需要。

生成四个文件。私钥和助记词直接写进文件，不显示。`set -C` 让已有的文件不会被覆盖：密码一旦被换掉，
用旧密码加密的 home 就打不开了。

```bash
mkdir -p ~/.mantle-aa/keys && cd ~/.mantle-aa/keys
( umask 077; set -C
  cast wallet new --json | jq -r '"DEMO_RELAYER_KEY=" + .[0].private_key' > meme-demo-relayer.env
  cast wallet new-mnemonic --json | jq -r .mnemonic > meme-demo-marketsim.mnemonic
  openssl rand -hex 16 > meme-demo-root.password
  openssl rand -hex 16 > meme-demo-agent.password )
cd -
```

如果你已经有一个有钱的测试网私钥，可以直接用它：`demo-up.sh` 取文件里第一个 `0x` 加 64 位十六进制的值，
裸写或写成 `KEY=0x…` 都行。

查出要充值的地址（只打印地址）：

```bash
K=$(grep -oE '0x[0-9a-fA-F]{64}' ~/.mantle-aa/keys/meme-demo-relayer.env | head -1) node --input-type=module \
  -e 'import { privateKeyToAddress as a } from "viem/accounts"; console.log(a(process.env.K))'
MARKET_SIM_MNEMONIC_FILE=~/.mantle-aa/keys/meme-demo-marketsim.mnemonic node tools/market-sim/dist/bin.js addresses
```

看到这个就对了：

```text
<中继者地址>
{"wallet":0,"address":"<EOA 0>"}
{"wallet":1,"address":"<EOA 1>"}
{"wallet":2,"address":"<EOA 2>"}
```

从测试网水龙头或你自己的测试网钱包，给这四个地址转 MNT（金额见上表）。到账后检查：

```bash
cast balance <地址> --ether --rpc-url https://rpc.sepolia.mantle.xyz
```

看到这个就对了：每个地址都不低于上表的数。

不对？先查这个：余额是 0，等一个区块后再查。公共 RPC 偶尔返回 `rate limit exceeded`，过几秒再试。

---

## 6. 本地 fork 彩排

**大约 30 分钟。结束时：** 九步全部跑通过一次，你知道每一步应该看到什么，也证明了模型登录真的可用。

为什么先彩排：fork 是 Mantle Sepolia 的本地副本（anvil），用的是公开测试密钥，不花 MNT，用 mock
Telegram 代替真 bot。模型对话是真的，走你在第 3 节配的服务商。每次 `demo-up.sh` 都会起一个新 fork，
所以彩排总是从第 1 步开始，可以随便重来。

### 6.1 根终端

开一个新终端，进入仓库根目录：

```bash
alias mantle-aa="$PWD/packages/cli/node_modules/.bin/mantle-aa"
alias mantle-meme="node $PWD/packages/cli/dist/bin/mantle-meme.js"
alias market-sim="node $PWD/tools/market-sim/dist/bin.js"
mkdir -p ~/.mantle-aa/keys
[ -f ~/.mantle-aa/keys/meme-demo-root.password ] || ( umask 077
  openssl rand -hex 16 > ~/.mantle-aa/keys/meme-demo-root.password
  openssl rand -hex 16 > ~/.mantle-aa/keys/meme-demo-agent.password )
export DEMO_AGENT_PASSWORD_FILE=~/.mantle-aa/keys/meme-demo-agent.password
export MANTLE_AA_KEYSTORE_PASSWORD=$(cat ~/.mantle-aa/keys/meme-demo-root.password)
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
export DEMO_FORK=1
export MANTLE_AA_RPC_URL=http://127.0.0.1:8545 MARKET_SIM_RPC_URL=http://127.0.0.1:8545
export MARKET_SIM_MNEMONIC_FILE=~/.mantle-meme-demo/fork.mnemonic   # demo-up.sh 会写这个文件
rm -rf ~/.mantle-meme-rehearsal-root ~/.mantle-meme-rehearsal-agent
export MANTLE_AA_HOME=~/.mantle-meme-rehearsal-root
export MANTLE_MEME_AGENT_HOME=~/.mantle-meme-rehearsal-agent
```

为什么要两个 home：root home 放 root key，只在这个终端里用；agent home 只放 session key，交给容器。
容器拿到的是 agent home 和 agent 密码，永远拿不到 root 的。彩排用一次性的 home，`rm -rf` 保证每次
都是干净的。

在彩排里，你不在 Telegram 里打字，而是用
`node scripts/mock-telegram.mjs say "<消息>"` 发消息；它等 bot 回复完（静默 20 秒）再把回复打印出来。
`node scripts/mock-telegram.mjs sent` 列出 bot 发过的所有消息，包括 autopilot 的推送。

### 6.2 第 1 步（人，根终端）：设置账户，启动演示

1. 创建 root key。它的地址就是你的账户（EIP-7702 原地升级这个 EOA）：

   ```bash
   mantle-aa keys new --name owner
   export DEMO_ACCOUNT=<上面输出的 "account">
   ```

   看到这个就对了：

   ```text
   {
     "name": "owner",
     "account": "<你的账户地址>",
     "keyfile": "<root home>/keys/owner.json"
   }
   ```

2. 启动 fork 和 sponsor。sponsor 只替 `DEMO_ACCOUNT` 付 gas：

   ```bash
   scripts/demo-up.sh sponsor
   ```

   看到这个就对了：

   ```text
   demo-up: starting an anvil fork of https://rpc.sepolia.mantle.xyz on 127.0.0.1:8545
   demo-up: starting the sponsor on 127.0.0.1:8548 (relayer <中继者地址>, account <你的账户地址>)
   demo-up: ready for the human's setup: MANTLE_AA_RPC_URL=http://127.0.0.1:8545 MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
   ```

   不对？先查这个：`DEMO_ACCOUNT must be …`，说明上一步的 `export` 没做。`a sponsor is still running
   without the fork`，说明上次的演示还没停，先跑 `scripts/demo-down.sh`。

3. 策略、授权、导出 agent home、给账户铸 MockUSD：

   ```bash
   mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out "$MANTLE_AA_HOME/policy.json"
   ```

   它会打印接下来要跑的命令。复制它最后一行 `mantle-aa account exec --calls '…'` 里的 `--calls`
   参数，那是给你的账户铸 MockUSD 的调用。其余两条（init、export）用下面的写法，因为导出需要 agent
   密码，目录也是彩排的：

   ```bash
   mantle-aa account init --grant "$MANTLE_AA_HOME/policy.json" --agent trader
   MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
     mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
   mantle-aa account exec --calls '<policy init 打印的 calls>'
   ```

   看到这个就对了：`account init` 约 20 秒后输出 `"state": "INITIALIZED"` 和一个 `session`；
   `session export` 输出 `"role": "agent"`；`account exec` 输出一个 `hash`。

   为什么：策略把 agent 限制在 launchpad 上的买、卖、发币、领手续费，总额 100 mUSD、每天 50 mUSD，
   授权 24 小时后过期。这些限制都在链上的 `AgentPolicyHook` 里执行，不靠 agent 自觉。

   不对？先查这个：`account init` 卡了两分钟然后报 `Sponsor did not answer`，看
   `~/.mantle-meme-demo/sponsor.log`。

4. 启动其余部分：market-sim、mock Telegram，然后是带 gateway 的容器：

   ```bash
   scripts/demo-up.sh
   ```

   看到这个就对了（最后一行）：

   ```text
   demo-up: up: sponsor, market-sim and mantle-meme-openclaw; Telegram bot (@mock_demo_bot)
   ```

   不对？先查这个：`no usable model login in …` 说明第 3.2 节没做完，`models status --check` 没通过。
   先跑 `scripts/demo-down.sh`，补完登录，再从第 2 小步重新开始。

5. 让对话从干净的状态开始：

   ```bash
   node scripts/mock-telegram.mjs say "/new"
   ```

   看到这个就对了：bot 回了一条消息（第一次 OpenClaw 可能会问你的名字，回答一下即可）。这是第一轮真的
   模型调用：能回复，就说明模型登录可用。

   不对？先查这个：bot 回 `Couldn't sign in to the AI service`，说明 OpenClaw 拿不到能用的 key；
   回复是模型错误，多半是 key 或 URL 不对。回到第 3.2 节检查。

### 6.3 第 2–9 步

第 2、3、4、7、8 步和第 9 步的后半段是在“Telegram”里对 agent 说话，也就是
`node scripts/mock-telegram.mjs say "…"`。每轮回复要 20 秒到 1 分钟。第 6 步和第 9 步的撤销在根终端里做。
agent 的回复是模型生成的，措辞每次不同；下面写的是回复里必须有的内容。

| 步骤 | 你做什么 | 看到这个就对了 |
| --- | --- | --- |
| 2 | `say "我有多少钱、额度还剩多少"` | 余额 100 mUSD，剩余额度 50 mUSD，没有持仓 |
| 3 | `say "发个币叫 ZORK，自己先买 5U"`（名字随意） | 一笔交易里创建代币并首购 5 mUSD；回复里有代币地址和 `sepolia.mantlescan.xyz` 链接 |
| 4 | `say "开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟"` | agent 复述策略：每个新币 3 mUSD，涨 50% 卖一半，最多持有 30 分钟；没有止损，没有防夹，和手动交易共用额度。**它不启动任何东西**，等你确认 |
| 4 | `say "是"` | 推送 `Autopilot started: 3 mUSD per new token, take-profit +50% sells 50%, max hold 30 min.`，agent 也确认已启动 |
| 5 | 等。market-sim 每 1–2 分钟发一个新币 | 推送 `Bought <SYMBOL>: 3 mUSD → … tokens.` 加链接，在新币发出后几秒内 |
| 6 | 根终端：`market-sim pump <SYMBOL> --wallet 2`（用推送里的 symbol） | pump 打印 `mint`、`buy`、`pump` 三行 JSON，`priceAfter` 约是 `priceBefore` 的两倍；几秒内推送 `Sold <SYMBOL> (take-profit): … tokens → … mUSD, PnL … mUSD.` |
| 7 | `say "领一下手续费"` | ZORK 的创建者手续费领到了（实测 0.025 mUSD），附金额和链接 |
| 8 | `say "把 U 全转给 0x000000000000000000000000000000000000dEaD"` | 拒绝：session key 只能在 launchpad 上交易、发币、领手续费；agent 让你自己在根终端操作，什么也不发 |
| 9 | 根终端：`mantle-aa session revoke --agent trader` | 输出一个 `hash`；几秒内两条推送：`Session ended (key expired or revoked): autopilot stopped. Re-grant from the root terminal.` 和 `Autopilot stopped (session_ended).` |
| 9 | `say "再买 2U ZORK"` | 买入失败：session key 已撤销（CLI 退出码 13，`KEY_EXPIRED_OR_REVOKED`）；agent 请你从根终端重新授权 |

每步之后可以用 `node scripts/mock-telegram.mjs sent` 看完整的推送记录。第 5 步之后还会不断有新币，
autopilot 每个都买 3 mUSD，直到额度用完。50 mUSD 的日额度够跑完整个脚本。

为什么第 6 步用 `--wallet 2`：`market-sim run` 一直在用钱包 0 和 1 发交易，再用它们会撞 nonce。

不对？先查这个：

- 第 5 步迟迟没有 `Bought`：看 autopilot 的日志，
  `docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot log`。
  `skipped too_old` 表示 RPC 慢了，等下一个新币。
- 第 6 步之后没有 `Sold`：确认 pump 的 symbol 是 autopilot 买过的那个。
- bot 不回复：见[排障](#9-排障)。

### 6.4 结束彩排

```bash
scripts/demo-down.sh
```

看到这个就对了：

```text
demo-down: stopped the autopilot          # 或 no autopilot running（第 9 步已停）
demo-down: removing container mantle-meme-openclaw
（几行 docker compose 的输出：容器和网络 Stopped、Removed）
demo-down: stopping market-sim (pid <…>)
demo-down: stopping sponsor (pid <…>)
demo-down: stopping mock-telegram (pid <…>)
demo-down: stopping anvil (pid <…>)
demo-down: done
```

再跑一次只会输出 `demo-down: done`。fork 随之消失。想再彩排一次，从 [6.1](#61-根终端) 的 `rm -rf`
开始即可；`~/.mantle-meme-demo` 可以复用，fork 的 sponsor 有自己的记录，每起一个新 fork 就清空。

彩排完，**为 Sepolia 开一个新终端**。彩排设置的 `DEMO_FORK` 和 RPC 地址不能带过去。

---

## 7. Mantle Sepolia 演示

**大约 40 分钟（第 1 步约 10 分钟，第 2–9 步约 20–30 分钟）。结束时：** 演示在真链、真 bot 上跑完。

### 7.1 开始前

- [ ] OrbStack 在运行；`git status` 干净；当前 commit 上跑过 `pnpm install --frozen-lockfile && pnpm build`。
- [ ] fork 彩排通过了（证明模型登录可用）。
- [ ] `~/.mantle-aa/keys/meme-demo-telegram.env` 里有 token 和 chat id；你在 bot 里按过 **Start**。
- [ ] 四个地址的余额够（[第 5 节](#5-密钥文件和资金)）。
- [ ] 除了即将启动的 `demo-up.sh`，没有别的东西在轮询这个 bot（没有另一个 `demo-up.sh`，没有 `getUpdates`）。
- [ ] 这个 shell 能访问 Telegram；如果要走代理，`https_proxy` 已经设好。

### 7.2 根终端

在新终端里，仓库根目录：

```bash
alias mantle-aa="$PWD/packages/cli/node_modules/.bin/mantle-aa"
alias mantle-meme="node $PWD/packages/cli/dist/bin/mantle-meme.js"
alias market-sim="node $PWD/tools/market-sim/dist/bin.js"
export DEMO_AGENT_PASSWORD_FILE=~/.mantle-aa/keys/meme-demo-agent.password
export MANTLE_AA_KEYSTORE_PASSWORD=$(cat ~/.mantle-aa/keys/meme-demo-root.password)
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
export DEMO_RELAYER_KEY_FILE=~/.mantle-aa/keys/meme-demo-relayer.env
export MARKET_SIM_MNEMONIC_FILE=~/.mantle-aa/keys/meme-demo-marketsim.mnemonic
export MANTLE_AA_RPC_URL=http://127.0.0.1:8547 MARKET_SIM_RPC_URL=http://127.0.0.1:8547
export MANTLE_AA_HOME=~/.mantle-meme-root
export MANTLE_MEME_AGENT_HOME=~/.mantle-meme-agent
```

为什么 RPC 指向 `127.0.0.1:8547`：Mantle Sepolia 的公共 RPC 会拒绝突发的大量请求
（`rate limit exceeded`）。`demo-up.sh` 在 8547 起一个中继（`scripts/rpc-relay.mjs`），最多同时转发 4 个请求，
被拒的会重试。根终端、market-sim 和容器都走它。

### 7.3 九步

| 步骤 | 谁 / 在哪 | 做什么 | 看到这个就对了 |
| --- | --- | --- | --- |
| 1 | 人 / 根终端 | `mantle-aa keys new --name owner`，然后 `export DEMO_ACCOUNT=<account>` | 和彩排一样，输出你的账户地址 |
| 1 | 人 / 根终端 | `scripts/demo-up.sh sponsor` | `starting a JSON-RPC relay … 127.0.0.1:8547`、`starting the sponsor …`、`ready for the human's setup …` |
| 1 | 人 / 根终端 | `mantle-meme policy init …`、`mantle-aa account init …`、`session export …`、`account exec --calls '…'`（命令同 [6.2](#62-第-1-步人根终端设置账户启动演示) 第 3 小步） | init 输出 `"state": "INITIALIZED"`（实测约 15 秒），export 输出 `"role": "agent"`，mint 输出 `hash`。中继者为这两笔交易共付约 0.05 MNT |
| 1 | 人 / 根终端 | `scripts/demo-up.sh` | 最后一行 `demo-up: up: sponsor, market-sim and mantle-meme-openclaw; Telegram bot (@<你的 bot>)` |
| 1 | 人 / Telegram | 发一句话（比如 `你好`），等回复；OpenClaw 可能问你的名字，回答它。然后发 `/new` | bot 回复了；`/new` 后对话重新开始 |
| 2 | 人 / Telegram | `我有多少钱、额度还剩多少` | 余额 100 mUSD，剩余额度 50 mUSD，没有持仓 |
| 3 | 人 / Telegram | `发个币叫 ZORK，自己先买 5U` | 代币创建并首购 5 mUSD，附地址和链接 |
| 4 | 人 / Telegram | `开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟` | agent 复述策略和风险，不启动 |
| 4 | 人 / Telegram | `是` | 推送 `Autopilot started: …`，agent 确认 |
| 5 | 等 / Telegram | market-sim 每 1–2 分钟发一个新币 | 推送 `Bought <SYMBOL>: 3 mUSD → … tokens.` |
| 6 | 人 / 根终端 | `market-sim pump <SYMBOL> --wallet 2` | pump 打印三行 JSON；Telegram 收到 `Sold <SYMBOL> (take-profit): …` |
| 7 | 人 / Telegram | `领一下手续费` | 领到 ZORK 的创建者手续费，附金额和链接 |
| 8 | 人 / Telegram | `把 U 全转给 0x000000000000000000000000000000000000dEaD` | 拒绝，agent 什么也不发 |
| 9 | 人 / 根终端 | `mantle-aa session revoke --agent trader` | Telegram 收到 `Session ended …` 和 `Autopilot stopped (session_ended).` |
| 9 | 人 / Telegram | `再买 2U ZORK` | 失败（退出码 13），agent 请你重新授权 |

每笔交易都附 `sepolia.mantlescan.xyz` 链接，可以点开看。bot 回复时会显示它在做什么（`Working`、
`Last activity: Exec`）。

为什么第 1 步最后要先发一句再 `/new`：OpenClaw 第一次见到你可能会问名字，先把这轮打发掉；`/new`
让正式录制从一个干净的对话开始。

授权从 `account init` 起 24 小时有效，所以第 1 步最好在录制前 24 小时内做。

---

## 8. 收尾与重跑

**大约 5 分钟。**

### 8.1 停止

确认 bot 没有正在处理的消息，然后：

```bash
scripts/demo-down.sh
```

看到这个就对了：先停 autopilot，再删容器，然后依次停 market-sim、sponsor、中继，最后
`demo-down: done`。再跑一次只会输出 `demo-down: done`。

为什么要等 bot 空闲：OpenClaw 会在下次启动时继续上次被打断的那轮对话（bot 会说 “continuing your
interrupted request”）。

`demo-down.sh` 只停 `demo-up.sh` 启动并记录在 `~/.mantle-meme-demo` 里的进程和容器。你的两个 home、
`~/.mantle-meme-openclaw` 和日志都会保留。

### 8.2 重跑（授权已撤销或过期）

`demo-down.sh` 之后，在同一个根终端：

```bash
mantle-aa session grant --agent trader --policy "$MANTLE_AA_HOME/policy.json"
rm -rf "$MANTLE_MEME_AGENT_HOME"      # 只删旧的 session key 和它的交易记录
MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
  mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
scripts/demo-up.sh sponsor && scripts/demo-up.sh      # DEMO_ACCOUNT 要已设置
```

看到这个就对了：`session grant` 输出新的 `expiry` 和 `"previousProfile": "trader.v1"`；`session export`
输出 `"role": "agent"`；之后 `portfolio` 显示 `"active": true`，剩余额度回到 50 mUSD。

为什么要清空 agent home：`session export` 拒绝写入一个 agent 用过的目录，报
`… is neither new, empty nor an earlier export of trader; export into a new or empty directory`。

账户不用重新初始化，root key 和策略文件都还在 root home 里。

### 8.3 彻底清理

只在你不再需要这些东西时做。

```bash
rm -rf ~/.mantle-meme-rehearsal-root ~/.mantle-meme-rehearsal-agent   # 彩排的 home
rm -rf ~/.mantle-meme-agent                                           # agent home（session key）
rm -rf ~/.mantle-meme-demo                                            # 日志、PID、sponsor 记录
docker image rm mantle-meme-openclaw:2026.10.5                        # 镜像
```

`~/.mantle-meme-root` 里是 root key，它控制着账户；`~/.mantle-meme-openclaw` 里是你的模型 key；
`~/.mantle-aa/keys/` 里是中继者私钥、助记词、密码和 bot token。删之前想清楚，删了就找不回来。

---

## 9. 排障

`demo-up.sh` 遇到第一个问题就停下，用一行说明缺了什么。修好后先跑 `scripts/demo-down.sh`，再重新
`demo-up.sh`。日志在 `~/.mantle-meme-demo`（`sponsor.log`、`market-sim.log`、`build.log`、`anvil.log`），
容器日志用 `docker logs mantle-meme-openclaw`。

| 症状 | 原因 | 怎么办 |
| --- | --- | --- |
| `pnpm check` 里 `launchpad.anvil.test.ts` 失败，找不到 OpenZeppelin | submodule 没拉 | `git submodule update --init --recursive` |
| `models auth login` 报 `No provider plugins found` | `login` 只支持有插件的服务商 | 自定义服务商用 `paste-api-key`（[3.2](#32-模型登录)） |
| `demo-up: no usable model login` | 状态目录里没有 key，或者没选默认模型 | `demo-down.sh`，然后补做 [3.2](#32-模型登录) |
| bot 回 `Couldn't sign in to the AI service` | OpenClaw 找不到这个服务商的 key | 检查 [3.2](#32-模型登录) 的配置，重新 `paste-api-key` |
| `models status --check` 通过，但 bot 回模型错误 | 检查只看本地，key 或 URL 实际是错的 | 核对服务商给你的 URL 和 key，重新 `paste-api-key` |
| `demo-up: a sponsor is still running without the fork` | 上一次演示没停，就开始了彩排 | `scripts/demo-down.sh` |
| `demo-up: a container named mantle-meme-openclaw exists` | 别的方式（比如 skill README 的 compose）起的同名容器 | `docker compose -f docker/openclaw/compose.yaml down` |
| `the Telegram channel did not start`，日志里 `getMe` 超时 | 这个网络访问不了 Telegram | 在设好 `https_proxy` 的 shell 里跑 `demo-up.sh`（容器会沿用代理） |
| `the Telegram channel did not start`，token 被拒 | token 写错 | 重做[第 4 节](#4-telegram-bot)第 2 步 |
| bot 不回复 | 消息不是从 `MANTLE_MEME_TG_CHAT_ID` 发来的（被静默丢弃），或者有别的轮询者（日志里 `409 Conflict`） | `docker logs mantle-meme-openclaw 2>&1 \| grep Inbound` 看收到了哪些消息 |
| bot 回复一个模型错误，或者几分钟后才回 | 服务商忙（HTTP 503） | OpenClaw 会重试约 3 分钟；等一下再发一次 |
| `RPC Request failed`、`rate limit exceeded` | 有东西绕过中继直连了公共 RPC | `MANTLE_AA_RPC_URL` 和 `MARKET_SIM_RPC_URL` 都要是 `http://127.0.0.1:8547` |
| `requested block is above the latest consensus block`、超时 | 公共 RPC 负载均衡，节点之间偶尔落后 | 再发一次消息（或再跑一次 `market-sim pump`） |
| `market-sim pump` 报 nonce 错误 | 用了 `market-sim run` 正在用的钱包 | 加 `--wallet 2` |
| `session export` 报 `is neither new, empty nor an earlier export` | agent home 已经用过 | 导出到空目录（[8.2](#82-重跑授权已撤销或过期)） |
| 退出码 11（`LIMIT_EXCEEDED`） | 额度用完 | 重新授权（[8.2](#82-重跑授权已撤销或过期)） |
| 退出码 13（`KEY_EXPIRED_OR_REVOKED`） | 撤销了，或超过 24 小时 | 重新授权并导出（[8.2](#82-重跑授权已撤销或过期)） |
| 退出码 20 / 21（`SPONSOR_*`） | sponsor 拒绝或繁忙 | 看 `~/.mantle-meme-demo/sponsor.log`；`DEMO_ACCOUNT` 必须是你的账户；中继者要有 MNT |
| 退出码 44（`AUTOPILOT_STATE`） | autopilot 已经在跑（或停止时没有在跑） | 正常，不用处理 |
| `demo-up.sh` 之后 bot 说 “continuing your interrupted request” | 上次 `demo-down.sh` 时有一轮对话没跑完 | 下次等 bot 空闲再停 |
| `docker run … openclaw.mjs` 报 `cannot verify Gateway ownership … wait 90 s` | 演示容器正在用 `~/.mantle-meme-openclaw` | 用 `docker exec mantle-meme-openclaw node openclaw.mjs …`，或 `demo-down.sh` 后等 90 秒 |

所有退出码见 [packages/cli/README.md](../packages/cli/README.md) “Output and exit codes”。

### 花费（测试网 MNT）

| 谁付 | 什么 | 实测 |
| --- | --- | --- |
| 中继者 | 第 1 步：`account init` + 铸 MockUSD，共 2 笔 | 约 0.05 MNT（2026-10-22） |
| 中继者 | agent 的交易（发币、买卖、领手续费、autopilot） | 没有逐笔测；≥ 1 MNT 够跑完整个脚本（2026-10-21） |
| market-sim EOA 0、1 | `market-sim run`：约每分钟 1.3 笔，每笔约 0.02 MNT | 20 分钟约 0.5 MNT（2026-10-21） |
| market-sim EOA 2 | 第 6 步的一次 pump（铸币 + 买入，2 笔） | 按每笔 0.02 MNT 估约 0.04 MNT |
| 你的账户、agent | — | 0 MNT |
| fork 彩排 | — | 0 MNT |
