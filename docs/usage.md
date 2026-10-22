# Usage

How to install the launchpad's tools, set up an account for an agent (DESIGN §8.1) and what the
agent can do. The recorded Telegram demo is [demo.md](demo.md).

> Proof of concept on Mantle Sepolia. **The contracts are not audited.** Testnet amounts only.

## Install

Node 24, pnpm (via corepack) and, for the contracts and the fork rehearsal, Foundry.

```bash
git clone https://github.com/Whisker17/agentic-meme-lauchpad-poc.git
cd agentic-meme-lauchpad-poc
pnpm install && pnpm build
```

`mantle-meme` and `market-sim` are not published yet; run them from the checkout. `mantle-aa` is
the published `@0xwh1sker/mantle-aa-cli` the CLI depends on. In the repository root:

```bash
alias mantle-aa="$PWD/packages/cli/node_modules/.bin/mantle-aa"
alias mantle-meme="node $PWD/packages/cli/dist/bin/mantle-meme.js"
alias market-sim="node $PWD/tools/market-sim/dist/bin.js"
```

The settings of all three are environment variables:
[packages/cli/README.md](../packages/cli/README.md) "Settings" and
[tools/market-sim/README.md](../tools/market-sim/README.md) "Setup".

## Human setup (DESIGN §8.1)

The human keeps the root key in a **root home**, in a terminal of their own. The agent gets an
**agent home** that holds only its session key, with a different password. The account is the
root key's address (EIP-7702 upgrades it in place); it and the agent hold 0 MNT, and a sponsor
pays the gas.

In the root terminal:

```bash
export MANTLE_AA_HOME=~/.mantle-meme-root                 # the root home
export MANTLE_AA_KEYSTORE_PASSWORD=…                      # the root home's password
export MANTLE_AA_RPC_URL=https://rpc.sepolia.mantle.xyz    # standalone use; the demo: below
export MANTLE_AA_SPONSOR_URL=http://127.0.0.1:8548        # a running `mantle-aa sponsor serve`

mantle-aa keys new --name owner                           # once: the root key, the account
mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out policy.json
mantle-aa account init --grant policy.json --agent trader
MANTLE_AA_EXPORT_PASSWORD=… mantle-aa session export --agent trader --out ~/.mantle-meme-agent
mantle-aa account exec --calls '<the MockUSD mint that policy init printed>'
```

- The RPC: the public `https://rpc.sepolia.mantle.xyz` serves single CLI commands. For the demo on
  Mantle Sepolia, set `MANTLE_AA_RPC_URL=http://127.0.0.1:8547` instead, the local relay that
  `scripts/demo-up.sh sponsor` starts, and run that right after `keys new` (it needs the account),
  before `policy init` and every command after it: the public RPC refuses bursts of calls
  ("rate limit exceeded"), and the relay sends at most 4 at a time and retries the refused ones.
  The fork rehearsal uses the fork, `http://127.0.0.1:8545`. Both: [demo.md](demo.md)
  "The root terminal".
- `policy init` writes the policy (a MockUSD limit, the launchpad as the only spender) and prints
  the next three commands with the exact mint calldata for your account.
- The grant expires 24 hours after `account init --grant` (`--expiry 24h` is the only value).
  After that, or after a revoke, grant again with
  `mantle-aa session grant --agent trader --policy policy.json` and export again.
- Revoke: `mantle-aa session revoke --agent trader`. The agent's next send is exit 13, and a
  running autopilot stops.

Details: [packages/cli/README.md](../packages/cli/README.md) "Human setup". The sponsor:
`scripts/demo-up.sh sponsor` starts one for an account ([demo.md](demo.md) step 1), or see the
[sponsor's usage](https://github.com/Whisker17/mantle-7702-sdk/blob/main/docs/usage.md#running-a-sponsor).

## The agent

The agent runs with the agent home only:

```bash
export MANTLE_AA_HOME=~/.mantle-meme-agent
export MANTLE_AA_KEYSTORE_PASSWORD=…                      # the export password
export MANTLE_AA_RPC_URL=… MANTLE_AA_SPONSOR_URL=…
```

| What | Command |
| --- | --- |
| Balance, remaining limit, positions | `mantle-meme portfolio --json` |
| Launch a token, with a first buy | `mantle-meme create --name <n> --symbol <s> --dev-buy <mUSD> --json` |
| Trade | `mantle-meme buy <token> --amount <mUSD> --json`, `mantle-meme sell <token> --percent 50 --json` |
| Look before trading | `mantle-meme quote`, `list`, `info` |
| Creator fees | `mantle-meme claim --all --json` |
| Sniping | `mantle-meme autopilot start --strategy strategy.json`, `stop`, `status`, `log` |

Every command, its JSON result and the exit codes (11 over the limit, 13 key revoked or expired,
44 autopilot already running, …): [packages/cli/README.md](../packages/cli/README.md). With
`MANTLE_MEME_TG_BOT_TOKEN` and `MANTLE_MEME_TG_CHAT_ID` set, the autopilot pushes its trades to
Telegram.

## The agent in OpenClaw

The [mantle-meme skill](../skills/mantle-meme/SKILL.md) teaches an OpenClaw agent these commands
and its rules (quote first, restate a strategy and wait for a "yes", never move funds or ask for a
root key). OpenClaw runs in a container; install, model login and one-off turns:
[skills/mantle-meme/README.md](../skills/mantle-meme/README.md). With Telegram, as in the demo:
[demo.md](demo.md).

## Market simulator

`market-sim` gives the autopilot launches to snipe and prices that move, from plain EOAs that pay
their own gas: [tools/market-sim/README.md](../tools/market-sim/README.md).
