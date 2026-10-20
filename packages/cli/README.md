# @0xwh1sker/mantle-meme-cli (`mantle-meme`)

The command line of the Mantle agentic meme launchpad. An AI agent runs it with `--json` and
trades from an EIP-7702 smart account with a session key: each call is checked on chain by
`AgentPolicyHook` and its gas is paid by the sponsor. The human sets up the account with the
`mantle-aa` CLI (`@0xwh1sker/mantle-aa-cli` ~0.1.5).

> Proof of concept on Mantle Sepolia. **The contracts are not audited.** Spec of record:
> [docs/DESIGN.md](../../docs/DESIGN.md) §6 and §8.1.

## Settings

The AA CLI's environment, nothing else:

| Variable | Used by |
| --- | --- |
| `MANTLE_AA_RPC_URL` | every command except `policy init` |
| `MANTLE_AA_SPONSOR_URL` | commands that send: `create`, `buy`, `sell`, `claim` |
| `MANTLE_AA_HOME` | the agent home (`portfolio` and the commands that send); default `~/.mantle-aa`. For `policy init`, the root home |
| `MANTLE_AA_KEYSTORE_PASSWORD` | the agent key's password (commands that send, `autopilot start`) |
| `MANTLE_MEME_TG_BOT_TOKEN`, `MANTLE_MEME_TG_CHAT_ID` | the autopilot's Telegram push, only when both are set |
| `MANTLE_MEME_TG_API_URL` | the Bot API base URL; default `https://api.telegram.org` |
| `MANTLE_MEME_AUTOPILOT_TICK_MS` | the autopilot's exit / session check tick; default `10000` |
| `MANTLE_MEME_AUTOPILOT_POLL_MS` | the autopilot watcher's `eth_getLogs` poll; default `2000` |

`--agent <name>` picks the agent profile of the home (default: the only one). `--json` prints one
JSON object on stdout (below). The deployed launchpad and MockUSD come from the shipped address
book (`deployments/mantle-sepolia.json`).

## Human setup (DESIGN §8.1)

The root key stays in the human's terminal. The agent gets a home that holds only its session
key.

```bash
# Root terminal: MANTLE_AA_HOME is the root home, MANTLE_AA_KEYSTORE_PASSWORD its password,
# MANTLE_AA_RPC_URL and MANTLE_AA_SPONSOR_URL set.
mantle-aa keys new --name owner                     # once; or keys import
mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out policy.json
mantle-aa account init --grant policy.json --agent trader   # or, on an initialised account:
                                                            # mantle-aa session grant --agent trader --policy policy.json
MANTLE_AA_EXPORT_PASSWORD=<agent password> \
  mantle-aa session export --agent trader --out ~/.mantle-meme-agent
mantle-aa account exec --calls '<the MockUSD mint that policy init printed>'
```

`policy init` prints these next commands with the paths, agent name and exact mint calldata for
the root account in `MANTLE_AA_HOME`. The agent (OpenClaw) then runs with
`MANTLE_AA_HOME=~/.mantle-meme-agent` and `MANTLE_AA_KEYSTORE_PASSWORD=<agent password>`; the
exported home holds no root key, so none of `mantle-aa`'s account or session management commands
work there. Revoke with `mantle-aa session revoke --agent trader` in the root terminal.

The policy (DESIGN §6.2): a MockUSD limit (`--total`, `--per-day`, period 86400 s), the launchpad
as the only trusted spender, `maxDeadlineWindow` 600, and five permissions: MockUSD
`approve` (`ERC20_APPROVE`); launchpad `buy` (`LAUNCHPAD_BUY`), `sell` (`LAUNCHPAD_SELL`),
`createToken` and `claimCreatorFees` (`NONE`). `mantle-aa` 0.1.5 grants session keys for 24 h and
its policy file has no expiry field, so `--expiry` accepts only `24h`.

## Commands

`<token>` is an address or a symbol (exact, case-insensitive, over the newest 1000 tokens).
Amounts are human units: mUSD (6 decimals) and tokens (18 decimals). `--slippage` is a percentage
(default 5). Durations are `<n>s|m|h|d`. Every amount in a result is `{human, base}` (base units
as a decimal string); every transaction is `hash` plus `explorer` (a Mantlescan link).

