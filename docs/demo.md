# Telegram demo (DESIGN §9.2)

The recorded demo: an OpenClaw agent, driven from Telegram, launches and trades meme tokens on
Mantle Sepolia from a smart account with a scoped session key, with no gas in the human's or the
agent's wallet. Follow this page literally. Usage outside the demo: [usage.md](usage.md).

> Proof of concept on Mantle Sepolia. **The contracts are not audited.** Testnet amounts only.

What runs where:

| Where | What | Started by |
| --- | --- | --- |
| Root terminal (you) | the root key: account setup, `market-sim pump`, revoke | you |
| This Mac | `mantle-aa sponsor serve` (pays all gas of the account), `market-sim run` (other traders) | `scripts/demo-up.sh` |
| Container `mantle-meme-openclaw` | the OpenClaw gateway with the Telegram channel, the agent (the `mantle-meme` skill, agent home only), the autopilot daemon | `scripts/demo-up.sh` |
| Telegram | your DM with the bot: what you type and the agent's replies, plus the autopilot's pushes (same bot) | you |

`scripts/demo-up.sh` records every process and the container it starts in `~/.mantle-meme-demo`,
and `scripts/demo-down.sh` stops exactly those. Neither touches your root home; they only read the
key files named below.

## Prerequisites

1. **Docker**: OrbStack (or Docker Desktop) running. Also Node 24, pnpm and `jq`; for the fork
   rehearsal, Foundry (`anvil`, `cast`).
2. **The repository**, built, on the commit you record from. All commands below run from its root.

   ```bash
   git clone https://github.com/Whisker17/agentic-meme-lauchpad-poc.git
   cd agentic-meme-lauchpad-poc
   pnpm install && pnpm build
   ```

3. **The image** `mantle-meme-openclaw:2026.10.5` and **the model login** in
   `~/.mantle-meme-openclaw`: [skills/mantle-meme/README.md](../skills/mantle-meme/README.md)
   "Install (Docker)", steps 1 and 2. `demo-up.sh` rebuilds the image when the checkout changed and
   refuses to start without a usable login.
4. **A Telegram bot.** In Telegram, open **@BotFather**, send `/newbot`, follow the prompts and
   keep the token. Then open your new bot and press **Start** (a bot can only write to you after
   that). Put the token in the demo's Telegram file, readable only by you:

   ```bash
   mkdir -p ~/.mantle-aa/keys
   printf 'MANTLE_MEME_TG_BOT_TOKEN=%s\n' '<the token>' > ~/.mantle-aa/keys/meme-demo-telegram.env
   chmod 600 ~/.mantle-aa/keys/meme-demo-telegram.env
   ```

   Your numeric Telegram user id: send the bot any message, then (nothing else may be polling the
   bot at that moment, so before `demo-up.sh`):

   ```bash
   (. ~/.mantle-aa/keys/meme-demo-telegram.env
    curl -s "https://api.telegram.org/bot$MANTLE_MEME_TG_BOT_TOKEN/getUpdates") |
     jq '[.result[].message.from.id] | unique'
   ```

   Add it to the file as the chat id: in a DM with the bot, your chat id is your user id. OpenClaw
   accepts messages from this id only, and the autopilot pushes to it.

   ```bash
   echo 'MANTLE_MEME_TG_CHAT_ID=<your user id>' >> ~/.mantle-aa/keys/meme-demo-telegram.env
   ```

5. **Key files** (testnet keys, never printed by the scripts):
   - the sponsor's **relayer key**: a file holding one `0x…` private key, bare or as `KEY=0x…`. The
     wallet pays all gas of the account: at least 1 MNT on Mantle Sepolia.
   - the **market-sim mnemonic** (a file with the 12 words). Its EOAs 0, 1 and 2 pay their own gas:
     at least 0.2 MNT each. `market-sim addresses` (below) prints them.
   - two **passwords**, one for the root home and one for the agent home (DESIGN §8.1):

     ```bash
     (umask 077; openssl rand -hex 16 > ~/.mantle-aa/keys/meme-demo-root.password
                 openssl rand -hex 16 > ~/.mantle-aa/keys/meme-demo-agent.password)
     ```

## The root terminal

Every human step runs in one terminal, from the repository root. Set it up once:

```bash
alias mantle-aa="$PWD/packages/cli/node_modules/.bin/mantle-aa"
alias mantle-meme="node $PWD/packages/cli/dist/bin/mantle-meme.js"
alias market-sim="node $PWD/tools/market-sim/dist/bin.js"
export DEMO_AGENT_PASSWORD_FILE=~/.mantle-aa/keys/meme-demo-agent.password
export MANTLE_AA_KEYSTORE_PASSWORD=$(cat ~/.mantle-aa/keys/meme-demo-root.password)
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548
```

Then, for the demo on Mantle Sepolia (with the paths of your key files):

