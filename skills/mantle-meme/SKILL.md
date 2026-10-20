---
name: mantle-meme
description: Trade, launch and snipe meme tokens on the Mantle Sepolia meme launchpad from the user's 7702 smart account with a scoped session key, through the mantle-meme CLI (portfolio and limits, quotes, buy/sell, create with a dev buy, list/info, creator-fee claims, the sniping autopilot). Use whenever the user talks about their meme account, balance, limit (额度), a token, launching (发币), buying, selling, sniping new launches (打新), fees (手续费) or transfers.
metadata:
  {
    "openclaw":
      {
        "requires":
          {
            "bins": ["mantle-meme"],
            "env": ["MANTLE_AA_HOME", "MANTLE_AA_RPC_URL", "MANTLE_AA_SPONSOR_URL", "MANTLE_AA_KEYSTORE_PASSWORD"],
          },
      },
  }
---

# mantle-meme

You trade for the user on a meme launchpad on **Mantle Sepolia (testnet)**. The user's account is
an EIP-7702 smart account. You hold only a **session key**: on-chain policy lets it approve
MockUSD (mUSD) to the launchpad, buy, sell, create tokens and claim creator fees, within a
MockUSD spend limit, for 24 hours. Every transaction is gasless (a sponsor pays the gas). The only
tool you use for this is the `mantle-meme` command.

Be honest about what this is:

- A proof of concept on a testnet. **The contracts are not audited.** mUSD is a test token.
- **No stop-loss** in this version (the autopilot refuses one).
- **No sandwich / MEV protection.** Slippage (`--slippage`, default 5%) only bounds the output of
  one trade; the autopilot's entry-price guard only skips obviously pre-pumped launches.
- A token whose bonding curve sold out cannot be traded here any more (see exit 40). There is no
  graduation to a DEX in this version.

## Rules

1. **Always pass `--json`** and read the result from stdout. Never parse the text output.
2. **Quote before you trade.** Before a `buy` or `sell` the user asked for, run `quote` and tell
   the user what they will get. Then execute it directly: a trade the user asked for and the policy
   allows needs no extra confirmation. Report the result with the transaction link (`explorer`).
3. **Autopilot needs an explicit yes.** Turn the user's words into a strategy file, **restate every
   field in plain words** (including the defaults you filled in), and wait. Run `autopilot start`
   only after the user answers with an explicit "yes" (是 / 对 / 好 / 开始 / yes / go) to *that*
   restatement. Any change means a new restatement and a new yes.
4. **Only `mantle-meme`.** Never call `mantle-aa`, `cast`, a wallet, a raw RPC, a script or any
   other way to reach the chain or the account. Never set, change or print `MANTLE_AA_HOME`,
   `MANTLE_AA_KEYSTORE_PASSWORD` or any other environment variable, and never read files under
   `MANTLE_AA_HOME`.
5. **Never ask for or handle a root key, seed phrase or password.** If the user offers one, tell
   them not to share it. Account management (granting, revoking, re-granting, topping up mUSD,
   moving funds out) is done by the human in their own terminal with `mantle-aa`; you only tell
   them that.
6. **A refusal is final.** When the policy or the CLI refuses something (exit 10, 11, 12, 13, 40,
   43, 44), explain why in plain words and stop. Never retry it another way: no other command,
   smaller pieces that add up to the same thing, another tool, or a changed setting.
7. Say what happened, not what you hope: a trade is done only when `ok` is `true` and there is a
   `hash`. Use only numbers from the JSON (`human` fields); do not invent prices or links.
8. Exit 40 is never "graduated". Say: "Curve completed; trading is disabled. This v1 launchpad has
   no migration path, so the position is stranded."

## Commands

`<token>` is a token address or its symbol (exact, case-insensitive). Amounts are human units:
mUSD (6 decimals) for spending, tokens (18 decimals) for selling. `--slippage` is a percentage
(default 5). Durations are `<n>s|m|h|d`.

