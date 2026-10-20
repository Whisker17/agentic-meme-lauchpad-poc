# market-sim

A non-LLM market for the launchpad (DESIGN §8.3): N plain EOAs (default 3) create tokens and
trade them directly on `MemeLaunchpad`, so the autopilot has launches to snipe and prices that
move. The EOAs pay their own gas in MNT (outside the sponsor budget) and mint their own MockUSD
(anyone may mint it). Works against an anvil fork of Mantle Sepolia and Mantle Sepolia itself,
using the shipped address book. Private; not published.

## Setup

```bash
pnpm install && pnpm build          # builds the SDK and dist/ of this package
export MARKET_SIM_RPC_URL=http://127.0.0.1:8545     # an anvil fork, or a Mantle Sepolia RPC
export MARKET_SIM_MNEMONIC_FILE=~/.market-sim/mnemonic   # or MARKET_SIM_MNEMONIC="…"
node tools/market-sim/dist/bin.js addresses
```

Keys: one BIP-39 mnemonic; wallet `i` is `m/44'/60'/0'/0/i`, `--wallets` of them (default 3).
The mnemonic is read from `MARKET_SIM_MNEMONIC_FILE` (preferred) or `MARKET_SIM_MNEMONIC`, and is
never printed or logged: output carries addresses only.

Funding (N keys, no funder key):

- **Gas (MNT).** On a fork: `anvil_setBalance` for each address printed by `addresses`. On
  Mantle Sepolia the operator sends a little testnet MNT to each of them.
- **MockUSD.** Nothing to do: before a buy, an EOA holding less than the amount mints the
  shortfall plus 1,000 mUSD.

## Commands

Every command prints one JSON line per event (`create`, `mint`, `buy`, `sell`, `pump`, `skip`,
`error`; amounts in base units as strings). A pump prints its `buy` and then a `pump` line with
the prices before and after. Failures go to stderr as one line (a launchpad revert by name, e.g.
`Curve completed; …`).

| Command | What it does |
|---|---|
| `market-sim addresses` | The EOA addresses (no RPC needed) |
| `market-sim run [--duration s] [--seed n] [--create-every a-b] [--trade-every a-b]` | A create right away and then every 2–5 min (default `120-300` s); between creates, a random buy (1–20 mUSD) or sell (20–100% of a holding) every 10–30 s (default `10-30` s) on the newest 20 trading tokens. Ends on Ctrl-C / SIGTERM / `--duration` with a `summary` line; exit 1 if any step failed |
| `market-sim pump <token> [--percent p] [--wallet i]` | Buys `<token>` (address or symbol) until its spot price is `(1 + p/100)` × the price right before the pump (default `p` = 100: doubles it) |
| `market-sim buy <token> <mUSD> [--wallet i]` | Approves and buys exactly `<mUSD>`, **not clamped**: more than the curve has left completes it through on-chain truncation |

Common: `--wallets n` (default 3), `--seed n` (default 1; seeds wallet, action, size and name
choices). Exit codes: 0 ok, 1 a transaction or RPC failed, 2 usage.

`run` skips (does not send) a random buy that would complete a curve and a sell too small to
pay out, so it never ends a curve the autopilot holds by accident.

## Pump

"+X%" is the **spot price** `curveState(token).priceE18` after the pump vs right before it.
Price is `vQ²/k` up to rounding, so the target reserve is `vQ · sqrt(1 + X/100)`; `planPump`
computes the buy from that and checks it with the contract's own arithmetic (`simulateBuy`).
From launch (vQ = 200 mUSD) +50% costs ≈ 45.4 mUSD and +100% ≈ 83.7 mUSD, fee included. A target
past the curve end (vQ = 800 mUSD, price ×16 from launch) is capped at the completing amount, so a
pump never pays for tokens the curve no longer has; the event then says `completed: true`.

The default +100% leaves an autopilot position bought at or below the pre-pump price comfortably
past a +50% take-profit after both 1% fees and the sell's own price impact.

## Programmatic API (`src/sim.ts`)

```ts
import { MarketSim, planPump, mUSD } from "./tools/market-sim/src/sim.js";

const sim = new MarketSim({
  rpcUrl,                       // fork or Sepolia
  accounts,                     // LocalAccount[] (e.g. privateKeyToAccount / mnemonicToAccount)
  seed: 42,                     // optional, default 1
  log: (e: SimEvent) => {},     // optional
  launchpad, quoteToken,        // optional, default: the shipped address book
  pollingIntervalMs: 50,        // optional receipt polling (default 250) …
  receiptTimeoutMs: 60_000,     // … and its bound
});
sim.addresses;                                            // Address[]
await sim.createToken({ wallet?, name?, symbol? });       // CreateEvent { token, tx, … }
await sim.buy(token, amountIn, { wallet?, slippageBps? });   // TradeEvent { quoteAmount, tokenAmount, completed }
await sim.sell(token, amount, { wallet?, slippageBps? });    // TradeEvent
await sim.pump(token, { percent?, wallet? });             // PumpEvent { priceBefore, priceAfter, … }
await sim.step(kind?: "create" | "buy" | "sell");         // one scheduler step → SimEvent
await sim.run({ signal, createIntervalMs: [a, b], tradeIntervalMs: [a, b] });  // RunSummary
planPump(curveParams, { vT, vQ }, percent);               // PumpPlan (pure)
```

Every method waits for its receipts and throws on a revert. Filling a curve through on-chain
truncation (DESIGN §4.3.3): `sim.buy(token, 1_000n * mUSD)` on a trading curve pulls only the
completing `amountInUsed` and returns `completed: true`; the token's status becomes `completed`.

## Tests

- `test/sim.test.ts`: `planPump` against the local curve model; CLI parsing.
- `test/market-sim.fork.test.ts` (needs `MANTLE_SEPOLIA_RPC_URL`): create / buy / sell from
  plain EOAs, `pump` past +50%, a truncating buy to `Completed`, and `run` with no errors.
