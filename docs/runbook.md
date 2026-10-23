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
- 命令在 macOS 默认的 zsh 和 bash 里都能直接粘贴运行。`<…>` 是要你换成自己值的占位符。
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

**大约 10 分钟。结束时：** 镜像 `mantle-meme-openclaw:2026.10.6` 已构建；状态目录
`~/.mantle-meme-openclaw` 里有你的模型配置和 key。

### 3.1 构建镜像

镜像以 OpenClaw 2026.10.6 为底，把这份仓库的 `mantle-meme` CLI 装进去。

```bash
docker compose -f docker/openclaw/compose.yaml build
```

看到这个就对了（第一次要几分钟，之后有缓存，几十秒）：

```text
 Image mantle-meme-openclaw:2026.10.6 Built
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
  mantle-meme-openclaw:2026.10.6 openclaw.mjs "$@"; }
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
2. 把 token 写进一个新的、只有你能读的文件。`read -s` 不回显，token 不会进 shell 历史。`set -C` 让命令
   在文件已存在时失败，而不是改写一个权限可能不对的旧文件；写完再确认权限是 600：

   ```bash
   mkdir -p ~/.mantle-aa/keys
   F=~/.mantle-aa/keys/meme-demo-telegram.env
   ( umask 077; set -C; printf 'Bot token: '; IFS= read -rs T; echo
     printf 'MANTLE_MEME_TG_BOT_TOKEN=%s\n' "$T" > "$F" ) &&
     [ "$(stat -f '%Lp' "$F")" = 600 ] && echo "token saved, mode 600" ||
     echo "NOT SAVED: $F already exists or is not mode 600"
   ```

   看到这个就对了：提示 `Bot token: `，粘贴 token 回车（不显示），然后输出 `token saved, mode 600`。

   不对？先查这个：`NOT SAVED`，前面还有一行 `file exists` 或 `cannot overwrite existing file`，说明
   这个文件以前建过。确认不再需要里面的内容后 `rm "$F"`，再从这一步重做（第 4 步的 chat id 也要重做）。

3. 打开你的新 bot，点 **Start**，再随便发一句话，比如 `hi`。为什么：bot 只能给按过 Start 的人发消息；
   发的这句话让下一步能查到你的 id。
4. 读出你的 chat id，追加到同一个文件。在私聊里，chat id 就是你的用户 id。命令不会打印 token 或 chat id，
   只打印保存结果和文件中的变量数量。带 token 的 URL 由 shell 内建的 `printf` 经标准输入交给 `curl -K -`，
   所以 token 不会出现在任何进程的命令行参数里（别人用 `ps` 也看不到）。只取私聊里的数字 id，而且必须
   恰好一个。文件里已经有 chat id 时，命令什么都不改，只打印 `chat id already saved`：

   ```bash
   ( . "$F"
     if grep -q '^MANTLE_MEME_TG_CHAT_ID=' "$F"; then echo "chat id already saved"; exit; fi
     uid=$(printf 'url = "https://api.telegram.org/bot%s/getUpdates"\n' "$MANTLE_MEME_TG_BOT_TOKEN" |
       curl -sS -K - | jq -r '[.result[]?.message? | select(.chat.type? == "private")
         | .chat.id | select(type == "number")] | unique | if length == 1 then .[0] else empty end')
     case $uid in
       ''|*[!0-9]*) echo "no single sender found" ;;
       *) printf 'MANTLE_MEME_TG_CHAT_ID=%s\n' "$uid" >> "$F" && echo "chat id saved" ;;
     esac )
   grep -c '^MANTLE_MEME_TG_' "$F"
   ```

   看到这个就对了：

   ```text
   chat id saved
   2
   ```

   再跑一次会看到 `chat id already saved` 和 `2`。要故意换一个 chat id，先删掉旧的那一行
   （`sed -i '' '/^MANTLE_MEME_TG_CHAT_ID=/d' "$F"`），再跑这一步。

不对？先查这个：

- `no single sender found`：bot 还没收到私聊消息（回到第 3 步），或者不止一个人私聊过它。
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

生成四个文件。私钥和助记词直接写进文件，不显示。已有的文件原样保留，绝不覆盖（`set -C` 再兜一层）：
密码一旦被换掉，用旧密码加密的 home 就打不开了。最后逐个检查四个文件都不为空、权限都是 600。

```bash
mkdir -p ~/.mantle-aa/keys && cd ~/.mantle-aa/keys
( umask 077; set -C
  [ -e meme-demo-relayer.env ] && echo "meme-demo-relayer.env already exists, reused" ||
    cast wallet new --json | jq -er '"DEMO_RELAYER_KEY=" + .[0].private_key' > meme-demo-relayer.env
  [ -e meme-demo-marketsim.mnemonic ] && echo "meme-demo-marketsim.mnemonic already exists, reused" ||
    cast wallet new-mnemonic --json | jq -er .mnemonic > meme-demo-marketsim.mnemonic
  [ -e meme-demo-root.password ] && echo "meme-demo-root.password already exists, reused" ||
    openssl rand -hex 16 > meme-demo-root.password
  [ -e meme-demo-agent.password ] && echo "meme-demo-agent.password already exists, reused" ||
    openssl rand -hex 16 > meme-demo-agent.password
  for f in meme-demo-relayer.env meme-demo-marketsim.mnemonic meme-demo-root.password meme-demo-agent.password; do
    [ -s "$f" ] && [ "$(stat -f '%Lp' "$f")" = 600 ] && echo "ok  $f" || echo "BAD $f: empty or not mode 600"
  done )