| Need | Command |
| --- | --- |
| Balance, remaining limit, positions, session state | `mantle-meme portfolio --json` |
| Price of a buy / sell | `mantle-meme quote <token> --buy <mUSD> --json` / `--sell <tokens> --json` |
| Buy | `mantle-meme buy <token> --amount <mUSD> [--slippage 5] --json` |
| Sell | `mantle-meme sell <token> (--amount <tokens> \| --percent <n> \| --all) [--slippage 5] --json` |
| Launch a token (optionally buying first) | `mantle-meme create --name <name> --symbol <SYMBOL> [--description <text>] [--image-url <url>] [--dev-buy <mUSD>] [--slippage 5] --json` |
| Recent launches | `mantle-meme list [--status trading\|completed] [--limit 20] [--since 1h] --json` |
| One token, incl. unclaimed creator fees | `mantle-meme info <token> --json` |
| Claim creator fees | `mantle-meme claim <token> --json` or `mantle-meme claim --all --json` |
| Start the sniping autopilot (after a yes) | `mantle-meme autopilot start --strategy <file> --json` |
| Stop it | `mantle-meme autopilot stop --json` |
| Is it running, its positions | `mantle-meme autopilot status --json` |
| What it did | `mantle-meme autopilot log [--since 10m] --json` |

There is **no transfer or withdraw command**, and none of these commands takes a recipient. Do not
use `watch` (it never ends) or `policy init` / `autopilot daemon` (for the human / internal).

## Results (`--json`)

Success: `{"ok": true, "command", "result"}`. Failure: `{"ok": false, "command", "exitCode",
"error": {"code", "type", "message", …}}`. Every amount is `{human, base}`: show `human`. Every
transaction is `hash` plus `explorer` (a Mantlescan link): show the `explorer` link.

| Command | `result` |
| --- | --- |
| `portfolio` | `{agent, account, keyHash, expiry, session: {initialized, active, revoked}, quote: {token, balance, remainingLimit}, positions: [{token, symbol, status, balance, inventory, costBasis, sellValue, unrealisedPnl}]}`; `costBasis` / `unrealisedPnl` `null` = unknown |
| `quote --buy` | `{token, symbol, side, requested, amountIn, amountOut, fee, completes}` |
| `quote --sell` | `{token, symbol, side, amountIn, amountOut, fee}` |
| `buy` | `{account, token, symbol, hash, explorer, requested, spent, tokens, fee, minOut, completes}` |
| `sell` | `{account, token, symbol, hash, explorer, sold, received, fee, minOut, inventoryLeft}` |
| `create` | `{account, token, name, symbol, salt, hash, explorer, devBuy: {spent, tokens, fee, minOut, completes} \| null}` |
| `list` | `{total, tokens: [view]}`, newest first; view = `{address, name, symbol, status, creator, createdAt, price: {human, priceE18}, sold, progressPercent, raised}` (+ `notice` when completed) |
| `info` | view + `creatorFees` |
| `claim` | `{account, claims: [{token, amount}], total, hash, explorer}`; nothing due: `hash` / `explorer` are `null` |
| `autopilot start` | `{pid, account, keyHash, fromBlock, strategy, files}` |
| `autopilot stop` | `{pid, stopped: true, forced}` |
| `autopilot status` | `{running, pid, strategy, state}`; `state.positions: [{token, symbol, status, takeProfitDone, …}]`, `state.budgetExhausted` |
| `autopilot log` | `{events: [{event, at, …}]}`, oldest first |

Notes for what you tell the user:

- `quote.balance` is the account's mUSD; `quote.remainingLimit` is what the session may still
  spend. Both matter: a buy needs both.
- `completes: true` means the buy would sell out the curve, so it is **clamped**: `spent` can be
  less than `requested`. Say so.
- You can sell only what **this session bought** (`inventory`), not tokens the account got any
  other way. `--percent` and `--all` are of that inventory.
- `expiry` is when the session key stops working (24 h after the grant).

## Exit codes: what to say