| Command | `result` |
| --- | --- |
| `policy init --total <mUSD> --per-day <mUSD> [--expiry 24h] [--out policy.json]` | `{file, agent, expirySeconds, policy, next[]}`; without `--json`, the next steps as text |
| `create --name <n> --symbol <s> [--description <t>] [--image-url <u>] [--dev-buy <mUSD>] [--slippage 5]` | `{account, token, name, symbol, salt, hash, explorer, devBuy: {spent, tokens, fee, minOut, completes} \| null}` |
| `buy <token> --amount <mUSD> [--slippage 5]` | `{account, token, symbol, hash, explorer, requested, spent, tokens, fee, minOut, completes}` |
| `sell <token> (--amount <tokens> \| --percent <n> \| --all) [--slippage 5]` | `{account, token, symbol, hash, explorer, sold, received, fee, minOut, inventoryLeft}` |
| `quote <token> (--buy <mUSD> \| --sell <tokens>)` | buy: `{token, symbol, side, requested, amountIn, amountOut, fee, completes}`; sell: `{token, symbol, side, amountIn, amountOut, fee}` |
| `list [--status trading\|completed] [--limit 20] [--since <duration>]` | `{total, tokens: [token view]}`, newest first |
| `info <token>` | token view + `creatorFees` |
| `watch [--from-block <n>]` | one JSON line per launchpad event until SIGINT / SIGTERM: `{event, blockNumber, transactionHash, logIndex, args}` |
| `portfolio` | `{agent, account, keyHash, expiry, session: {initialized, active, revoked}, quote: {token, balance, remainingLimit}, positions: [{token, symbol, status, balance, inventory, costBasis, sellValue, unrealisedPnl}]}` (`null` = unknown cost basis) |
| `claim <token> \| --all` | `{account, claims: [{token, amount}], total, hash, explorer}`; nothing due: `hash` and `explorer` are `null` |
| `autopilot start --strategy <file>` | `{pid, account, keyHash, fromBlock, strategy, files: {dir, pid, strategy, state, events, log}}` once the detached daemon runs; exit 44 when one already runs |
| `autopilot stop` | `{pid, stopped: true, forced}` once the daemon exited (`forced`: killed after 60 s); exit 44 when none runs |
| `autopilot status` | `{running, pid, strategy, state}` (`strategy` / `state`: the files below, `null` before the first start) |
| `autopilot log [--since <duration>]` | `{events: [event]}`, oldest first; without `--json`, one JSON line per event |

Token view: `{address, name, symbol, status, creator, createdAt, price: {human, priceE18}, sold,
progressPercent, raised}`, plus `notice` on a completed curve.

- A buy that would complete the curve is clamped to the quote it needs (`completes: true`).
- `sell` is sized from this session's inventory on the hook, never the account's balance.
  Selling more than that inventory is exit 12, checked before anything is sent.
- `create --dev-buy` creates the token and buys it in the same sponsored batch.
- Successful trades are journalled in `<MANTLE_AA_HOME>/meme/journal.jsonl`, the only source of
  `portfolio`'s cost basis. Sends take the account's lock `<MANTLE_AA_HOME>/meme/send.lock` and
  retry a busy sponsor for up to 60 s.

## Autopilot (DESIGN §7.3)

`autopilot start` validates the strategy, then spawns a detached daemon that watches the
launchpad, buys new tokens that pass the entry filters and sells by take-profit and max hold, all
through the same send lock and journal as the commands. The strategy file:

```json
{
  "entry": { "amountPerToken": "3", "maxAgeSeconds": 60, "keywords": [], "excludeOwn": true,
             "maxOpenPositions": 10, "maxEntryPriceMultiple": 2 },
  "exit":  { "takeProfitPercent": 50, "takeProfitSellPercent": 50,
             "maxHoldMinutes": 30, "stopLossPercent": null },
  "slippagePercent": 3
}
```

- Required: `amountPerToken` (mUSD, a decimal string or number, > 0, at most 6 decimals),
  `maxAgeSeconds` (> 0), `takeProfitPercent` (> 0), `takeProfitSellPercent` (0 < n ≤ 100),
  `maxHoldMinutes` (> 0, fractional allowed). Defaults: `keywords` `[]` (every token),
  `excludeOwn` `true`, `maxOpenPositions` 10 (integer ≥ 1), `maxEntryPriceMultiple` 2 (≥ 1),
  `slippagePercent` 3 (0–100). `stopLossPercent` must be `null` or absent. Unknown fields are
  refused. A bad strategy is exit 1 (`USAGE`).
- Entry: a `TokenCreated` whose age when observed (chain time) is at most `maxAgeSeconds`, not
  created by the account (`excludeOwn`), whose name or symbol contains a keyword
  (case-insensitive), whose spot price is at most `maxEntryPriceMultiple` × the launch price,
  while fewer than `maxOpenPositions` are open. Then the hook's `remainingLimit` and the account's
  MockUSD balance must both cover `amountPerToken`; the first shortfall is `budget_exhausted` and
  the daemon enters nothing more until restarted. The buy is re-quoted right before the send.
- Exit: on every `Trade` of a held token and on every tick, the net sell value of
  `takeProfitSellPercent` of the session's inventory (local curve model, re-checked with
  `quoteSell` before the send) against that portion's journal cost basis: at
  `+takeProfitPercent` it sells that portion, once per position. `maxHoldMinutes` after the buy
  (chain time) it sells the whole remaining inventory. A position whose cost basis is unknown is
  not managed (`skipped`, `unknown_cost_basis`); a completed curve is `curve_completed`.