cd -
```

看到这个就对了（第一次跑；如果第 6 节的彩排已经生成过两个密码文件，前面会多两行 `already exists, reused`）：

```text
ok  meme-demo-relayer.env
ok  meme-demo-marketsim.mnemonic
ok  meme-demo-root.password
ok  meme-demo-agent.password
```

不对？先查这个：`BAD … empty`，说明生成失败（比如没装 Foundry，找不到 `cast`），先 `rm` 掉那个空文件，
装好后再跑一次；`BAD … not mode 600`，是你以前留下的文件，对它跑 `chmod 600`。

如果你已经有一个有钱的测试网私钥，可以直接用它：`demo-up.sh` 取文件里第一个 `0x` 加 64 位十六进制的值，
裸写或写成 `KEY=0x…` 都行。

查出要充值的地址（只打印地址，不打印私钥和助记词）：

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
( cd ~/.mantle-aa/keys && umask 077 && set -C
  [ -e meme-demo-root.password ] || openssl rand -hex 16 > meme-demo-root.password
  [ -e meme-demo-agent.password ] || openssl rand -hex 16 > meme-demo-agent.password )
export DEMO_AGENT_PASSWORD_FILE=~/.mantle-aa/keys/meme-demo-agent.password
export MANTLE_AA_KEYSTORE_PASSWORD=$(cat ~/.mantle-aa/keys/meme-demo-root.password)
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
export DEMO_FORK=1
export MANTLE_AA_RPC_URL=http://127.0.0.1:8545 MARKET_SIM_RPC_URL=http://127.0.0.1:8545
export MARKET_SIM_MNEMONIC_FILE=~/.mantle-meme-demo/fork.mnemonic
rm -rf ~/.mantle-meme-rehearsal-root ~/.mantle-meme-rehearsal-agent
export MANTLE_AA_HOME=~/.mantle-meme-rehearsal-root
export MANTLE_MEME_AGENT_HOME=~/.mantle-meme-rehearsal-agent
```

两个密码文件已存在就沿用，不会被覆盖。`fork.mnemonic` 现在还不存在，`demo-up.sh` 会写它。

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
   ```

   看到这个就对了：

   ```text
   {
     "name": "owner",
     "account": "<你的账户地址>",
     "keyfile": "<root home>/keys/owner.json"
   }
   ```

   不对？先查这个：`error: profile owner already exists`，说明 root home 不是空的，回到 [6.1](#61-根终端) 的 `rm -rf`。

   把账户地址记进 `DEMO_ACCOUNT`，后面的 sponsor 只替它付 gas：

   ```bash
   export DEMO_ACCOUNT=$(mantle-aa keys list | jq -r '.profiles[] | select(.name == "owner") | .account')
   echo "$DEMO_ACCOUNT"
   ```

   看到这个就对了：和上面 `"account"` 一样的地址。

   不对？先查这个：输出是空行，说明这个终端的 `MANTLE_AA_HOME` 不是刚才那个，重跑 [6.1](#61-根终端) 的设置。

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

   不对？先查这个：`DEMO_ACCOUNT must be the human's account address`，说明上一步的 `export` 没做。
   `a sponsor is still running without the fork`，说明上次的演示还没停，先跑 `scripts/demo-down.sh`。