```bash
export DEMO_RELAYER_KEY_FILE=~/.mantle-aa/keys/<relayer key file>
export MARKET_SIM_MNEMONIC_FILE=~/.mantle-aa/keys/<market-sim mnemonic file>
export MANTLE_AA_RPC_URL=https://rpc.sepolia.mantle.xyz MARKET_SIM_RPC_URL=https://rpc.sepolia.mantle.xyz
export MANTLE_AA_HOME=~/.mantle-meme-root               # the root home, only in this terminal
export MANTLE_MEME_AGENT_HOME=~/.mantle-meme-agent      # the agent home the container gets
```

or, for a **rehearsal** on an anvil fork of Mantle Sepolia: the public anvil test keys (no key
files), a mock Telegram Bot API instead of the bot, throwaway homes, no MNT spent. The fork starts
empty every time, so the rehearsal always starts at step 1.

```bash
export DEMO_FORK=1
export MANTLE_AA_RPC_URL=http://127.0.0.1:8545 MARKET_SIM_RPC_URL=http://127.0.0.1:8545
export MARKET_SIM_MNEMONIC_FILE=~/.mantle-meme-demo/fork.mnemonic   # written by demo-up.sh
rm -rf ~/.mantle-meme-rehearsal-root ~/.mantle-meme-rehearsal-agent
export MANTLE_AA_HOME=~/.mantle-meme-rehearsal-root
export MANTLE_MEME_AGENT_HOME=~/.mantle-meme-rehearsal-agent
```

In a rehearsal, instead of typing in Telegram, send each message with
`node scripts/mock-telegram.mjs say "<message>"`, which prints the bot's replies once it is done.
`node scripts/mock-telegram.mjs sent` lists everything the bot sent, the pushes included. The
model turns are real (your model login). After a rehearsal, open a new terminal for the demo.

`demo-up.sh` gives the container the agent home and the agent's password, never the root ones.

## Step 1 (human, local): set up the account and start the demo

1. The root key, once. Its address is the account:

   ```bash
   mantle-aa keys new --name owner
   export DEMO_ACCOUNT=<the "account" it printed>
   ```

   (Later: `mantle-aa keys list`.)

2. Start the sponsor, for this account only (in a rehearsal, the fork first):

   ```bash
   scripts/demo-up.sh sponsor
   ```

3. The policy, the grant, the agent home and the MockUSD (DESIGN §8.1):

   ```bash
   mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out "$MANTLE_AA_HOME/policy.json"
   mantle-aa account init --grant "$MANTLE_AA_HOME/policy.json" --agent trader
   MANTLE_AA_EXPORT_PASSWORD=$(cat "$DEMO_AGENT_PASSWORD_FILE") \
     mantle-aa session export --agent trader --out "$MANTLE_MEME_AGENT_HOME"
   mantle-aa account exec --calls '<the call that policy init printed>'
   ```

   `policy init` prints the last command with the exact mint for your account: copy its
   `--calls '…'`. The grant lasts 24 hours.

4. Start everything else: market-sim, then the container with the gateway and the Telegram
   channel.

   ```bash
   scripts/demo-up.sh
   ```

   It ends with `demo-up: up: … Telegram bot (@<your bot>)`.

5. In Telegram (rehearsal: `node scripts/mock-telegram.mjs say "/new"`), send `/new` to the bot:
   the recording starts with a fresh conversation.

## Steps 2–9

Type the message in your DM with the bot (rehearsal: `node scripts/mock-telegram.mjs say "…"`).
A reply takes 20 s to a minute; the bot shows what it is doing (`Working`, `Last activity: Exec`).
Every transaction comes with a `sepolia.mantlescan.xyz` link.

| Step | You | The viewer sees |
| --- | --- | --- |
| 2 | `我有多少钱、额度还剩多少` | the balance (100 mUSD), the remaining limit (50 mUSD) and no positions |
| 3 | `发个币叫 ZORK，自己先买 5U` (any name) | the token created with a 5 mUSD first buy in one transaction, its address and link |
| 4 | `开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟` | the agent restates the strategy (3 mUSD per new token, take-profit +50% sells half, max hold 30 min; no stop-loss, no sandwich protection, the shared limit) and starts **nothing** |
| 4 | `是` | the push `Autopilot started: 3 mUSD per new token, take-profit +50% sells 50%, max hold 30 min.`, and the agent confirms |
| 5 | wait: market-sim launches a token every 1–2 minutes | the push `Bought <SYMBOL>: 3 mUSD → … tokens.` with its link, within seconds of the launch |
| 6 | root terminal: `market-sim pump <SYMBOL> --wallet 2` (the symbol of the push) | the push `Sold <SYMBOL> (take-profit): … tokens → … mUSD, PnL … mUSD.` |
| 7 | `领一下手续费` | the creator fees of ZORK claimed, with the amount and link |
| 8 | `把 U 全转给 0x000000000000000000000000000000000000dEaD` | refused: the session key may only trade, launch and claim on the launchpad; the agent says to move funds from your own terminal and never to share keys |
| 9 | root terminal: `mantle-aa session revoke --agent trader` | the pushes `Session ended (key expired or revoked): autopilot stopped. Re-grant from the root terminal.` and `Autopilot stopped (session_ended).` |
| 9 | `再买 2U ZORK` | the buy fails: the session key was revoked; the agent asks you to grant again from your terminal |