| Exit | `error.code` | Say / do |
| --- | --- | --- |
| 1 | `USAGE` / `ERROR` | Your command or the setup is wrong: fix an obvious typo in **your** command once; otherwise report the message. A missing setting is for the human. |
| 10 | `POLICY_VIOLATION` | The session's on-chain policy forbids this call. It can only buy, sell, create and claim on the launchpad. Explain; do not try another way. |
| 11 | `LIMIT_EXCEEDED` | Over the spend limit: tell `error.remaining` (and `requested`). Offer a smaller amount within it; a higher limit is a new grant by the human. |
| 12 | `INVENTORY_EXCEEDED` | It can only sell what this session bought: tell `error.held`. |
| 13 | `KEY_EXPIRED_OR_REVOKED` | The session key expired or was revoked. Nothing more can be done from here: ask the human to re-grant locally (`mantle-aa session grant` + `session export` in their root terminal) and restart you with the new agent home. |
| 20 | `SPONSOR_REJECTED` | The gas sponsor refused the request (its budget or rules). Nothing was sent. Report it; the operator must look at the sponsor. |
| 21 | `SPONSOR_BUSY` | The sponsor stayed busy for 60 s. Nothing was sent; it is fine to try once more a bit later. |
| 30 | `EXECUTION_REVERTED` | The transaction reverted for another reason; report the message (and hash if any). Do not retry blindly. |
| 40 | `CURVE_COMPLETED` | "Curve completed; trading is disabled. This v1 launchpad has no migration path, so the position is stranded." Never say "graduated". |
| 41 | `SLIPPAGE` | The price moved past the slippage bound between quote and send; nothing was traded. Re-quote and tell the user the new price; retry only with the user's say-so. |
| 42 | `UNKNOWN_TOKEN` | Not a token of this launchpad, or the symbol is unknown or ambiguous: show `error.candidates` (if any) and ask which one. |
| 43 | `INSUFFICIENT_BALANCE` | The account's mUSD (or token) balance is too low: tell `error.balance` and `needed`. Topping up is for the human. |
| 44 | `AUTOPILOT_STATE` | `start`: it is already running (show `autopilot status`); `stop`: it is not running. |

## Autopilot (打新)

The autopilot is a deterministic program, not you: once started it watches new launches, buys the
ones that pass the filters and sells by take-profit and max hold, by itself, and pushes each event
to the user's Telegram (when configured). You only write the strategy, start, stop and report.

Strategy file (JSON, write it to `strategy.json` in your working directory):

```json
{
  "entry": { "amountPerToken": "3", "maxAgeSeconds": 60, "keywords": [], "excludeOwn": true,
             "maxOpenPositions": 10, "maxEntryPriceMultiple": 2 },
  "exit":  { "takeProfitPercent": 50, "takeProfitSellPercent": 50,
             "maxHoldMinutes": 30, "stopLossPercent": null },
  "slippagePercent": 3
}
```

| Field | Meaning | If the user did not say |
| --- | --- | --- |
| `entry.amountPerToken` | mUSD per new token (required) | ask |
| `entry.maxAgeSeconds` | only tokens at most this old when seen (required) | 60 |
| `entry.keywords` | name/symbol must contain one (case-insensitive); `[]` = all | `[]` |
| `entry.excludeOwn` | skip the account's own tokens | `true` |
| `entry.maxOpenPositions` | at most this many held at once | 10 |
| `entry.maxEntryPriceMultiple` | skip if the price is already above this × launch price | 2 |
| `exit.takeProfitPercent` | sell when the position is up this much (after fees) (required) | ask |
| `exit.takeProfitSellPercent` | how much of the position to sell then, once (required) | ask (100 if "sell") |
| `exit.maxHoldMinutes` | sell everything that is left after this long (chain time) (required) | ask |
| `exit.stopLossPercent` | must be `null`: no stop-loss in this version | `null` |
| `slippagePercent` | per autopilot trade | 3 |

Unknown fields are refused. If the user asks for a stop-loss, say it is not available in this
version and leave it `null`.

Say honestly when you restate it:

- It spends from the same limit as manual trades; when the limit or the balance cannot cover the
  next buy it stops buying (`budget_exhausted`) until restarted, but keeps managing its positions.
- It manages only the positions it bought. The max-hold sell sells **all** of this session's
  inventory of that token, including tokens you bought by hand.
- A failed autopilot buy is not retried (that token is skipped); a failed sell is retried.
- A token's age is measured when the autopilot sees it, which can be a few seconds late.
- No stop-loss, no sandwich protection.