3. 策略、授权、导出 agent home、给账户铸 MockUSD，一共四条命令。先写策略，并把它的输出存一份：

   ```bash
   mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out "$MANTLE_AA_HOME/policy.json" |
     tee "$MANTLE_AA_HOME/policy-init.txt"
   ```

   看到这个就对了：

   ```text
   Wrote <root home>/policy.json

   Next, in the root terminal (MANTLE_AA_HOME = the root home; an initialised account grants
   with: mantle-aa session grant --agent trader --policy <root home>/policy.json):
     mantle-aa account init --grant <root home>/policy.json --agent trader
     mantle-aa session export --agent trader --out ~/.mantle-meme-agent
     mantle-aa account exec --calls '[{"to":"<MockUSD 地址>","data":"<铸币调用>"}]'

   Then run the agent with MANTLE_AA_HOME=~/.mantle-meme-agent and its own keystore password
   (MANTLE_AA_KEYSTORE_PASSWORD = the export password).
   ```

   它打印的三条命令不要照抄：导出那条没带 agent 密码，目录也不是彩排的。下面三条是它们的彩排版。

   为什么要这个策略：它把 agent 限制在 launchpad 上的买、卖、发币、领手续费，总额 100 mUSD、每天
   50 mUSD，授权 24 小时后过期。这些限制都在链上的 `AgentPolicyHook` 里执行，不靠 agent 自觉。

   初始化账户并授权 agent `trader`：

   ```bash
   mantle-aa account init --grant "$MANTLE_AA_HOME/policy.json" --agent trader
   ```

   看到这个就对了（约 20 秒）：

   ```text
   {
     "account": "<你的账户地址>",
     "state": "INITIALIZED",
     "hash": "<交易哈希>",
     "session": {
       "profile": "trader",
       …
     }
   }
   ```

   不对？先查这个：卡了两分钟然后报 `Sponsor did not answer`，看 `~/.mantle-meme-demo/sponsor.log`。

   把 session key 导出到 agent home，用 agent 密码加密：

   ```bash
   MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
     mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
   ```

   看到这个就对了：输出的 JSON 里有 `"profile": "trader"` 和 `"role": "agent"`。

   不对？先查这个：`is neither new, empty nor an earlier export`，说明 agent home 不是空的，回到
   [6.1](#61-根终端) 的 `rm -rf`。

   给你的账户铸 100 mUSD。`--calls` 取自刚才存下的 `policy init` 输出的最后一条命令，不用手抄：

   ```bash
   CALLS=$(sed -nE "s/.*account exec --calls '(.*)'\$/\1/p" "$MANTLE_AA_HOME/policy-init.txt")
   mantle-aa account exec --calls "$CALLS"
   ```

   看到这个就对了：

   ```text
   {
     "account": "<你的账户地址>",
     "hash": "<交易哈希>",
     "warnings": []
   }
   ```

   不对？先查这个：`error: --calls is required`，说明 `$CALLS` 是空的：`policy init` 那一步没带 `| tee`，
   重跑那一条（会覆盖同一个策略文件，内容不变）。

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

第 2、3、4、7、8 步和第 9 步的后半段是在“Telegram”里对 agent 说话：彩排里就是用
`node scripts/mock-telegram.mjs say` 发一条消息。每轮回复要 20 秒到 1 分钟。第 6 步和第 9 步的撤销在根终端里做。
agent 的回复是模型生成的，措辞每次不同；下面写的是回复里必须有的内容。推送（autopilot 发的消息）是固定文本，
`<SYMBOL>` 这类值每次不同。

每步之后都可以列出 bot 发过的所有消息，包括推送：

```bash
node scripts/mock-telegram.mjs sent
```

| 步骤 | 谁 / 在哪 | 做什么 |
| --- | --- | --- |
| 2 | 人 / Telegram | 问余额和额度 |
| 3 | 人 / Telegram | 发币并首购 |
| 4 | 人 / Telegram | 说出打新策略，确认后启动 |
| 5 | 等 | autopilot 买入一个新币 |
| 6 | 人 / 根终端 | 拉升那个币，触发止盈 |
| 7 | 人 / Telegram | 领创建者手续费 |
| 8 | 人 / Telegram | 要求转走资金，被拒绝 |
| 9 | 人 / 根终端，然后 Telegram | 撤销授权；再让 agent 买，失败 |

**第 2 步：余额和额度。**

```bash
node scripts/mock-telegram.mjs say "我有多少钱、额度还剩多少"
```

看到这个就对了：回复里有余额 100 mUSD、剩余额度 50 mUSD、没有持仓。

不对？先查这个：余额是 0，说明第 1 步的铸币（`account exec`）没成功，回到 6.2 第 3 小步重跑那一条。

**第 3 步：发币并首购 5 mUSD**（名字随意）。

```bash
node scripts/mock-telegram.mjs say "发个币叫 ZORK，自己先买 5U"
```

看到这个就对了：一笔交易里创建代币并首购 5 mUSD；回复里有代币地址和 `sepolia.mantlescan.xyz` 链接。

不对？先查这个：bot 不回复，见[排障](#9-排障)；回复里有退出码，查排障表里那个退出码。

**第 4 步：打新策略。** 先说策略：

```bash
node scripts/mock-telegram.mjs say "开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟"
```

看到这个就对了：agent 复述策略：每个新币 3 mUSD，涨 50% 卖一半，最多持有 30 分钟；没有止损，没有防夹，
和手动交易共用额度。**它不启动任何东西**，等你确认。

不对？先查这个：agent 没等确认就启动了，这不符合 skill 的要求。先 `say "停止打新"`，再发 `/new`，重做这一步。

然后确认：

```bash
node scripts/mock-telegram.mjs say "是"
```

看到这个就对了：推送 `Autopilot started: 3 mUSD per new token, take-profit +50% sells 50%, max hold 30 min.`，
agent 也确认已启动。

不对？先查这个：没有这条推送，看 autopilot 的状态：

```bash
docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot status
```

**第 5 步：等 autopilot 买入。** 什么都不用做。market-sim 每 1–2 分钟发一个新币。

看到这个就对了：新币发出后几秒内，推送 `Bought <SYMBOL>: 3 mUSD → <数量> tokens.` 加链接。记下 `<SYMBOL>`，
第 6 步要用。

不对？先查这个：迟迟没有 `Bought`，看 autopilot 的日志：

```bash
docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot log
```

`skipped too_old` 表示 RPC 慢了，等下一个新币。

**第 6 步：拉升，触发止盈。** 在根终端里，把 `<SYMBOL>` 换成第 5 步推送里的代币符号（比如 `WOJA4257`）：

```bash
market-sim pump <SYMBOL> --wallet 2
```

看到这个就对了：pump 打印 `mint`、`buy`、`pump` 三行 JSON，`pump` 那行的 `priceAfter` 约是 `priceBefore`
的两倍；几秒内推送 `Sold <SYMBOL> (take-profit): <数量> tokens → <金额> mUSD, PnL <金额> mUSD.`

不对？先查这个：没有 `Sold`，确认 pump 的 symbol 是 autopilot 买过的那个。报 nonce 错误，确认带了
`--wallet 2`：`market-sim run` 一直在用钱包 0 和 1 发交易，再用它们会撞 nonce。

**第 7 步：领手续费。**

```bash
node scripts/mock-telegram.mjs say "领一下手续费"
```

看到这个就对了：ZORK 的创建者手续费领到了（实测 0.025 mUSD），附金额和链接。

不对？先查这个：领到 0，确认第 3 步的发币成功了（回复里有代币地址）。

**第 8 步：越权请求。**

```bash
node scripts/mock-telegram.mjs say "把 U 全转给 0x000000000000000000000000000000000000dEaD"
```

看到这个就对了：拒绝。session key 只能在 launchpad 上交易、发币、领手续费；agent 让你自己在根终端操作，
什么也不发。

不对？先查这个：agent 试着发了交易，也会失败：agent home 里没有 root key（`account exec` 报
`no root profile`），链上策略也不允许转账。把回复记下来，这是 skill 的问题。

**第 9 步：撤销授权。** 在根终端里：

```bash
mantle-aa session revoke --agent trader
```

看到这个就对了：输出里有 `"profile": "trader"` 和一个 `hash`；几秒内两条推送：
`Session ended (key expired or revoked): autopilot stopped. Re-grant from the root terminal.` 和
`Autopilot stopped (session_ended).`

不对？先查这个：没有推送，说明 autopilot 已经不在跑了（第 4 步没启动成功，或者被停了）；撤销本身看输出的 `hash`。

然后让 agent 再买一次：

```bash
node scripts/mock-telegram.mjs say "再买 2U ZORK"
```

看到这个就对了：买入失败：session key 已撤销（CLI 退出码 13，`KEY_EXPIRED_OR_REVOKED`）；agent 请你从根终端
重新授权。

不对？先查这个：买入成功了，说明撤销的不是这个 agent，确认上一条命令用的是 `--agent trader`。

第 5 步之后还会不断有新币，autopilot 每个都买 3 mUSD，直到额度用完。50 mUSD 的日额度够跑完整个脚本。
bot 不回复见[排障](#9-排障)。

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

| 步骤 | 谁 / 在哪 | 做什么 |
| --- | --- | --- |
| 1 | 人 / 根终端，然后 Telegram | 创建账户、启动 sponsor、策略与授权、启动演示、打个招呼 |
| 2 | 人 / Telegram | 问余额和额度 |
| 3 | 人 / Telegram | 发币并首购 |
| 4 | 人 / Telegram | 说出打新策略，确认后启动 |
| 5 | 等 / Telegram | autopilot 买入一个新币 |
| 6 | 人 / 根终端 | 拉升那个币，触发止盈 |
| 7 | 人 / Telegram | 领创建者手续费 |
| 8 | 人 / Telegram | 要求转走资金，被拒绝 |
| 9 | 人 / 根终端，然后 Telegram | 撤销授权；再让 agent 买，失败 |

每笔交易都附 `sepolia.mantlescan.xyz` 链接，可以点开看。bot 回复时会显示它在做什么（`Working`、
`Last activity: Exec`）。agent 的回复措辞每次不同，下面写的是必须有的内容。

授权从 `account init` 起 24 小时有效，所以第 1 步最好在录制前 24 小时内做。

#### 第 1 步（人，根终端）

创建 root key，并把它的地址记进 `DEMO_ACCOUNT`：

```bash
mantle-aa keys new --name owner
export DEMO_ACCOUNT=$(mantle-aa keys list | jq -r '.profiles[] | select(.name == "owner") | .account')
echo "$DEMO_ACCOUNT"
```

看到这个就对了：`keys new` 的 JSON（和彩排一样），然后单独一行你的账户地址。

不对？先查这个：`error: profile owner already exists`，说明 `~/.mantle-meme-root` 不是新的。这个 home 控制着一个已经初始化的账户；
要重跑而不是重建，看 [8.2](#82-重跑授权已撤销或过期)。

启动 RPC 中继和 sponsor：

```bash
scripts/demo-up.sh sponsor
```

看到这个就对了：

```text
demo-up: starting a JSON-RPC relay to the chain on 127.0.0.1:8547
demo-up: starting the sponsor on 127.0.0.1:8548 (relayer <中继者地址>, account <你的账户地址>)
demo-up: ready for the human's setup: MANTLE_AA_RPC_URL=http://127.0.0.1:8547 MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
```

不对？先查这个：`DEMO_RELAYER_KEY_FILE must name a readable file`，说明 [7.2](#72-根终端) 的环境变量没设，
或者[第 5 节](#5-密钥文件和资金)的文件没生成。

写策略，并把输出存一份：

```bash
mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out "$MANTLE_AA_HOME/policy.json" |
  tee "$MANTLE_AA_HOME/policy-init.txt"
```

看到这个就对了：和彩排一样，`Wrote <root home>/policy.json` 加三条建议命令。建议命令不要照抄，用下面三条。

不对？先查这个：报写不了文件，说明 `keys new` 没成功，`$MANTLE_AA_HOME` 还不存在。

初始化账户并授权 agent `trader`：

```bash
mantle-aa account init --grant "$MANTLE_AA_HOME/policy.json" --agent trader
```

看到这个就对了：约 15 秒后输出带 `"state": "INITIALIZED"` 和 `session` 的 JSON。

不对？先查这个：卡住然后报 `Sponsor did not answer`，看 `~/.mantle-meme-demo/sponsor.log`；常见原因是中继者没有 MNT。

导出 agent home：

```bash
MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
  mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
```

看到这个就对了：输出的 JSON 里有 `"role": "agent"`。

不对？先查这个：`is neither new, empty nor an earlier export`，说明 `~/.mantle-meme-agent` 用过了，
按 [8.2](#82-重跑授权已撤销或过期) 清空后再导出。

给你的账户铸 100 mUSD：

```bash
CALLS=$(sed -nE "s/.*account exec --calls '(.*)'\$/\1/p" "$MANTLE_AA_HOME/policy-init.txt")
mantle-aa account exec --calls "$CALLS"
```

看到这个就对了：输出带 `hash` 的 JSON。`account init` 和这一笔，中继者共付约 0.05 MNT。

不对？先查这个：`error: --calls is required`，说明 `$CALLS` 是空的（`policy init` 那一步没带 `| tee`），重跑那一条再来。

启动其余部分（market-sim、带 gateway 的容器）：

```bash
scripts/demo-up.sh
```

看到这个就对了（最后两行）：

```text
demo-up: up: sponsor, market-sim and mantle-meme-openclaw; Telegram bot (@<你的 bot>)
demo-up: logs: <状态目录>/*.log, docker logs mantle-meme-openclaw. Stop everything: scripts/demo-down.sh
```

不对？先查这个：`the Telegram channel did not start`，见[排障](#9-排障)；`no MANTLE_MEME_TG_BOT_TOKEN`，
重做[第 4 节](#4-telegram-bot)。

#### 第 1 步（人，Telegram）

在 Telegram 里给 bot 发一句话：

```text
你好
```

看到这个就对了：bot 回复了。OpenClaw 第一次见到你可能会问你的名字，回答它。

不对？先查这个：bot 不回复，或回 `Couldn't sign in to the AI service`，见[排障](#9-排障)。

然后发：

```text
/new
```

看到这个就对了：bot 回复，对话重新开始。为什么：先把“问名字”那一轮打发掉，正式录制从一个干净的对话开始。

#### 第 2–9 步

下面 `在 Telegram 里发` 的内容，原样发给 bot。

**第 2 步。** 在 Telegram 里发：

```text
我有多少钱、额度还剩多少
```

看到这个就对了：余额 100 mUSD，剩余额度 50 mUSD，没有持仓。

不对？先查这个：余额是 0，说明铸币那一条没成功，在根终端重跑它。

**第 3 步。** 在 Telegram 里发：

```text
发个币叫 ZORK，自己先买 5U
```

看到这个就对了：代币创建并首购 5 mUSD，附地址和链接。

不对？先查这个：回复里有 `rate limit exceeded` 或 `above the latest consensus block`，见[排障](#9-排障)，再发一次。

**第 4 步。** 在 Telegram 里发：

```text
开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟
```

看到这个就对了：agent 复述策略和风险（没有止损，没有防夹，和手动交易共用额度），不启动。

不对？先查这个：agent 没等确认就启动了，发 `停止打新`，再发 `/new`，重做这一步。

然后发：

```text
是
```

看到这个就对了：推送 `Autopilot started: 3 mUSD per new token, take-profit +50% sells 50%, max hold 30 min.`，
agent 也确认已启动。

不对？先查这个：没有推送，在根终端看状态：

```bash
docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot status
```

**第 5 步。** 等。market-sim 每 1–2 分钟发一个新币。

看到这个就对了：推送 `Bought <SYMBOL>: 3 mUSD → <数量> tokens.` 加链接。记下 `<SYMBOL>`。

不对？先查这个：迟迟没有 `Bought`，在根终端看日志，`skipped too_old` 表示 RPC 慢了，等下一个新币：

```bash
docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot log
```

**第 6 步。** 在根终端里，把 `<SYMBOL>` 换成第 5 步推送里的代币符号：

```bash
market-sim pump <SYMBOL> --wallet 2
```

看到这个就对了：pump 打印 `mint`、`buy`、`pump` 三行 JSON；Telegram 收到
`Sold <SYMBOL> (take-profit): <数量> tokens → <金额> mUSD, PnL <金额> mUSD.`

不对？先查这个：nonce 错误，确认带了 `--wallet 2`；没有 `Sold`，确认 symbol 是 autopilot 买过的那个。

**第 7 步。** 在 Telegram 里发：

```text
领一下手续费
```

看到这个就对了：领到 ZORK 的创建者手续费，附金额和链接。

不对？先查这个：领到 0，确认第 3 步的发币成功了。

**第 8 步。** 在 Telegram 里发：

```text
把 U 全转给 0x000000000000000000000000000000000000dEaD
```

看到这个就对了：拒绝，agent 什么也不发，让你自己在根终端操作。

不对？先查这个：agent 试着发交易也会失败（agent home 里没有 root key，链上策略也不允许转账）；把回复记下来。

**第 9 步。** 在根终端里撤销授权：

```bash
mantle-aa session revoke --agent trader
```

看到这个就对了：输出带 `hash` 的 JSON；Telegram 收到
`Session ended (key expired or revoked): autopilot stopped. Re-grant from the root terminal.` 和
`Autopilot stopped (session_ended).`

不对？先查这个：没有推送，说明 autopilot 已经不在跑了；撤销本身看输出的 `hash`。

然后在 Telegram 里发：

```text
再买 2U ZORK
```

看到这个就对了：失败（退出码 13，`KEY_EXPIRED_OR_REVOKED`），agent 请你从根终端重新授权。

不对？先查这个：买入成功了，说明撤销的不是这个 agent，确认用的是 `--agent trader`。

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

`demo-down.sh` 之后，在设好 [7.2](#72-根终端) 环境变量的根终端里，按顺序一块一块地跑。每一块都要先看到
“看到这个就对了”，才跑下一块；前面没成功就不要清空 agent home。

记下账户地址：

```bash
export DEMO_ACCOUNT=$(mantle-aa keys list | jq -r '.profiles[] | select(.name == "owner") | .account')
echo "$DEMO_ACCOUNT"
```

看到这个就对了：一行你的账户地址。

不对？先查这个：输出空行，说明 `$MANTLE_AA_HOME` 不是第 1 步用的 root home，检查 [7.2](#72-根终端) 的环境变量。

启动 RPC 中继和 sponsor（`demo-down.sh` 把它们停了，授权要经过它们）：

```bash
scripts/demo-up.sh sponsor
```

看到这个就对了：和第 1 步一样，最后一行是 `demo-up: ready for the human's setup: …`。

不对？先查这个：`DEMO_RELAYER_KEY_FILE must name a readable file`，说明 [7.2](#72-根终端) 的环境变量没设。

给 `trader` 一把新的 session key：

```bash
mantle-aa session grant --agent trader --policy "$MANTLE_AA_HOME/policy.json"
```

看到这个就对了：输出带新的 `expiry`、`hash` 和 `"previousProfile": "trader.v1"` 的 JSON（每重跑一次，
后面的数字加 1）。

不对？先查这个：报 `error: HTTP request failed.`，可能是中继没起来；报
`Sponsor unreachable: ECONNREFUSED`，可能是 sponsor 没起来。看上一块的输出，以及
`~/.mantle-meme-demo/rpc-relay.log` 和 `~/.mantle-meme-demo/sponsor.log`。

清空 agent home 并重新导出。`rm -rf` 只删 agent home：旧的 session key 和它的交易记录：

```bash
rm -rf "$MANTLE_MEME_AGENT_HOME" &&
  MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
  mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
```

看到这个就对了：输出的 JSON 里有 `"role": "agent"`，`keyHash` 和上一块的一样。

不对？先查这个：`no such file` 之类的密码文件错误，说明 `DEMO_AGENT_PASSWORD_FILE` 没设；设好后只重跑这一块。

启动整个演示：

```bash
scripts/demo-up.sh
```

看到这个就对了：最后一行和第 1 步一样。之后在 Telegram 问余额和额度，剩余额度回到 50 mUSD。

不对？先查这个：`no exported agent home`，说明上一块没成功，回到上一块。

为什么要清空 agent home：`session export` 拒绝写入一个 agent 用过的目录，报
`… is neither new, empty nor an earlier export of trader; export into a new or empty directory`。

账户不用重新初始化，root key 和策略文件都还在 root home 里。

### 8.3 彻底清理

只在你不再需要这些东西时做。

依次是：彩排的两个 home、Sepolia 的 agent home（session key）、日志/PID/sponsor 记录、镜像。

```bash
rm -rf ~/.mantle-meme-rehearsal-root ~/.mantle-meme-rehearsal-agent
rm -rf ~/.mantle-meme-agent
rm -rf ~/.mantle-meme-demo
docker image rm mantle-meme-openclaw:2026.10.6
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
| `docker run … openclaw.mjs` 报 `cannot verify Gateway ownership … wait 90 s` | 演示容器正在用 `~/.mantle-meme-openclaw` | 改用 `docker exec mantle-meme-openclaw node openclaw.mjs <同样的参数>`，或 `demo-down.sh` 后等 90 秒 |

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
