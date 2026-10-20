# §9.1 acceptance (`e2e/acceptance/`)

DESIGN §9.1 items 1–8 as one ordered flow (`flow.ts`) through the real binaries: the human sets up
with `mantle-meme policy init` and the published `mantle-aa`; the agent uses only the exported agent
home (`mantle-meme`, `mantle-aa agent exec`, the autopilot daemon); `tools/market-sim` EOAs are the
market; `mantle-aa sponsor serve` relays every transaction of the account. The same flow runs in
two places:

| Where | File | Chain | Keys |
| --- | --- | --- | --- |
| CI (`e2e` job) | `acceptance.fork.test.ts` | anvil fork of Mantle Sepolia | throwaway |
| Once, by hand | `sepolia.ts` | Mantle Sepolia (or a local fork with `ACCEPTANCE_FORK=1`) | from the environment |

The only difference is the clock. The autopilot's max hold is chain time: on a fork the flow moves
it with `evm_increaseTime`, and on Sepolia it waits out the 2 minutes.

## Steps

1. Item 1: `keys import` (a fresh root key), `policy init --total 16 --per-day 16`, `account init
   --grant`, `session export`, and the printed MockUSD mint. The human and the agent hold 0 MNT.
   The agent home holds no root key, and `account status` is refused there.
2. Item 2: `create --dev-buy 5`, `buy 2`, `sell --percent 50`, then `quote`, `info`, `list` and
   `portfolio`, checked against the chain and the agent's own `Trade` logs.
3. Item 6: transfer (10), selling more than the inventory (12), unknown token (42), over the limit
   (11). Slippage (41): another trader buys between the CLI's quote and its send.
4. Items 3 and 6: `autopilot start`; a second start is exit 44. market-sim creates a token the
   keywords skip and one they match; the autopilot buys the match within `maxAgeSeconds`. `pump`
   leads to a take-profit sell, and max hold (chain time) sells the rest.
5. Item 8: an autopilot buy and a manual `mantle-meme buy` at the same moment (below).
6. Item 3: the next match finds 2 mUSD left of the limit, below `amountPerToken` 3, so the
   autopilot emits `budget_exhausted`.
7. Item 4: market-sim buys 1,000 mUSD of a token the agent holds. The curve completes through
   on-chain truncation (only `amountInUsed` is pulled), and the agent's `buy` / `sell` are exit 40.
8. Item 2, clamp case: market-sim leaves about 1.5 mUSD to completion. The agent asks for limit + 1
   mUSD and is charged exactly `amountInUsed`.
9. Item 5: `claim` pays the creator share, and `claimProtocolFees` pays the treasury.
10. Item 7: the human runs `session revoke`. The autopilot emits `session_ended`, `stopped` and
    exits, and the agent's next command is exit 13.
11. Item 1, end of the run: the human and the agent still hold 0 MNT. Every transaction of the
    account was sent by the sponsor's relayer, the sponsor never answered `SPONSOR_BUSY`, and no
    secret appears in any output or autopilot file.

Every spend is exact (5 + 2 + 3 + 3 + 1 of a 16 mUSD limit), so the limit runs out on schedule.

## How the flow observes the run

Local JSON-RPC proxies (`RpcProxy` in `flow.ts`) sit in front of the chain, for the market-sim
EOAs, the sponsor and the agent's commands, and in front of the sponsor, for the human's and the
agent's commands and for the daemon. They forward everything unchanged. They record:

- every `eth_sendRawTransaction`, which gives the run's complete transaction list (the market-sim
  EOAs and the relayer; the human and the agent never send);
- every sponsor reply, none of which may be `SPONSOR_BUSY`.

Two races are made deterministic by holding one reply:

- **Slippage (41):** the agent's `quoteBuy` reply is held until another trader's 50 mUSD buy of
  the same token is mined.
- **Concurrency (item 8):** the daemon's `sponsor_relay` is held. By then the daemon already holds
  the send lock. The hold lasts until the manual `buy`, started while the daemon held the lock, has
  quoted. The flow polls `<agentHome>/meme/send.lock` every 5 ms and checks the order: the daemon
  held the lock; the manual buy started and quoted meanwhile; the manual buy took the lock only
  after the daemon released it; and its first `sponsor_relay` came after the daemon's settled.
  Both buys complete, and no `SPONSOR_BUSY` is returned or printed. With the lock disabled in the
  SDK, the sponsor does answer `SPONSOR_BUSY` (the SDK retries it silently) and this step fails.

## Running

The fork suite (needs `anvil`):

```bash
MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz pnpm vitest run e2e/acceptance
```

The Sepolia run spends testnet MNT. Run it from a committed, clean tree (the script refuses
tracked changes) and detached, so that a dropped terminal does not stop it:

```bash
export MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz
export ACCEPTANCE_RELAYER_KEY=…            # the sponsor's relayer hot wallet (≥ 1 MNT)
export MARKET_SIM_MNEMONIC_FILE=…          # market-sim EOAs 0..2 (≥ 0.2 MNT each)
export ACCEPTANCE_RUN_DIR=$HOME/meme-acceptance/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$ACCEPTANCE_RUN_DIR"
nohup node --experimental-transform-types --no-warnings \
  --import ./packages/cli/test/fixtures/node-ts.mjs e2e/acceptance/sepolia.ts \
  > "$ACCEPTANCE_RUN_DIR/stdout.log" 2>&1 &
echo $! > "$ACCEPTANCE_RUN_DIR/pid"
```

Set `ACCEPTANCE_FORK=1` to rehearse the same script against a local anvil fork. It then uses
throwaway keys and ignores the key variables.

The run directory receives:

- `run.log`: every step, transaction and timeline, scrubbed of keys, the mnemonic, passwords and
  the RPC URL;
- `results.json`: commit, steps, wallets, MNT spent, and every transaction with its sender, status
  and fee;
- `transactions.md`: the transaction table for `docs/acceptance.md`.

The script ends by checking that no file in the run directory contains a key, the mnemonic or a
password, and that no file contains the RPC URL. `SIGINT` / `SIGTERM` stop the daemon and the
sponsor it started.