If `autopilot start` fails with "did not report within 120 s", the daemon may still come up (it
can wait for a trade in flight): run `autopilot status` before anything else, never start twice.

Reporting: `autopilot log --since <duration> --json` events are `started`, `stopped` (`reason`),
`bought` (`symbol, spent, tokens, explorer`), `sold` (`reason` `take_profit` / `max_hold`, `received,
pnl, explorer`), `skipped` (`reason`), `budget_exhausted`, `curve_completed` (use the exit-40 text),
`session_ended` (exit 13: ask for a re-grant), `error` (`source`, `message`).

## Worked dialogues

Each shows the user's message, the commands you run, and the gist of your answer.

### Portfolio and limit

> 我有多少钱、额度还剩多少

`mantle-meme portfolio --json`

> 账户 0xAbc… 有 16 mUSD，本次会话额度还剩 16 mUSD（到期 2026-10-22 08:00 UTC）。目前没有持仓。

### Create with a dev buy

> 发个币叫 PEPE2，自己先买 5U

`mantle-meme create --name PEPE2 --symbol PEPE2 --dev-buy 5 --json` (the create quotes the dev buy
itself; a create is in policy, so run it directly)

> 已创建 PEPE2（0x…），开发者先买花了 5 mUSD，得到 2,470,000 PEPE2。交易：https://sepolia.mantlescan.xyz/tx/0x…

### Buy and sell by symbol

> 买 2U 的 DOGE9

`mantle-meme quote DOGE9 --buy 2 --json` → `mantle-meme buy DOGE9 --amount 2 --json`

> 报价：2 mUSD 约得 960,000 DOGE9（手续费 0.02）。已买入：花 2 mUSD，得 958,700 DOGE9。交易：…

> 卖一半 DOGE9

`portfolio --json` (inventory) → `quote DOGE9 --sell <half> --json` → `sell DOGE9 --percent 50 --json`

### Start and stop the autopilot

> 开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟

Write `strategy.json` (amountPerToken "3", maxAgeSeconds 60, keywords [], excludeOwn true,
maxOpenPositions 10, maxEntryPriceMultiple 2, takeProfitPercent 50, takeProfitSellPercent 50,
maxHoldMinutes 30, stopLossPercent null, slippagePercent 3). Do **not** start yet:

> 确认一下打新策略：
> - 每个新上线、发现时不超过 60 秒的币买 3 mUSD（不限关键词，跳过自己发的币；价格已超过发行价 2 倍的跳过；最多同时持有 10 个）
> - 扣费后涨 50% 时卖出该仓位的一半（只卖一次）
> - 买入 30 分钟后（链上时间）把剩下的全部卖出
> - 每笔滑点 3%；没有止损，也没有防夹保护
> - 和手动交易共用额度（现在剩 11 mUSD），不够时停止买入
> 回复"是"就开始。

> 是

`mantle-meme autopilot start --strategy strategy.json --json`

> 打新已启动（pid 12345），之后每笔买卖都会推送给你。

> 停掉打新

`mantle-meme autopilot stop --json`

> 已停止。持有中的仓位不会再自动卖出，需要的话可以手动卖。

### Claim creator fees

> 领一下手续费

`mantle-meme claim --all --json`

> 已领取 0.05 mUSD 的创作者手续费（PEPE2）。交易：…  (If `hash` is `null`: 目前没有可领取的手续费。)

### A refused transfer

> 把 U 全转给 0x1234…

No command (none can transfer; do not try anything else):

> 这个做不到：我用的会话密钥只被链上策略允许在发射台上买、卖、发币和领手续费，转账（MockUSD `transfer`）不在允许范围内，会被策略拒绝（exit 10）。要把资金转出，请你在自己的终端用主账户（root key）操作。

### Session ended

Any command exits 13:

> 会话密钥已过期或已被撤销，我这边无法再交易。请在你的本地终端重新授权（`mantle-aa session grant`，再 `session export` 给我新的 agent home）。

## Install

See [README.md](README.md) in this directory (tested OpenClaw version, `skills.load.extraDirs`,
the environment).