- Times are chain time (the latest block's timestamp), so on a fork `evm_increaseTime` +
  `evm_mine` moves the max hold.
- Every tick reads the key's state on chain (Calibur `isRegistered`, its expiry, the hook's
  `revoked`), so an idle daemon notices a revoke; that, or any exit 13 of a send, emits
  `session_ended` and the daemon exits.
- The daemon watches the blocks after the one current at the start. Only positions the autopilot
  opened are managed; a restart manages the open ones of the previous run again.

Files in `<MANTLE_AA_HOME>/meme/autopilot/`: `pid` (the running daemon), `strategy.json` (as
given), `state.json` (`{status: running|stopped|session_ended, pid, startedAt, updatedAt,
account, keyHash, fromBlock, budgetExhausted, positions: [{token, symbol, openedAt, status:
open|closed|completed|unmanaged, takeProfitDone}]}`), `events.jsonl` and `daemon.log` (the
daemon's own stderr).

Events (`events.jsonl`, one JSON object per line, `at` = ISO wall-clock time):

| `event` | Fields |
| --- | --- |
| `started` | `pid, account, keyHash, fromBlock, strategy` |
| `stopped` | `reason`: `stop`, `session_ended`, `error`, `killed` |
| `bought` | `token, symbol, hash, explorer, ageSeconds, spent, tokens, fee, minOut` |
| `sold` | `token, symbol, reason` (`take_profit`, `max_hold`)`, hash, explorer, sold, received, fee, minOut, costBasis, pnl` |
| `skipped` | `token, symbol, reason`: `too_old`, `own`, `keywords`, `not_trading`, `entry_price`, `max_positions`, `unknown_cost_basis` |
| `budget_exhausted` | `needed, remainingLimit, balance` (or `needed, cause` when a send was refused with 11 / 43) |
| `curve_completed` | `token, symbol` |
| `session_ended` | `exitCode` 13 and the error's `code, type, message, …` |
| `error` | `source` (`buy`, `sell`, `step`, `watch`, `telegram`, `daemon`), `exitCode`, `code, type, message, …`; a failed sell is retried by the next decision, a failed buy is not |

With `MANTLE_MEME_TG_BOT_TOKEN` and `MANTLE_MEME_TG_CHAT_ID` set, every event except the entry
filter skips and Telegram's own errors is pushed as a template message (Bot API `sendMessage`).
A failed push is an `error` event (`source: telegram`) and never stops trading; the token is never
written to a file or an output.

## Output and exit codes

`--json`: `{"ok": true, "command", "result"}` or
`{"ok": false, "command", "exitCode", "error": {"code", "type", "message", …fields}}`. Without
`--json` the result is printed as indented JSON and an error as one `error: …` line on stderr.

| Exit | `error.code` | Meaning |
| --- | --- | --- |
| 0 | | OK |
| 1 | `USAGE`, `ERROR` | Bad command line or missing setting; any other error |
| 10 | `POLICY_VIOLATION` | The policy forbids a call |
| 11 | `LIMIT_EXCEEDED` | Over the session's MockUSD limit (`remaining`, `requested`) |
| 12 | `INVENTORY_EXCEEDED` | Selling more than this session bought (`held`, `requested`) |
| 13 | `KEY_EXPIRED_OR_REVOKED` | The session key expired or was revoked: re-grant from the root terminal |
| 20 | `SPONSOR_REJECTED` | The sponsor refused the request |
| 21 | `SPONSOR_BUSY` | The sponsor stayed busy for this account past the 60 s retry |
| 30 | `EXECUTION_REVERTED` | The batch reverted for another reason |
| 40 | `CURVE_COMPLETED` | "Curve completed; trading is disabled. This v1 launchpad has no migration path, so the position is stranded." |
| 41 | `SLIPPAGE` | Output below `minOut` |
| 42 | `UNKNOWN_TOKEN` | Not registered on this launchpad, or a missing or ambiguous symbol (`candidates`, at most 10) |
| 43 | `INSUFFICIENT_BALANCE` | The account's MockUSD (or token) balance is too low (`balance`, `needed`) |
| 44 | `AUTOPILOT_STATE` | `autopilot start` while a daemon runs, `autopilot stop` while none runs |

AA codes come unchanged from the published `mantle-aa` CLI's `describeError`. `buy`, `sell` and
`quote` check the curve before trading (40). The deployed Calibur reverts a failing session call
with a bare `CallFailed()`, without the launchpad's revert data, so a send that fails is explained
by the SDK from chain state: 40, 41 or 43, else the AA code.

## Development

```bash
pnpm build                                              # dist/bin/mantle-meme.js
pnpm vitest run packages/cli/test/cli.test.ts           # no chain
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz \
  pnpm vitest run packages/cli/test/cli.fork.test.ts    # anvil fork, real AA contracts, sponsor
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz \
  pnpm vitest run packages/cli/test/autopilot.fork.test.ts   # the daemon on the fork
```

`test/helpers.ts` runs the binary from its TypeScript sources (no build) and the published
`mantle-aa` binary.
