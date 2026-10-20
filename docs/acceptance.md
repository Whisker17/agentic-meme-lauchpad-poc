# Mantle Sepolia acceptance run (DESIGN §9.1)

DESIGN §9.1 items 1–8 on the real chain, as the definition of done requires (§1.1, §11 0.1.2:
"§9.1 green on fork and Sepolia"). Script: `e2e/acceptance/sepolia.ts`, which runs the same flow
(`e2e/acceptance/flow.ts`) that CI runs on an anvil fork (`e2e/acceptance/acceptance.fork.test.ts`).
`e2e/acceptance/README.md` explains how to run it and how the flow observes the run.

- **Run:** 2026-10-20, 12:53:32–13:06:56 UTC, Mantle Sepolia (chain 5003), public RPC
  `https://rpc.sepolia.mantle.xyz`. Run tag `KIWKT` (in every token symbol of the run).
- **Commit the script ran from:** `abbadf6` ("test(e2e): broadcast the race buy through the
  market-sim proxy, so it is listed"), a commit of the pull request that added this file, with a
  clean tracked tree. The script records the commit and
  refuses a Sepolia run from a tree with uncommitted changes. Since then the script changed in
  two ways only. It labels a transaction the daemon sends on its own, which this run's table
  showed blank: that is row "autopilot sells the rest of MOONKIWKTB" below, labelled here from
  the daemon's `events.jsonl`. And it stops its rehearsal fork (`ACCEPTANCE_FORK=1`) on every
  way out.
- **Command** (detached, with the keys in the environment only):

  ```bash
  MANTLE_SEPOLIA_RPC_URL=https://rpc.sepolia.mantle.xyz ACCEPTANCE_RELAYER_KEY=… \
  MARKET_SIM_MNEMONIC_FILE=… ACCEPTANCE_RUN_DIR=… \
  nohup node --experimental-transform-types --no-warnings \
    --import ./packages/cli/test/fixtures/node-ts.mjs e2e/acceptance/sepolia.ts > … 2>&1 &
  ```

- **Result:** all 16 steps passed, covering items 1–8, with 31 transactions. The sponsor's relayer
  sent 14 of them and paid **0.256771 MNT**. The script's two figures for this agree to the wei:
  the relayer's balance delta and the sum of its receipts' fees (L2 gas + L1 fee + operator fee).
  The three market-sim EOAs sent the other 17 and paid 0.251550 MNT. The human's account and the
  agent key held **0 MNT** at the start, after the setup and at the end. The script checked this,
  and `cast balance` confirmed it after the run.
- **Before the real run**, the same script passed 16/16 against a local anvil fork of Mantle
  Sepolia with throwaway keys (`ACCEPTANCE_FORK=1`; 30 transactions, no testnet MNT spent). The CI
  fork suite passed 16/16.

## Addresses

| What | Address |
| --- | --- |
| MemeLaunchpad (`deployments/mantle-sepolia.json`) | `0xB7E6E09Bc2dF2b078A9171abA68663f13E2bc985` |
| MockUSD | `0xDA74D3F269F4aF7a3a5eFFf81Bf64384De327526` |
| CaliburEntry v1.1.0 (the account's 7702 delegate) | `0x000000005c84F8Fd50b21CAC312528A64437030e` |
| AgentPolicyHook | `0xdC99279cc8858a109A0dE31b021D54EBe30aDd7F` |
| Launchpad treasury (protocol fees) | `0x660e3265781026a148fa6e5Ccbc8fAa76B79B928` |
| Sponsor relayer hot wallet (`mantle-aa sponsor serve`) | `0x03BA85B933bC3f77B0BDdAF18abE7392AB5BcF8F` |
| market-sim EOA 0 (creates; `claimProtocolFees`) | `0xD794DF18a4B88433116571b45EbE7d642F39B438` |
| market-sim EOA 1 (the slippage race; the clamp fixture) | `0x75B65d2c46396f31b2eAf1Da08709ca8fb141530` |
| market-sim EOA 2 (the pump; the curve fill) | `0x1a04a232143514012AC22bDB46Dac88Dc4cD81Bd` |
| The human's account (fresh root key, delegated by `account init`) | `0xB2CDF8826225207Db9fdD9334270fEdE1B42B450` |
| The agent's session key (exported home) | `0xdE051CeeD521d9DEB2E141374e64069635107A84` |

Tokens of the run:

| Token | Address | Created by | Role |
| --- | --- | --- | --- |
| GATEKIWKT | `0xa6fd05a43Ba031d8aF4b56626bf2ca24dD10C49D` | the agent (`create --dev-buy 5`) | item 2; creator fees (item 5) |
| PLNKIWKT | `0x5769D0dd783E7436da3297Fdd0D620804592638c` | market-sim | skipped by the keywords; the manual buy of item 8; filled in item 4 |
| MOONKIWKTA | `0x938BF11676781f2ebD37ed406e936e6Bf3230031` | market-sim | autopilot buy, take-profit, max hold (item 3) |
| MOONKIWKTB | `0xEE135261Ea5B9cD63aA34F0E976ea11E67Dd3005` | market-sim | the autopilot buy of item 8 |
| MOONKIWKTC | `0xB64a521FaFf010Fb9d4d0fF7F710F438735d9088` | market-sim | `budget_exhausted` (not bought) |
| CLMPKIWKT | `0x950ac6E5E62171fe4cFDa1a6D3bAb63133fA795C` | market-sim | the clamp case (item 2) |

## Setup

- **Sponsor:** `mantle-aa sponsor serve` (published `@0xwh1sker/mantle-aa-cli` 0.1.5), relayer
  path only, with the relayer key passed through the environment (`relayerKey:
  ${ACCEPTANCE_RELAYER_KEY}`). Caps:
  allowlist = the run's account, `accountDailyGas: 2000000000`, `maxFeePerRequestMnt: "0.3"`,
  `dailyBudgetMnt: "2"`, `managementReserveMnt: "0.5"`. No paymaster signer key was needed.
- **Policy:** `mantle-meme policy init --total 16 --per-day 16 --expiry 24h`. Every spend of the
  flow is exact (dev buy 5, buy 2, autopilot 3 + 3, manual 1), so 2 mUSD remain when the third
  matching token appears.
- **Strategy:**
  `{"entry":{"amountPerToken":"3","maxAgeSeconds":60,"keywords":["MOONKIWKT"],"excludeOwn":true,"maxOpenPositions":10,"maxEntryPriceMultiple":2},"exit":{"takeProfitPercent":50,"takeProfitSellPercent":50,"maxHoldMinutes":2,"stopLossPercent":null},"slippagePercent":3}`.
  The daemon used its default tick (10 s) and watcher poll (2 s).
- **Telegram:** not exercised on Sepolia (no bot credentials were provided; the push is optional
  here). The push is covered against a mock Bot API by `packages/cli/test/autopilot.fork.test.ts`.

## Per item

Each step asserts the outcome and the chain state around it. A refusal also asserts that nothing
changed: remaining limit, inventory, token balance and journal. A refused command sends nothing,
so it has no transaction link.

| §9.1 item | Step | Outcome on Sepolia | Transactions (table below) |
| --- | --- | --- | --- |
| 1 | `keys import` (fresh root), `policy init`, `account init --grant`, `session export`, the printed MockUSD mint | Passed. Account `INITIALIZED`; 16 mUSD minted and a 16 mUSD remaining limit. The agent home holds only the agent profile and keystore: no root key or root keystore cipher in any of its files, and `account status` there is exit 1 `USAGE`. Root and agent at 0 MNT | init, mint |
| 2 | `create --dev-buy 5`, `buy 2`, `sell --percent 50` | Passed. The receipts' `Trade` logs equal the CLI results; inventory and limit (11, then 9 mUSD) are exact | create, buy, sell |
| 2 | `quote`, `info`, `list`, `portfolio` | Passed. Agree with the views and with the agent's own `Trade` logs (cost basis), and the journal equals the chain's trades | none (read only) |
| 6 | MockUSD `transfer` via `mantle-aa agent exec` (10), sell over inventory (12), unknown symbol and address (42), over the limit (11) | Passed. Exit codes as listed; nothing changed | none (refused before sending) |
| 6 | slippage (41) | Passed. Another trader's 50 mUSD buy was mined 5.5 s after the CLI's quote and before its send; exit 41, nothing changed | the race buy and its two fixture transactions |
| 3 + 6 | `autopilot start`; a second start | Passed. The daemon detaches and runs; the second start is exit 44 `Autopilot is already running (pid …)`, and the first daemon is untouched | none |
| 3 | market-sim creates PLNKIWKT, then MOONKIWKTA | Passed. PLN `skipped` (`keywords`); MOONKIWKTA bought (3 mUSD) at an observed age ≤ 60 s. Its buy block is ≤ 60 s of chain time after the token's `createdAt` | the creates, the autopilot buy |
| 3 | `market-sim pump` (+100%) | Passed. Take-profit sold exactly half of the inventory, received ≥ 150% of that half's cost basis | pump (approve + buy), take-profit sell |
| 3 | max hold (2 min of chain time) | Passed. The script waited for the chain's clock. The rest was sold in a block ≥ `openedAt` + 120 s, the inventory is 0, and the position is `closed`, `takeProfitDone` | max-hold sell |
| 8 | an autopilot buy and a manual `mantle-meme buy` at the same moment | Passed (timeline below). Both completed; the sponsor never answered `SPONSOR_BUSY`, and the CLI printed none | create, the two buys |
| 3 | `budget_exhausted` | Passed. On MOONKIWKTC: `needed` 3, `remainingLimit` 2 mUSD; no buy, a single event, `state.budgetExhausted` | create |
| 4 | market-sim buys 1,000 mUSD of PLNKIWKT, which the agent holds | Passed. Pulled only `amountInUsed` (605.060607 mUSD); `CurveCompleted`; status `completed`, all 800M curve tokens sold. The agent's `buy` and `sell --all` are exit 40 with the §4.5 text; `info` says `completed`; nothing changed | mint, approve, the completing buy |
| 2 (clamp) | market-sim leaves ≈ 1.5 mUSD to completion; the agent asks for limit + 1 = 3 mUSD with 2 left | Passed. Premise `amountInUsed` < 2 < 3 checked first. Charged exactly `amountInUsed` (`Trade.quoteAmount`, and the limit moved by that); one `CurveCompleted`; inventory = the curve's remaining tokens | the fixture (create, mint, approve, buy), the clamped buy |
| 5 | `claim`; `claimProtocolFees` | Passed. Creator share = Σ fee/2 over every `Trade` of GATEKIWKT (the agent's three and the race buy); `CreatorFeesClaimed` to the account, then 0 due. `ProtocolFeesClaimed` ≥ the amount due before, and the treasury's MockUSD rose by exactly that | claim, claimProtocolFees |
| 7 | the human's `session revoke` | Passed. The daemon emitted `session_ended` (exit 13, `KEY_EXPIRED_OR_REVOKED`, "Session key is not registered on the account") and `stopped` (`session_ended`), and its process exited. `status`: not running, `session_ended`. The agent's next `buy` is exit 13; `autopilot stop` is exit 44 | revoke |
| 1 | end of the run | Passed. Account and agent at 0 MNT; no root key in the agent home; every transaction of the account (the journal and the flow's list) was sent by the relayer; no `SPONSOR_BUSY` in any sponsor reply; no secret in any CLI output or autopilot file | none |

### Item 8 on Sepolia

Milliseconds from the daemon taking the send lock for its MOONKIWKTB buy, from the run's log. The
lock file was polled every 5 ms; the sponsor's replies were recorded by the proxy in front of it.

| Event | ms |
| --- | ---: |
| The manual `mantle-meme buy PLNKIWKT 1` started | 1 |
| The manual buy quoted (it then waits at the lock) | 2,784 |
| The daemon's `sponsor_relay` reached the proxy | 7,464 |
| The daemon's relay settled | 23,500 |
| The daemon released the lock | 24,827 |
| The manual buy took the lock | 24,863 |
| The manual buy's first `sponsor_relay` | 30,587 |

The proxy would have held the daemon's relay until the manual buy had quoted, plus 1 s. On
Sepolia the daemon's relay arrived after that point, so nothing was held: the overlap was natural.
The manual buy waited about 22 s at the lock, and its transaction is 11 blocks after the
daemon's.

## Transactions

Sender fees are from each receipt: `gasUsed × effectiveGasPrice + l1Fee + gasUsed ×
operatorFeeScalar × 100 + operatorFeeConstant`. The human and the agent sent nothing.

| Item | What | Status | Transaction | Sender | Fee (MNT) |
| --- | --- | --- | --- | --- | ---: |
| 1 | account init --grant (7702 delegation + session grant) | success | [0x81bdb45d…c2bd](https://sepolia.mantlescan.xyz/tx/0x81bdb45dd2a5a7c3b5bb745c3a67c17a7e9914449eeba94e268be9f03211c2bd) | relayer | 0.044851 |
| 1 | account exec: mint 16 mUSD to the account | success | [0x0062944e…dc00](https://sepolia.mantlescan.xyz/tx/0x0062944e0443876018b692042323055166fd5dfec806cc1c5cf59963dd7cdc00) | relayer | 0.004773 |
| 2 | create GATEKIWKT --dev-buy 5 | success | [0x9fd79c85…73dc](https://sepolia.mantlescan.xyz/tx/0x9fd79c858f16f1fde7568165866723530978e73a6547347b61cc2bc7ed5273dc) | relayer | 0.061907 |
| 2 | buy GATEKIWKT 2 mUSD | success | [0x17f5d042…4b12](https://sepolia.mantlescan.xyz/tx/0x17f5d0428f7c18e12e136a942415576bd8dc24d2b7b8b5db2bc15ca1478c4b12) | relayer | 0.014359 |
| 2 | sell GATEKIWKT --percent 50 | success | [0x6db7d645…60b6](https://sepolia.mantlescan.xyz/tx/0x6db7d645e0a4f1fe60e9830442710bc1ef62691070337310055f5e55d04360b6) | relayer | 0.011278 |
| 6 | market-sim wallet 1 mints 100 mUSD (for the race buy) | success | [0x9d6ffbcc…905b](https://sepolia.mantlescan.xyz/tx/0x9d6ffbcc1790375bde24f0f888774ea5cae632330fa5fcf5d58c9a61b892905b) | market-sim 1 | 0.002052 |
| 6 | market-sim wallet 1 approves the launchpad | success | [0x363f39fd…2c42](https://sepolia.mantlescan.xyz/tx/0x363f39fd093e0b697a1b4f9c39f7d105b2e118d58c8a56485eefe79a20152c42) | market-sim 1 | 0.001608 |
| 6 | market-sim wallet 1 buys 50 mUSD of GATEKIWKT between the CLI's quote and its send | success | [0x6f6be7ef…6396](https://sepolia.mantlescan.xyz/tx/0x6f6be7efd1bec78cfaef6a0527d5f6f7f0e5a7ca747651423ebe1fb4eaca6396) | market-sim 1 | 0.006254 |
| 3 | market-sim createToken PLNKIWKT | success | [0xdf7fbb7c…3558](https://sepolia.mantlescan.xyz/tx/0xdf7fbb7c18791740fcebdd4be39124ba4185d1e200f5527be94442ca14d53558) | market-sim 0 | 0.041331 |
| 3 | market-sim createToken MOONKIWKTA | success | [0x47ebc145…b41b](https://sepolia.mantlescan.xyz/tx/0x47ebc14548cd3eb955e8812e15eb356824ff7d609aa271d6709a4a6b55f0b41b) | market-sim 0 | 0.041333 |
| 3 | autopilot buys MOONKIWKTA (3 mUSD) | success | [0x1307c379…823f](https://sepolia.mantlescan.xyz/tx/0x1307c3792c317a5fadf14f0cdf75247ebc038aa90cfd6cb2b2bdf248cde7823f) | relayer | 0.018463 |
| 3 | market-sim approves the launchpad | success | [0x66c5cd06…f749](https://sepolia.mantlescan.xyz/tx/0x66c5cd0636187f9e5b88e5b397e4bf5c7e58e38e6efb010873d535830835f749) | market-sim 2 | 0.002782 |
| 3 | market-sim buy 84.922149 mUSD | success | [0xa043510b…9f24](https://sepolia.mantlescan.xyz/tx/0xa043510bb52f77cda4d30a3dd70808a2b8e9f97cc0e0271f24027653ac219f24) | market-sim 2 | 0.006168 |
| 3 | autopilot take-profit sells half of MOONKIWKTA | success | [0xd6608edc…f81b](https://sepolia.mantlescan.xyz/tx/0xd6608edc124c53dd4e5c3045301fc7a81f6de433f7353032d779ee708f8ef81b) | relayer | 0.011278 |
| 3 | autopilot max-hold sells the rest of MOONKIWKTA | success | [0xcc5e64dd…e9dd](https://sepolia.mantlescan.xyz/tx/0xcc5e64dd1ec05e1fcd339142d932c2ab0bfd772819f4a920e26df5fe33aae9dd) | relayer | 0.010414 |
| 8 | market-sim createToken MOONKIWKTB | success | [0x79152d85…e7ce](https://sepolia.mantlescan.xyz/tx/0x79152d8549df2db5112d326e15a60cd6d289e37e5050b722b55529eaafabe7ce) | market-sim 0 | 0.041333 |
| 8 | autopilot buys MOONKIWKTB (3 mUSD) | success | [0xcf0f3d13…eca2](https://sepolia.mantlescan.xyz/tx/0xcf0f3d13ffc973bd65d3598b03552ebb5a2bad73ab58f8c8b439a07a8ea5eca2) | relayer | 0.018463 |
| 8 | manual buy PLNKIWKT 1 mUSD, concurrent with the autopilot | success | [0x92388650…c221](https://sepolia.mantlescan.xyz/tx/0x92388650f59cfbb16e69a7d5c896a70437bcc53c1a5269f04b49f46b9c57c221) | relayer | 0.018463 |
| 3 | market-sim createToken MOONKIWKTC | success | [0x9b855f95…8b9c](https://sepolia.mantlescan.xyz/tx/0x9b855f957e335b91c49100101959d323ca2e22bd2758f4870099db005d7c8b9c) | market-sim 0 | 0.041333 |
| 4 | market-sim mints MockUSD | success | [0x6ae26277…2d56](https://sepolia.mantlescan.xyz/tx/0x6ae262772d8b8829b5bf887c104dab89aace3cab744ceaed07c8e2f756a32d56) | market-sim 2 | 0.002053 |
| 4 | market-sim approves the launchpad | success | [0x8274466b…09b6](https://sepolia.mantlescan.xyz/tx/0x8274466bd940c7e83368ba18746a1d1e97b174f1633019cd2672287e455e09b6) | market-sim 2 | 0.002781 |
| 4 | market-sim buy 605.060607 mUSD, completes the curve | success | [0x1e153b6e…31e9](https://sepolia.mantlescan.xyz/tx/0x1e153b6e29b893b41bb41898f98d9908b3166c518328cad60dca4399162131e9) | market-sim 2 | 0.006816 |
| 2 | market-sim createToken CLMPKIWKT | success | [0xaf2772d3…7866](https://sepolia.mantlescan.xyz/tx/0xaf2772d34c8cda21efd19de632ad5b9fc41f725f8a787138355cf6e7c3e07866) | market-sim 0 | 0.041331 |
| 2 | market-sim mints MockUSD | success | [0x206c2b04…f2f6](https://sepolia.mantlescan.xyz/tx/0x206c2b04b87f8b00e3a00aacb919547499f9d51ad4c05b620867c4ebf429f2f6) | market-sim 1 | 0.002053 |
| 2 | market-sim approves the launchpad | success | [0x5e6dac4f…d4f0](https://sepolia.mantlescan.xyz/tx/0x5e6dac4f5aeb8bcb44080c7929b6c66645b64bac727d2755f8ac53a29ec9d4f0) | market-sim 1 | 0.001756 |
| 2 | market-sim buy 604.560607 mUSD | success | [0x4e6e7992…f4b9](https://sepolia.mantlescan.xyz/tx/0x4e6e799257fb08f38131cc210b8e472817d0eabb42dcdd43d05906636633f4b9) | market-sim 1 | 0.007195 |
| 3 | autopilot sells the rest of MOONKIWKTB (max hold), on its own while the clamp step ran | success | [0x7ac10864…0c63](https://sepolia.mantlescan.xyz/tx/0x7ac10864bdf4edad284b16351848fb8d2d41b7b2c7eb2de51573c8b774930c63) | relayer | 0.010414 |
| 2 | clamped completing buy of CLMPKIWKT | success | [0x65f1e472…5a2e](https://sepolia.mantlescan.xyz/tx/0x65f1e472d890f3f47456f47577bb271741d5be75c23d779b9b6d49ab33995a2e) | relayer | 0.017796 |
| 5 | claim GATEKIWKT (creator fees) | success | [0xcb734be3…ef93](https://sepolia.mantlescan.xyz/tx/0xcb734be382118d5418c70f5ba3511c1b9ef2766590920efe8b9f494205e8ef93) | relayer | 0.008092 |
| 5 | claimProtocolFees (anyone may call; pays the treasury) | success | [0x008f8593…3af4](https://sepolia.mantlescan.xyz/tx/0x008f8593aeec8e70fc9e521dc761aa80c1551b1f22431501f8a60a479ae83af4) | market-sim 0 | 0.003373 |
| 7 | session revoke --agent trader (the human) | success | [0x82608a29…cd2e](https://sepolia.mantlescan.xyz/tx/0x82608a29a5da61091e3efba5cb1d07ba181a5cc82681988d1d8f6ff07ff6cd2e) | relayer | 0.006218 |

| Wallet | Transactions | MNT spent (balance delta = Σ fees) |
| --- | ---: | ---: |
| Sponsor relayer | 14 | 0.256771 |
| market-sim EOA 0 | 6 | 0.210033 |
| market-sim EOA 1 | 6 | 0.020918 |
| market-sim EOA 2 | 5 | 0.020599 |

## Deviations from §9.1, and why

- **Local proxies in the path.** The flow reaches the chain and the sponsor through local
  JSON-RPC proxies (`RpcProxy` in `flow.ts`), which forward requests unchanged. They exist to list
  every transaction sent, to record every sponsor reply, and to hold one reply for each race (41,
  item 8). On Sepolia the item 8 hold did not trigger (see above).
- **The public RPC's rate limit.** `rpc.sepolia.mantle.xyz` limits requests per IP (HTTP 429,
  `-32016 rate limit exceeded`), and `portfolio`'s parallel reads hit it. The proxies retry a 429
  with backoff, and the run's log counts the retries: 29 for the agent's commands and 1 for the
  daemon / human / observer. The flow also retries a read-only command that failed on an RPC
  error, and any command the sponsor refused with `FEE_UNBOUNDED` (nothing sent). Neither retry
  was needed on this run.
- **The clock.** The max hold is chain time, which Sepolia does not let us move: the strategy
  uses `maxHoldMinutes: 2` and the script waited. On the fork, `evm_increaseTime` moves it.
- **0 MNT "throughout"** is checked at the start of the setup, after it and at the end of the run
  (and by `cast balance` afterwards). Nothing in the flow sends MNT to the account or the agent.
- **The daemon also traded on its own.** It sold MOONKIWKTB at its max hold while the clamp step
  ran. That is expected behaviour, listed in the table.
- **`claimProtocolFees`** pays the treasury every protocol fee accrued on the deployed launchpad,
  not only this run's; the step therefore checks `amount ≥` the amount due before the call, and
  that the treasury's balance rose by exactly the amount paid.

## Earlier attempts

The accepted run was the fifth. The four before it stopped at their first failed step, each for a
reason outside the product. Each used fresh keys and a fresh account, and each led to a change in
the script (its commit is named):

| Started (UTC) | Commit | Stopped at | Cause | Change |
| --- | --- | --- | --- | --- |
| 12:12:31 | `05e0181` | item 8 (9/16 steps passed) | The manual buy was refused by the sponsor, `FEE_UNBOUNDED` ("the gas price oracle could not bound the fee"); its RPC error was not recorded then | `f9c91b2`: log every upstream RPC error |
| 12:23:29 | `f9c91b2` | item 2, `list` (2/16) | `RPC Request failed.` on a read-only command | `0be3db2`: retry read-only commands on an RPC failure |
| 12:34:16 | `3282f22` | item 2, `portfolio` (2/16) | HTTP 429 `-32016 rate limit exceeded` (now logged) | `2a6c206`: the proxies retry a 429 |
| 12:42:20 | `2a6c206` | item 6, slippage (4/16) | The race buy took longer than the CLI's 10 s RPC timeout, so viem asked for the quote again after the price had moved, and the 1 mUSD buy went through | `5b99a94`, `abbadf6`: the race buy is signed in advance and only broadcast in the race |

Over all five attempts, the relayer spent 0.878428 MNT (3 → 2.121572) and the market-sim EOAs
0.334029, 0.042967 and 0.032628 MNT. The accepted run's share is in the table above. Every attempt's
run directory, the accepted one included, was checked for secrets afterwards: no key, mnemonic or
password, and no RPC URL, in any of its files.

## Observed, not failed

- **The watcher on the load-balanced RPC.** The daemon's `eth_getLogs` was answered once with
  `requested block is above the latest consensus block` (a node behind the one that gave the
  head). The daemon wrote an `error` event (`source: watch`) and recovered at the next poll. With
  Telegram set, such an event is pushed to the user.
- **`FEE_UNBOUNDED` is a hard refusal.** The sponsor turns any failure of its gas price oracle
  reads into `FEE_UNBOUNDED`, which reaches the user as exit 20 without a retry (first attempt).