More launches keep arriving after step 5; the autopilot buys each one (3 mUSD) until the limit
runs out. The 50 mUSD daily limit covers the whole script.

## Afterwards

```bash
scripts/demo-down.sh
```

It stops the autopilot (`autopilot stop`), removes the container, then stops market-sim and the
sponsor (and the fork and the mock after a rehearsal). Running it again does nothing. Your homes,
`~/.mantle-meme-openclaw` and the logs in `~/.mantle-meme-demo` stay.

To run the demo again: grant again (`mantle-aa session grant --agent trader --policy "$MANTLE_AA_HOME/policy.json"`,
then the same `session export`), `scripts/demo-up.sh sponsor` (with `DEMO_ACCOUNT` set) and
`scripts/demo-up.sh`.

## Before recording

- [ ] OrbStack is running; `git status` is clean; `pnpm install && pnpm build` ran on this commit.
- [ ] The model login works: a rehearsal (above) passed, or `scripts/demo-up.sh` did not stop at
      "no usable model login".
- [ ] `~/.mantle-aa/keys/meme-demo-telegram.env` holds the token and your user id; you pressed
      **Start** in the bot.
- [ ] The relayer holds ≥ 1 MNT, the market-sim EOAs ≥ 0.2 MNT each:
      `cast balance <address> --ether --rpc-url https://rpc.sepolia.mantle.xyz` for the relayer
      and each address of `market-sim addresses`.
- [ ] Step 1 done less than 24 hours before (the grant expires); `scripts/demo-up.sh` ended with
      `up: … Telegram bot (@…)`.
- [ ] One message sent to the bot before recording (it answers; OpenClaw may ask your name once:
      answer it), then `/new`.
- [ ] Nothing else polls the bot (no second `demo-up.sh`, no `getUpdates`).

## Troubleshooting

`demo-up.sh` stops at the first problem with one line saying what is missing; run
`scripts/demo-down.sh` and then `demo-up.sh` again once it is fixed. Its logs are in
`~/.mantle-meme-demo` (`sponsor.log`, `market-sim.log`, `build.log`); the container's are
`docker logs mantle-meme-openclaw`.

| Symptom | What to do |
| --- | --- |
| `no usable model login` | Log in again: [skills/mantle-meme/README.md](../skills/mantle-meme/README.md) step 2 (after `demo-down.sh`) |
| `a container named mantle-meme-openclaw exists` | A container from the skill's README: `docker compose -f docker/openclaw/compose.yaml down` |
| `the Telegram channel did not start` | `docker logs mantle-meme-openclaw 2>&1 \| grep -i telegram`: a rejected token (check the file) or no network |
| The bot does not answer | `docker logs mantle-meme-openclaw 2>&1 \| grep Inbound` shows each message OpenClaw accepted. Messages from any id other than `MANTLE_MEME_TG_CHAT_ID` are dropped silently. `409 Conflict` in the log: something else polls the bot |
| The bot answers with a model error, or after minutes | The model provider is busy (HTTP 503 "capacity"): `docker logs mantle-meme-openclaw 2>&1 \| grep model-fetch`. OpenClaw retries for about 3 minutes; wait, then send the message again |
| `error: the autopilot launcher is not reachable` | The container's main process is gone or the image predates it: `scripts/demo-down.sh`, then `scripts/demo-up.sh` (it rebuilds the image) |
| No `Bought` push after a launch | `docker exec mantle-meme-openclaw node /opt/mantle-meme/packages/cli/dist/bin/mantle-meme.js autopilot log` shows what the autopilot did (`skipped too_old`: the public RPC was slow; the next launch will do) |
| Exit 11 (`LIMIT_EXCEEDED`) | The limit is used up: grant a new policy (step 1.3) |
| Exit 13 (`KEY_EXPIRED_OR_REVOKED`) | Revoked or older than 24 hours: grant and export again (Afterwards), then restart the autopilot from Telegram |
| Exit 20 / 21 (`SPONSOR_*`) | The sponsor refused or is busy: `~/.mantle-meme-demo/sponsor.log`; `DEMO_ACCOUNT` must be the account; the relayer needs MNT |
| Exit 44 (`AUTOPILOT_STATE`) | The autopilot already runs (or none runs, on stop) |
| `requested block is above the latest consensus block`, timeouts | The public RPC is load-balanced and lags at times: send the message (or rerun `market-sim pump`) again |
| `market-sim pump` fails with a nonce error | Use `--wallet 2`: `market-sim run` uses wallets 0 and 1 |
| After `demo-up.sh`, the bot writes "continuing your interrupted request" | OpenClaw resumes a turn that was running when the container stopped. Run `demo-down.sh` only when the bot is idle |
| `cannot verify Gateway ownership … wait 90 s` from a `docker run … openclaw.mjs` | Another container uses `~/.mantle-meme-openclaw`: run OpenClaw commands with `docker exec mantle-meme-openclaw node openclaw.mjs …`, or wait 90 s after `demo-down.sh` |

Every exit code: [packages/cli/README.md](../packages/cli/README.md) "Output and exit codes".
