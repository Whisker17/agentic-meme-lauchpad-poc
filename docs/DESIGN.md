# mantle-agentic-meme-launchpad — Design (spec of record)

> **Status:** v0.3 (2026-10-20), from the owner design interview (Appendix A), amended by an
> independent design review (Appendix B, findings R-1…R-8).
> v0.3: the facts measured and the decisions taken in 0.1.0 are recorded in place, each marked
> "(measured 0.1.0)" or "(decision 2026-10-20)".

> **Nature:** proof of concept on Mantle Sepolia. **The contracts are not audited.**
> **Upstream:** `mantle-7702-sdk` v0.1.4 (`@0xwh1sker/mantle-aa-{sdk,sponsor,cli}`), whose
> `docs/DESIGN.md` is referenced below as **AA-DESIGN**.

## 1. Goals and scope

### 1.1 Goal

An agentic meme launchpad on Mantle Sepolia, driven end to end by an AI agent through natural
language in Telegram (OpenClaw), with no front end. The agent trades from a 7702 smart account
with a scoped, revocable session key; every transaction is gasless.

**Definition of done:** the Telegram demo script (§9.2) runs reproducibly, and the automated
acceptance (§9.1) passes in CI (anvil fork) and once on Mantle Sepolia with a list of
transaction links.

The primary audience is a demo for Mantle and internal stakeholders; the contracts, SDK and docs
are a secondary deliverable, usable as a reference implementation.

### 1.2 Capabilities

1. **Create** a meme token, optionally with a dev buy in the same batch.
2. **Buy / sell** on a bonding curve.
3. **Snipe new launches** ("打新"): an autopilot watches new tokens and buys early within budget.
4. **Query**: quotes, curve progress, portfolio, remaining policy limits.
5. **Claim creator fees** earned by tokens the account created.
6. Two control modes: **command** (the human asks, the agent executes) and **autonomous** (the
   human sets a strategy, a deterministic autopilot executes and reports).

### 1.3 Non-goals (this iteration)

- Mainnet; any front end; an indexer, subgraph or candlestick data.
- **Graduation** to an AMM and post-graduation trading (the state is reserved, §4.6).
- Changes to `AgentPolicyHook`, `CaliburEntry` or `VerifyingPaymaster` (§2, D6).
- Presale / subscription-style launches; native-MNT or WMNT quote.
- An OpenClaw plugin (a skill + CLI only); an LLM in the trading loop.
- A Telegram emergency-revoke channel (stretch goal, §8.4).
- The bundler path in acceptance (the relayer path only; the bundler path is not broken, just
  not accepted).
- External audit; on-chain execution-price protection; sandwich resistance for the autopilot.
- Stop-loss (the strategy field is reserved and rejected when set, §7.3).
- More than **one active agent session per account** for meme portfolio, cost basis and the
  autopilot (on-chain inventory stays per key regardless, §5).

### 1.4 Established facts (2026-10-20)

| Fact | Source |
|---|---|
| The AA SDK's hook recognises a launchpad only by the fixed ABI `buy(address,uint256,uint256,uint256,address)` `0x9f01c7de`, `sell(…)` `0x1d87be21`, and an immutable `quoteToken()`; no router, multicall or generic swap | AA-DESIGN §4.2.2–4.2.3, `contracts/src/interfaces/ILaunchpad.sol` |
| A launchpad must satisfy AA-DESIGN §4.4 (no upgrades / external calls / admin pulls; pulls only from `msg.sender` in its call; closed token set with a privileged sell transfer; proceeds to `recipient`; plain balances; exact BUY delta; SELL in full or revert) | AA-DESIGN §4.4, `docs/usage.md` "For launchpad builders" |
| A session can sell only what it bought through `LAUNCHPAD_BUY` (D1, per-key inventory) | AA-DESIGN §4.2.6 |
| `ruleKind NONE` allows any listed selector on any target except a quote asset and the hook | AA-DESIGN `docs/policy.md` |
| The SDK's local simulation replicates the hook call by call, then runs the batch in `eth_call`; it does not read the BUY token's balance before the call | `packages/sdk/src/session/session.ts` |
| (measured 0.1.0) `MemeLaunchpad` is deployed on Mantle Sepolia at `0xB7E6E09Bc2dF2b078A9171abA68663f13E2bc985` (block 45464993), quote MockUSD, treasury `0x660e3265781026a148fa6e5Ccbc8fAa76B79B928`, curve parameters as §4.2 | `deployments/mantle-sepolia.json` (deploy tx, code hashes, smoke txs), PR #8 |
| (measured 0.1.0) Create + approve + dev buy on the predicted address in one batch works, on the full sponsor path and sent directly to the account (§7.2) | `e2e/launchpad/session.fork.test.ts`, PR #5 |
| MockUSD `0xDA74…7526` (6 decimals, mintable by anyone) is deployed on Mantle Sepolia | AA `deployments/mantle-sepolia.json` |
| The sponsor accepts at most one in-flight request per account (`SPONSOR_BUSY`) | AA-DESIGN §5.2 |
| `session grant` writes the session key into the same `MANTLE_AA_HOME` (and password) as the root key; there is no export | `packages/cli/README.md` |
| Merchant Moe's router / factory addresses have no code on Mantle Sepolia; no usable Sepolia DEX was found | `cast codesize` on 5003 |
| OpenClaw skills are `SKILL.md` directories (workspace `skills/` or `skills.load.extraDirs`); cron can push to Telegram; webhooks start isolated runs; injecting into an existing session is an open feature request (#42621) | docs.openclaw.ai |

## 2. Decision log

| # | Decision | Outcome |
|---|---|---|
| D1 | Audience / done | Demo first (TG script + chain links); reference implementation second |
| D2 | Network | Mantle Sepolia only; contracts chain-agnostic |
| D3 | Pricing | Constant-product bonding curve with virtual reserves (pump.fun style); no graduation this iteration, interface leaves room for it |
| D4 | "打新" | Early buys of newly created tokens by an autopilot, not subscriptions |
| D5 | Quote asset | The deployed MockUSD (keeps 0-MNT humans and agents) |
| D6 | Upstream changes | **No hook / account / paymaster change.** The launchpad fits the existing ABI and §4.4. `createToken` and `claimCreatorFees` are granted as `ruleKind NONE` |
| D7 | Agent actions | create, buy, sell, snipe, query, claim; one simple exit strategy (take-profit / max hold; stop-loss deferred) |
| D8 | Autonomy | Command mode and autonomous mode; autonomous is the demo highlight |
| D9 | Root key | Only in the human's local CLI. OpenClaw gets a session-only home (§8.1). TG emergency channel = stretch |
| D10 | Delivery | This repository; depends on the AA packages from npm; ≈1 week, five patch releases 0.1.0–0.1.4 (all in the 0.1 line) + AA 0.1.5; same Linear orchestration workflow as the SDK |
| D11 | Curve lifecycle | 1B supply per token: 800M on the curve, 200M reserved; `Completed` when the curve is sold out, then buy **and** sell stop |
| D12 | Fees | 1% on buys and sells, taken in quote; 50% protocol (immutable treasury), 50% creator, claimable |
| D13 | Create + dev buy | CREATE2 with `salt = keccak256(creator, userSalt)`; the SDK predicts the address so `createToken` + `approve` + `buy` fit one batch |
| D14 | Discovery | Read the chain directly (registry views + event polling); no indexer |
| D15 | Autopilot | A deterministic daemon; the LLM only writes / edits / starts / stops the strategy and reads reports |
| D16 | Strategy | Entry: fixed amount per new token within N s of observing its creation, keyword filter, exclude own tokens, entry-price guard. Exit: take-profit Y% → sell Z%, max hold T; stop-loss deferred. Budget = on-chain remaining limit. Valuation = sell value net of fee vs weighted cost basis (§5) |
| D17 | Packages | `@0xwh1sker/mantle-meme-sdk` + `@0xwh1sker/mantle-meme-cli` (`mantle-meme`), calling `mantle-aa-sdk` programmatically |
| D18 | Policy template | `mantle-meme policy init` generates the grant's `policy.json` |
| D19 | Market | A non-LLM market simulator creates tokens and trades so there is something to snipe |
| D20 | Sponsor | Reuse `mantle-aa sponsor serve`; relayer path; a per-account cross-process send lock in meme-sdk |
| D21 | Session hand-off | AA SDK 0.1.5 adds `mantle-aa session export` (off-chain only) |
| D22 | TG reporting | The autopilot pushes template messages straight to Telegram (Bot API); events also go to JSONL; the LLM explains on demand |
| D23 | Confirmation | In-policy commands execute directly; starting or changing an autopilot strategy needs the agent to restate it and the human to confirm |
| D24 | Skill shape | `skills/mantle-meme/SKILL.md`, no plugin |
| D25 | Contract shape | No owner, all parameters immutable; full supply minted to the launchpad at creation; freely transferable ERC20 + launchpad-only privileged transfer; `Graduated` reserved, no migration or admin path; slippage default 5% (CLI) / 3% (autopilot) |
| D26 | Testing | Foundry unit + fuzz + invariant, fork integration with the real Calibur + hook, one independent security review |
| D27 | Acceptance | Automated (anvil fork in CI + a Sepolia run) + the TG demo script |
| D28 | Demo host | The owner's Mac, `scripts/demo-up.sh` / `demo-down.sh`, separate root and agent homes and passwords |
| D29 | Final buy | The buy that would overrun the curve is **truncated**: it takes only the quote needed for the remaining tokens and completes the curve (§4.3.3). The SDK clamps the approve and the BUY `amountIn` to that amount up front; on-chain truncation is the race fallback |
| D30 | Curve numbers | Virtual token 1,066,666,667, virtual quote 200 mUSD → ≈600 mUSD fills the curve, price ×16 (§4.2) |
| D31 | Exit codes | AA codes pass through; meme codes 40–44 (§6.3) |
| D32 | Docs | This file is the spec of record (English); the Linear project carries a Chinese summary |
| D33 | Cost basis | A local per-agent-home journal of the session's own confirmed submissions is the only source of cost basis; one active session per account (R-8) |
| D34 | Release line | Everything stays in 0.1.x: 0.1.0 contracts → 0.1.1 command mode → 0.1.2 autopilot → 0.1.3 demo (Definition of Done) → 0.1.4 final review + npm publish; review and publish do not block the demo |

## 3. Architecture

```
  Telegram ── OpenClaw (LLM + skills/mantle-meme/SKILL.md)
                 │  shell: mantle-meme … --json          ▲ template pushes (Bot API)
                 ▼                                        │
        ┌──────────────── mantle-meme CLI ───────────────┴──────────┐
        │  create/buy/sell/quote/list/info/watch/portfolio/claim    │
        │  policy init · autopilot start|stop|status|log            │
        └────────────┬──────────────────────────────┬───────────────┘
                     │                              │ autopilot daemon (detached)
              @0xwh1sker/mantle-meme-sdk ◄──────────┘  strategy · watcher · positions
              ABI · address book · calldata · CREATE2 · quotes · discovery · send lock
                     │
              @0xwh1sker/mantle-aa-sdk  AgentSession.simulate / exec (agent home: session key only)
                     │
              mantle-aa sponsor serve (relayer) ──► Mantle Sepolia
                                                     ├─ CaliburEntry + AgentPolicyHook (unchanged)
                                                     ├─ MemeLaunchpad ──CREATE2──► MemeToken × n
                                                     └─ MockUSD (quote)

  Human terminal (root home): mantle-aa account init / session grant|revoke|export / panic
  market-sim (plain EOAs, self-paid gas): createToken / buy / sell on a schedule
```

### 3.1 Repository layout

```
mantle-agentic-meme-launchpad/
├─ contracts/            # Foundry: MemeLaunchpad, MemeToken, tests, deploy scripts
├─ packages/
│  ├─ sdk/               # @0xwh1sker/mantle-meme-sdk
│  └─ cli/               # @0xwh1sker/mantle-meme-cli (bin: mantle-meme)
├─ tools/market-sim/     # market simulator (not published)
├─ skills/mantle-meme/   # OpenClaw skill
├─ e2e/                  # anvil fork suite, Sepolia acceptance script
├─ scripts/              # demo-up.sh / demo-down.sh, pack-check
├─ deployments/          # mantle-sepolia.json (MemeLaunchpad 0xB7E6…c985, measured 0.1.0)
└─ docs/                 # DESIGN.md, usage, acceptance, demo script
```

Stack as in the SDK: Foundry, TypeScript (viem), pnpm 11, Node 24, vitest, biome. The AA
contracts are consumed as deployed addresses plus an ABI; for fork tests the AA repo is a git
submodule pinned to tag `v0.1.4` (later `v0.1.5`) so the real `AgentPolicyHook` is exercised.

## 4. On-chain design

### 4.1 Trust model

The AA trust model (AA-DESIGN §4.0) is unchanged: root fully trusted, session untrusted, sponsor
not a security boundary. This launchpad is a **trusted launchpad** in the sense of AA-DESIGN
§4.4: the human declares that trust by listing it in a policy. It must therefore satisfy every
§4.4 clause; §4.7 maps each clause to this design. MemeToken holders other than accounts (EOAs
of the market simulator) get only ordinary DEX-like guarantees.

### 4.2 Curve

Per token, constant product over virtual reserves:

| Parameter | Value |
|---|---|
| `TOTAL_SUPPLY` | 1,000,000,000 × 10¹⁸ |
| `CURVE_SUPPLY` (sellable) | 800,000,000 × 10¹⁸ |
| `RESERVED_SUPPLY` (future graduation) | 200,000,000 × 10¹⁸ (`TOTAL_SUPPLY − CURVE_SUPPLY`, not a separate parameter) |
| `VIRTUAL_TOKEN_0` | 1,066,666,667 × 10¹⁸ |
| `VIRTUAL_QUOTE_0` | 200 × 10⁶ (200 mUSD) |
| `k` | `VIRTUAL_TOKEN_0 × VIRTUAL_QUOTE_0` |
| `FEE_BPS` | 100 (1%), creator share 50% |

- State per token: `vT` (virtual token reserve), `vQ` (virtual quote reserve), `sold`
  (`CURVE_SUPPLY` − tokens still on the curve), `realQuote` (`vQ − VIRTUAL_QUOTE_0`), `status`.
- **Canonical price** `priceE18 = vQ · 1e36 / vT`: quote base units (6 decimals) per 10¹⁸ token
  base units (one whole token), scaled by 10¹⁸ — ≈ 1.875 × 10¹⁷ at launch, ×16 at completion.
  (Changed 2026-10-20 from `vQ · 1e18 / vT`, which truncates to 0 at launch with these
  parameters.) All arithmetic is in base units; human units are display only.
- Spot price ≈ 1.875 × 10⁻⁷ mUSD per token at start (FDV ≈ 187.5 mUSD); at completion
  `vT ≈ 266,666,667`, `vQ ≈ 800` mUSD, price ×16 (FDV ≈ 3,000 mUSD). Filling the curve takes
  ≈600 mUSD net of fees.
- All parameters are immutable constructor arguments (one launchpad = one parameter set).
- Rounding always favours the curve: `k / x` rounds up when computing the new reserve the trader
  is owed against.

### 4.3 MemeLaunchpad

Non-upgradeable, **no owner**, no `delegatecall`, no external calls other than to MockUSD and its
own MemeTokens.

```solidity
enum Status { None, Trading, Completed, Graduated /* reserved, unreachable this iteration */ }

struct CurveParams {           // reserved supply = totalSupply − curveSupply
    uint256 totalSupply; uint256 curveSupply; uint256 virtualToken0; uint256 virtualQuote0; uint256 feeBps;
}
struct CurveState {            // field order as shipped
    uint256 virtualToken; uint256 virtualQuote; uint256 sold; uint256 realQuote; uint256 priceE18;
    address creator; uint64 createdAt; Status status;
}

constructor(address quoteToken, address treasury, CurveParams memory params);

function quoteToken() external view returns (address);                           // immutable
function treasury() external view returns (address);                             // immutable
// Public immutables: TOTAL_SUPPLY, CURVE_SUPPLY, VIRTUAL_TOKEN_0, VIRTUAL_QUOTE_0, FEE_BPS,
// K (= VIRTUAL_TOKEN_0 × VIRTUAL_QUOTE_0); public state: protocolFees, creatorFees(token).

function createToken(string name, string symbol, string description, string imageUrl, bytes32 salt)
    external returns (address token);
function predictTokenAddress(address creator, bytes32 salt, string name, string symbol)
    external view returns (address);

function buy(address token, uint256 amountIn, uint256 minOut, uint256 deadline, address recipient)
    external returns (uint256 amountOut);                                        // 0x9f01c7de
function sell(address token, uint256 amount, uint256 minOut, uint256 deadline, address recipient)
    external returns (uint256 amountOut);                                        // 0x1d87be21

function claimCreatorFees(address token) external returns (uint256 amount);    // pays msg.sender == creator
function claimProtocolFees() external returns (uint256 amount);                // anyone; pays treasury

function quoteBuy(address token, uint256 amountIn) external view
    returns (uint256 amountOut, uint256 amountInUsed, uint256 feeUsed, bool completes); // exactly what buy() would do now
function quoteSell(address token, uint256 amount) external view returns (uint256 amountOut, uint256 fee);
function curveState(address token) external view returns (CurveState memory); // reserves, sold, status, creator, createdAt, price
function tokenCount() external view returns (uint256);
function tokens(uint256 offset, uint256 limit) external view returns (address[] memory);
function isRegistered(address token) external view returns (bool);
function creatorFees(address token) external view returns (uint256);
```

Events (designed so a watcher needs no extra reads):

```solidity
event TokenCreated(address indexed token, address indexed creator, string name, string symbol,
                   string description, string imageUrl, bytes32 salt);
event Trade(address indexed token, address indexed trader, address recipient, bool isBuy,
            uint256 quoteAmount, uint256 tokenAmount, uint256 fee, uint256 vQ, uint256 vT);
event CurveCompleted(address indexed token, uint256 realQuote);
event CreatorFeesClaimed(address indexed token, address indexed creator, uint256 amount);
event ProtocolFeesClaimed(uint256 amount);
```

Errors (measured 0.1.0, `contracts/src/MemeLaunchpad.sol`): `UnknownToken` (not registered),
`CurveAlreadyCompleted` (status is not `Trading`; decision 2026-10-20: the error is renamed and the
event keeps the name `CurveCompleted`, because solc rejects an error and an event sharing one
identifier), `InsufficientOutput` (`out < minOut`), `ZeroOutput`, `ZeroAmount`, `Expired`,
`NotCreator`, `InvalidParams` (constructor). The CLI maps the first three to exit 42 / 40 / 41
(§6.3).

#### 4.3.1 createToken

- Free; anyone. `salt' = keccak256(abi.encode(msg.sender, salt))`; deploys MemeToken with
  CREATE2 (init code includes name and symbol, hence the `predictTokenAddress` arguments).
  (measured 0.1.0) The init code is `MemeToken.creationCode ++ abi.encode(name, symbol,
  TOTAL_SUPPLY)`, matching the MemeToken constructor `(name, symbol, supply)` (§4.4).
- The new token mints `TOTAL_SUPPLY` to the launchpad; the launchpad registers it, records
  `creator = msg.sender`, `createdAt`, and the initial reserves; status `Trading`.
- **No payment and no tokens to the caller** in this call, so the hook needs no rule for it and
  no inventory is created outside `LAUNCHPAD_BUY`. A dev buy is a separate `buy` in the same
  batch (§7.2).
- Metadata lives in the event only (no IPFS, no on-chain strings beyond the ERC20 name/symbol).

#### 4.3.2 buy

1. `isRegistered(token)` (else `UnknownToken`), `status == Trading` (else
   `CurveAlreadyCompleted`), `block.timestamp ≤ deadline`, `amountIn > 0`.
2. Normal case: `amountInUsed = amountIn`, `feeUsed = ceil(amountInUsed × FEE_BPS / 10_000)`,
   `netUsed = amountInUsed − feeUsed`, `out = vT − ceil(k / (vQ + netUsed))`.
3. If `out ≥ r` (tokens still on the curve) → **truncate** (§4.3.3), which recomputes
   `amountInUsed`, `feeUsed`, `netUsed` and sets `out = r`.
4. `netUsed == 0` or `out == 0` → revert `ZeroOutput`; `out < minOut` → revert
   `InsufficientOutput`.
5. `quote.safeTransferFrom(msg.sender, this, amountInUsed)`; `vQ += netUsed`, `vT −= out`,
   `realQuote += netUsed`, fee ledgers `+= feeUsed` — **only the amounts actually pulled**;
   `token.transfer(recipient, out)` from the launchpad's own balance; emit `Trade`
   (+ `CurveCompleted`).

#### 4.3.3 Final-buy truncation (D29)

When the requested buy would take at least the remaining curve tokens `r` (normative):

- `netNeeded = ceil(k / (vT − r)) − vQ`;
- `amountInUsed` = the smallest `x` with `x − ceil(x · FEE_BPS / 10_000) ≥ netNeeded`
  = `ceil(netNeeded · 10_000 / (10_000 − FEE_BPS))`; `amountInUsed ≤ amountIn` by construction.
  (measured 0.1.0) The closed form is exact and minimal (proof in the `quoteBuy` comment of
  `contracts/src/MemeLaunchpad.sol`, covered by fuzz tests), so the former "`+1` while the
  inequality fails" step never runs and is not implemented;
- `feeUsed = ceil(amountInUsed · FEE_BPS / 10_000)`, `netUsed = amountInUsed − feeUsed`;
  (measured 0.1.0) `netUsed == netNeeded` exactly, so `vQ` ends at `ceil(k / (vT − r))` and
  `vQ · vT ≥ k` still holds;
- `out = r`; reserves, `realQuote` and fee ledgers are updated from `netUsed` / `feeUsed` only;
  exactly `amountInUsed` is pulled; status → `Completed`.

In the normal path the SDK never relies on this: when `quoteBuy` returns `completes = true` it
clamps both the `approve` amount and the BUY calldata `amountIn` to `amountInUsed` (§5), because
the hook refuses an `approve` above the remaining limit (`AgentPolicyHook._checkApprove`) and the
SDK simulation charges the BUY's `amountIn` (`session.ts`). On-chain truncation then only handles
the race where someone else bought between quote and inclusion.

Why this keeps the AA invariants:

- The hook meters quote by the account's **net balance decrease**, so it charges exactly
  `amountInUsed` (AA-DESIGN §4.2.3 after-execute step 2).
- The account's token inflow is exactly `out`, from this purchase only (§4.4 clause 6); the
  hook credits exactly that to inventory.
- The unused allowance (`amountIn − amountInUsed`) stays with the launchpad, a trusted spender
  that pulls only from `msg.sender` within that account's own call (§4.4 clause 2). The next
  `approve` overwrites it; revoke / panic reset it.
- `minOut` is checked against the truncated `out`; the SDK quotes `completes` so the agent can
  expect it.

#### 4.3.4 sell

1. Registered, `status == Trading`, deadline, `amount > 0`.
2. `gross = vQ − ceil(k / (vT + amount))`; `fee = ceil(gross × FEE_BPS / 10_000)`;
   `out = gross − fee`; `out == 0` → revert `ZeroOutput`; `out ≥ minOut`; `vQ −= gross`,
   `realQuote −= gross`, fee ledgers `+= fee`.
3. `MemeToken(token).launchpadTransfer(msg.sender, amount)` — exactly `amount` or revert
   (no approve, no partial fill); update reserves; `quote.safeTransfer(recipient, out)`.

#### 4.3.5 Fees

`fee` is split on every trade: `creatorFees[token] += fee / 2` (floor), `protocolFees += fee −
fee / 2` (the remainder), so the split is exact in integers.
`claimCreatorFees(token)` requires `msg.sender == creator` and pays `msg.sender` (an inflow to
the account; harmless under the hook; granted as `NONE`). `claimProtocolFees()` pays only the
immutable `treasury`.

### 4.4 MemeToken

OpenZeppelin ERC20, 18 decimals, no fee / rebase / hooks / callbacks, freely transferable.
Constructor `(name, symbol, supply)` mints `supply` (`TOTAL_SUPPLY`) to the deployer (measured
0.1.0). `launchpad` immutable (= deployer). One privileged entry `launchpadTransfer(from, amount)`,
callable only by the launchpad, moving exactly `amount` from `from` to the launchpad. No mint
after construction; no burn; no owner.

### 4.5 Lifecycle

`None → Trading` (createToken) `→ Completed` (curve sold out; buy and sell revert with
`CurveAlreadyCompleted`). `Graduated` is declared but unreachable. A position held at completion
cannot be sold through this launchpad (accepted). The CLI and the skill report it as: "Curve completed;
trading is disabled. This v1 launchpad has no migration path, so the position is stranded."
"Graduated" is reserved for a future version that actually migrates.

### 4.6 Graduation reservation

`RESERVED_SUPPLY` and `realQuote` stay in the contract. There is no migration code and **no
admin path** that could move them (that would break §4.4 clause 1). Graduation in a later
iteration means a new launchpad version; tokens completed on v1 are not migrated.

### 4.7 AA-DESIGN §4.4 compliance

| §4.4 clause | Here |
|---|---|
| 1 No upgrade / delegatecall / arbitrary calls / admin pulls | No proxy, no owner, calls only MockUSD and own tokens |
| 2 Pull only from `msg.sender`, only in its call | `safeTransferFrom(msg.sender, …)`; `launchpadTransfer(msg.sender, …)` |
| 3 Closed token set, privileged sell transfer | CREATE2 factory, fixed implementation, `isRegistered`, launchpad-only `launchpadTransfer` |
| 4 Proceeds to `recipient` | buy tokens and sell quote go to `recipient` only |
| 5 Plain balances, immutable `quoteToken()` | MemeToken plain ERC20; MockUSD standard; immutable |
| 6 Exact BUY delta, SELL in full | buy sends only `out`; sell takes exactly `amount`; truncation analysed in §4.3.3 |
| 7 Anti-theft tests | §10 |

## 5. meme-sdk (`packages/sdk`)

- **Address book** `deployments/mantle-sepolia.json` shipped in the package, merged with the AA
  SDK's (`loadDeployments()`).
- **Builders** (pure): `createTokenCall`, `approveCall`, `buyCall`, `sellCall`, `claimCall`,
  `predictTokenAddress` (offline, matches the contract), `defaultDeadline` (now + 300 s, inside
  `maxDeadlineWindow` 600).
- **Quotes**: `quoteBuy` / `quoteSell` via the view functions; `minOut = quote × (1 − slippage)`,
  default 5% (CLI) / 3% (autopilot); a local curve model for the autopilot (checked against the
  views in tests). When `quoteBuy` says `completes`, the builder clamps `approve` and `amountIn`
  to `amountInUsed`; budget checks and displayed cost use the clamped amount.
- **Symbol resolution**: exact, case-insensitive match over the registry (bounded scan of
  `tokens(offset, limit)`); a miss or an ambiguity is exit 42 with at most 10 candidates.
- **Discovery**: `listTokens({offset, limit})`, `curveState`, and `watch({fromBlock})`: an
  `eth_getLogs` poller (2 s) over `TokenCreated` / `Trade` / `CurveCompleted`, deduplicated by
  `(txHash, logIndex)`, tolerant of a load-balanced RPC answering a block behind
  (re-scan a 5-block overlap).
- **Journal** `<agentHome>/meme/journal.jsonl`: one record per confirmed submission of this
  session `{keyHash, txHash, token, side, quotePulled, tokens, fee, blockNumber}`, amounts taken
  from that transaction's own `Trade` logs in the receipt. It is the **only** source of cost
  basis; there is no historical event scan by account (the `Trade` event cannot tell two
  sessions of one account apart).
- **Portfolio** (minimal, read-only, needs no root profile): per token `{balance, session
  inventory (hook.inventory), weighted cost basis incl. buy fees (journal), current sell value net
  of the sell fee (quoteSell), unrealised PnL}`; plus `remainingLimit` for MockUSD, the hook
  summary and the key's expiry (Calibur key settings). No history, realised-PnL ledger or charts.
  Inventory without journal entries has cost basis and PnL `null` ("unknown"). Supported scope:
  one active agent session per account.
- **Executor**: wraps `AgentSession.simulate` + `exec` (relayer). Before sending it takes a
  **cross-process file lock** `<agentHome>/meme/send.lock`, and retries `SPONSOR_BUSY` with
  backoff (max 60 s). One process at a time per account, so the autopilot and a TG command never
  race the sponsor.
- **Errors**: AA SDK errors pass through; meme errors `CurveCompletedError`, `SlippageError`,
  `UnknownTokenError`, `InsufficientBalanceError`, `AutopilotStateError`.
- **Strategy engine** (pure, unit-tested): `(strategy, events, positions, now) → actions`.

## 6. CLI (`mantle-meme`)

Settings reuse the AA CLI's environment (`MANTLE_AA_RPC_URL`, `MANTLE_AA_SPONSOR_URL`,
`MANTLE_AA_HOME`, `MANTLE_AA_KEYSTORE_PASSWORD`); `--agent <name>` picks the session profile
(the only one by default). Telegram push: `MANTLE_MEME_TG_BOT_TOKEN`, `MANTLE_MEME_TG_CHAT_ID`.

### 6.1 Commands

```
mantle-meme policy init   --total <mUSD> --per-day <mUSD> [--expiry 24h] [--out policy.json]
mantle-meme create        --name --symbol [--description] [--image-url] [--dev-buy <mUSD>]
mantle-meme buy           <token> --amount <mUSD> [--slippage 5]
mantle-meme sell          <token> (--amount <tokens> | --percent <n> | --all) [--slippage 5]
mantle-meme quote         <token> (--buy <mUSD> | --sell <tokens>)
mantle-meme list          [--status trading|completed] [--limit 20] [--since <duration>]
mantle-meme info          <token>
mantle-meme watch         [--from-block n]                     # JSON lines on stdout
mantle-meme portfolio
mantle-meme claim         <token> | --all
mantle-meme autopilot     start --strategy <file> | stop | status | log [--since <duration>]
```

`<token>` accepts an address or a symbol (resolved through the registry; ambiguity is a usage
error). Amounts are human units (mUSD, tokens); `--json` output carries both human and base
units and the transaction hash plus explorer link.

### 6.2 policy init

Generates the policy for `mantle-aa session grant`: quote limit on MockUSD (total, per-day,
`periodLength` 86400), `trustedSpenders = [launchpad]`, `maxDeadlineWindow = 600`, permissions:

| Target | Selector | ruleKind |
|---|---|---|
| MockUSD | `approve(address,uint256)` | `ERC20_APPROVE` |
| MemeLaunchpad | `buy(…)` | `LAUNCHPAD_BUY` |
| MemeLaunchpad | `sell(…)` | `LAUNCHPAD_SELL` |
| MemeLaunchpad | `createToken(string,string,string,string,bytes32)` | `NONE` |
| MemeLaunchpad | `claimCreatorFees(address)` | `NONE` |

It also prints the exact `mantle-aa` commands the human runs next (§8.1).

### 6.3 Output and exit codes

Every command supports `--json` (`{ok, command, result}` / `{ok:false, command, exitCode,
error}`), as the AA CLI. AA exit codes pass through unchanged (0, 1, 10–13, 20, 21, 30).
Meme codes:

| Exit | `error.code` | Meaning |
|---|---|---|
| 40 | `CURVE_COMPLETED` | Curve completed; trading is disabled; v1 has no migration path (revert `CurveAlreadyCompleted`) |
| 41 | `SLIPPAGE` | Output below `minOut` (revert `InsufficientOutput`) |
| 42 | `UNKNOWN_TOKEN` | Not registered on this launchpad (revert `UnknownToken`), or a missing / ambiguous symbol (≤ 10 candidates listed) |
| 43 | `INSUFFICIENT_BALANCE` | The account's MockUSD (or token) balance is too low (11 is the policy limit) |
| 44 | `AUTOPILOT_STATE` | Already running / not running |

## 7. Key flows

### 7.1 Command trade (buy)

`quoteBuy` → clamp to `amountInUsed` if `completes` → `minOut` → batch `[approve(MockUSD →
launchpad, amount), buy(token, amount, minOut, now+300, account)]` → lock →
`AgentSession.simulate` → `exec` (relayer) → receipt → journal → result with tx link. Sell is a
single `sell` call, `amount ≤` this session's inventory (checked locally, exit 12 otherwise).

### 7.2 Create with dev buy

`salt` random → `predictTokenAddress(account, salt, name, symbol)` → batch
`[createToken(…, salt), approve(MockUSD, dev), buy(predicted, dev, minOut, …)]`. The hook checks
each call separately: `createToken` is `NONE`; the BUY's balance delta is credited to inventory.
(measured 0.1.0) The hook **does** read the predicted token: `AgentPolicyHook._checkTrade` calls
`balanceOf(account)` on the BUY token in the BUY's `beforeExecute`. This works because Calibur
runs `beforeExecute` / `afterExecute` around **each call**, not once per batch, so the read
happens after `createToken` has deployed the token (call traces on the fork). The sponsor decodes
only the outer `execute` envelope and simulates the whole transaction with `eth_estimateGas`
(`packages/sponsor/src/auth.ts`, `policy.ts`, `server.ts`); `verifyOnChain` reads only the
account, the key and the hook summary. Fork test required on the **full sponsor path** (session
signed batch → `sponsor_relay` → `verifyOnChain` → `eth_estimateGas` → relayer submission), not
only `AgentSession.simulate` (§10). (measured 0.1.0) Spike **PASS** on an anvil fork, on the full
sponsor path and sent directly to the account: the predicted address is the created token, and
the account's balance, hook inventory and `Trade.tokenAmount` all equal the quote
(`e2e/launchpad/session.fork.test.ts`, PR #5). The two-transaction fallback is not needed.
Reusing the same creator / salt / name / symbol collides and reverts; the SDK always draws a random salt.

### 7.3 Autopilot

`autopilot start --strategy s.json` validates the strategy, refuses if a daemon is running
(exit 44), detaches, and writes `<agentHome>/meme/autopilot/{pid, strategy.json, state.json,
events.jsonl}`.

Strategy (JSON; written by the agent from natural language, confirmed by the human):

```json
{
  "entry": { "amountPerToken": "3", "maxAgeSeconds": 60, "keywords": [], "excludeOwn": true,
             "maxOpenPositions": 10, "maxEntryPriceMultiple": 2 },
  "exit":  { "takeProfitPercent": 50, "takeProfitSellPercent": 50,
             "maxHoldMinutes": 30, "stopLossPercent": null },
  "slippagePercent": 3
}
```

- `keywords`: case-insensitive, locale-independent substring match on name or symbol; empty =
  all.
- `stopLossPercent` is reserved: a non-null value is a usage error in this iteration.
- `maxAgeSeconds` is the age **when observed** by the watcher, not at execution.
- `maxEntryPriceMultiple`: skip a token whose spot price already exceeds that multiple of its
  launch price. This avoids obviously pre-pumped launches; it is **not** sandwich protection.

Loop: watch `TokenCreated` → filter (observed age ≤ `maxAgeSeconds`, keywords, not own, open
positions below the cap, entry-price guard) → check `remainingLimit ≥ amountPerToken` and
balance (else emit `budget_exhausted` and stop entering) → re-quote → buy. On every `Trade` of a
held token (and a 10 s tick): the sell value net of fee of the portion to sell (local model,
re-checked with `quoteSell` before sending) vs that portion's journal cost basis → take-profit
(once per position); max hold → sell the remaining inventory. A position whose cost basis is
unknown is not managed (`skipped`, reason `unknown_cost_basis`). Any exit 13 (key expired /
revoked) → emit `session_ended` and stop the daemon. Exit 40 on a held token → mark
`completed`, stop managing it.

Events (`events.jsonl` and Telegram templates): `started`, `stopped`, `bought`, `sold`
(reason: take_profit / max_hold / stop_loss), `skipped` (reason), `budget_exhausted`,
`curve_completed`, `session_ended`, `error`. Telegram push is sent only when the bot env vars are
set; delivery failure never stops trading.

### 7.4 Revoke

The human runs `mantle-aa session revoke --agent trader` locally. The next agent command exits
13; the autopilot stops itself and pushes `session_ended`; the skill tells the human how to
re-grant.

## 8. Agent integration

### 8.1 Session hand-off (AA SDK 0.1.5)

New command in `mantle-7702-sdk` (off-chain only, no contract change):

```
mantle-aa session export --agent <name> --out <agentHome>
```

- Decrypts the session keystore with the root home's password, re-encrypts it with a new
  password (`MANTLE_AA_EXPORT_PASSWORD` or a prompt), writes `<agentHome>/keys/<name>.json` and a
  `<agentHome>/profiles.json` holding **only** that session profile.
- Refuses an `--out` that contains a root profile; never writes a root key.
- No other CLI change. Acceptance: in an exported home, `agent simulate|exec` work; every
  account / session management command (`account init|status|exec|panic`, `session
  grant|update|revoke|list|export`) fails with a usage error for lack of a root profile; the
  exported home contains no root key or root profile. (`keys new|import` stay usable: they create
  a different root, never recover the owner's.) Agent-side status comes from `mantle-meme
  portfolio` (§5), not from the AA CLI.

Human setup, in the root terminal:

```bash
mantle-meme policy init --total 100 --per-day 50 --expiry 24h --out policy.json
mantle-aa account init --grant policy.json --agent trader    # or session grant on an existing account
mantle-aa session export --agent trader --out ~/.mantle-meme-agent
mantle-aa account exec --calls '<MockUSD mint to the account>'
```

OpenClaw's environment sets `MANTLE_AA_HOME=~/.mantle-meme-agent` and its own password.

### 8.2 Skill (`skills/mantle-meme/SKILL.md`)

Frontmatter requires the `mantle-meme` binary. Body:

- Command table, `--json` shapes, and what to say for each exit code (e.g. 11 → remaining
  limit; 13 → ask the human to re-grant locally; 40 → the §4.5 "curve completed … stranded"
  text, never "graduated").
- Capabilities stated honestly: no stop-loss in this iteration; no sandwich protection; the
  contracts are unaudited.
- **Rules:** always `--json`; quote before trading; execute in-policy commands directly and
  report the tx link; restate any autopilot strategy and wait for an explicit "yes" before
  `autopilot start`; never attempt calls outside `mantle-meme`; never ask for or handle a root
  key or password; on a policy refusal, explain it rather than retry another way.
- Worked dialogues: portfolio, create + dev buy, buy/sell by symbol, start/stop autopilot, claim,
  a refused transfer.

Installed by pointing `skills.load.extraDirs` at the repository's `skills/` (or copying it into
the OpenClaw workspace).

### 8.3 Market simulator (`tools/market-sim`)

N plain EOAs (default 3) funded with a little testnet MNT by the operator (they pay their own
gas, outside the sponsor budget) and minted MockUSD. Schedule (configurable): create a token
every 2–5 min; random buys and sells on trading tokens; a "pump" mode that buys one token
hard to move it past take-profit on demand (`market-sim pump <token>`). Not published.

### 8.4 Stretch: Telegram emergency channel

A separate process holding the root key that only accepts `revoke` / `panic` from the owner's
chat ID. Out of scope for this iteration.

## 9. Acceptance

### 9.1 Automated (no LLM)

On an anvil fork of Mantle Sepolia in CI (real Calibur + hook + paymaster, local sponsor), and
once on Mantle Sepolia producing `docs/acceptance.md` with every transaction link:

1. Human: `policy init` → `account init --grant` → `session export` → mint MockUSD; humans and
   agent hold 0 MNT throughout.
2. Agent home only: `create --dev-buy`; `buy`; `sell --percent 50`; `quote`, `list`, `info`,
   `portfolio` correct against chain state and the journal.
   Clamp case: remaining policy limit strictly between `amountInUsed` and the requested amount
   on a completing buy → succeeds, charges exactly `amountInUsed`.
3. market-sim creates a token → autopilot buys within `maxAgeSeconds`; `pump` → take-profit sell;
   max-hold sell; `budget_exhausted` when the limit runs out.
4. A market-sim buy fills the curve through truncation → `Completed`; buy/sell then exit 40.
5. `claim` pays the creator share; `claimProtocolFees` pays the treasury.
6. Refusals: MockUSD `transfer` (10), over-limit buy (11), selling more than bought (12), unknown
   token (42), slippage (41), autopilot double start (44).
7. Human revokes → agent exit 13 → autopilot emits `session_ended` and exits.
8. Concurrency: an autopilot buy and a manual buy at the same moment both complete through the
   send lock, no `SPONSOR_BUSY` surfaced to the user.

### 9.2 Telegram demo script (manual, recorded)

1. Human, local: `policy init`, grant, `session export`, mint mUSD; `scripts/demo-up.sh`
   (sponsor, market-sim, OpenClaw).
2. TG: "我有多少钱、额度还剩多少" → portfolio and remaining limit.
3. TG: "发个币叫 XXX，自己先买 5U" → created + dev buy, tx link.
4. TG: "开打新：每个新币 3U，涨 50% 卖一半，最多拿 30 分钟" → the agent restates the strategy,
   the human confirms, autopilot starts.
5. market-sim launches tokens → instant pushes "bought …".
6. `market-sim pump` → push "take-profit sold …".
7. TG: "领一下手续费" → creator fees claimed.
8. TG: "把 U 全转给 0x…" → refused by policy; the agent explains why.
9. Human, local: `mantle-aa session revoke` → push "session ended, autopilot stopped"; the next
   TG command gets exit 13 and the agent asks for a re-grant.

## 10. Testing and security

- **Contracts (Foundry):** unit; fuzz on buy/sell/truncation math; invariants
  (`runs = 512, depth = 64`, fixed seeds):
  - **C1 solvency** — `quote.balanceOf(launchpad) ≥ Σ realQuote + Σ creatorFees +
    protocolFees` (equality asserted only in a no-donation fixture; donations make it strict),
    and selling every outstanding curve token returns at most `realQuote`; covers truncating buys;
  - **C2 no free round trip** — buy then sell (any split) never returns more than paid;
  - **C3 fee conservation** — collected = claimed + claimable, split exactly;
  - **C4 supply** — `TOTAL_SUPPLY` constant; launchpad balance = unsold curve + reserved;
  - **C5 lifecycle** — no trade after `Completed`; `Graduated` unreachable;
  - **C6 truncation** — the completing buy pulls `amountInUsed ≤ amountIn`, delivers exactly
    the remainder, books only `netUsed` / `feeUsed`, and `quoteBuy` returns the same values.
- **Dust:** one quote base unit; fees of 1, 2 and 3 units (split); final-buy dust overpayment;
  `quoteBuy` / `quoteSell` at zero output; `ZeroOutput` reverts.
- **§4.4 clause 7 anti-theft:** a third party calling `sell` cannot reduce a victim's balance;
  direct `launchpadTransfer` is refused; no entry pulls a victim's assets; `claimCreatorFees` by
  a non-creator reverts; CREATE2 address cannot be squatted by another creator (salt binds
  `msg.sender`).
- **Fork integration** with the real AA contracts: create + dev buy in one batch credits
  inventory; truncated final buy meters exactly `amountInUsed`; claim is `NONE`-allowed and
  harmless; every refusal of §9.1 item 6 also holds when submitted on chain bypassing the SDK.
- **TypeScript:** builders vs contract (address prediction, quotes, clamp), strategy engine
  table tests (keywords: empty, name, symbol, case, several, none; entry guard; stop-loss
  rejected), journal and unknown cost basis, watcher dedup / overlap, send lock across two
  processes, CLI exit-code mapping.
- **Must not be cut** under schedule pressure: final-buy fuzz / invariants, real-hook
  integration, sponsor-path create + buy, inventory attribution, revoke + allowance reset.
- **Security review:** a contract review checkpoint in 0.1.0, before the Sepolia deployment
  (measured 0.1.0: **PASS**, `docs/reviews/0.1.0.md`; two Low findings: CR-01 invariant
  coverage, fixed in PR #7; CR-02 overflow on oversized buy budgets, deferred in
  `docs/DEFERRED_ISSUES.md`);
  the final independent review in 0.1.4, after the demo recording in 0.1.3 (D34). README and demo
  material state "POC, not audited"; sponsor hot wallet and market-sim wallets hold testnet
  amounts only.

## 11. Releases

| Release | Content | Gate |
|---|---|---|
| AA SDK **0.1.5** (in `mantle-7702-sdk`, its own release process) | `mantle-aa session export` (+ tests, docs, npm publish) | Before meme 0.1.1 |
| **0.1.0** — contracts | Repo scaffold + CI; MemeLaunchpad / MemeToken + full Foundry suite (unit, fuzz, invariants C1–C6, dust, anti-theft); meme-sdk builders, CREATE2 prediction, quotes; fork integration with the real AA contracts incl. the create + dev-buy spike on the full sponsor path; contract review checkpoint; Sepolia deployment + address book | CI green; review checkpoint PASS; Sepolia deployed |
| **0.1.1** — command mode | meme-sdk discovery, symbol resolution, send lock, journal, portfolio; `mantle-meme` all non-autopilot commands + exit codes; `policy init`; consumes AA 0.1.5 (exported agent home) | Fork e2e of §9.1 items 1, 2, 5, 6 (minus 44) |
| **0.1.2** — autopilot | Strategy engine + daemon, Telegram push, `autopilot *`; market-sim; full anvil e2e §9.1 in CI; Sepolia acceptance run → `docs/acceptance.md` | §9.1 green on fork and Sepolia |
| **0.1.3** — agent + demo | `SKILL.md`; `demo-up/down.sh`; docs (usage, demo script); TG demo §9.2 recorded | **Definition of Done** |
| **0.1.4** — review + publish | Final independent security review (and fixes); npm publish `@0xwh1sker/mantle-meme-{sdk,cli}` | Review PASS; packages on npm. Does not block 0.1.3 |

All releases stay in the 0.1 line; each is a patch step.

Process: the SDK's Linear orchestration workflow (release document, issue dependency graph,
review gates, release branches).

### 11.1 Upstream (AA SDK) collaboration

- **Channel:** Linear, in the `mantle-7702-sdk` project and its own release process. This
  repository never patches, vendors or forks AA SDK code (no `node_modules` patches, no copied
  sources); it consumes published versions only, pinned `~0.1.5` once 0.1.5 ships.
- **Blocking needs** become an issue in an SDK release, written self-contained (spec +
  acceptance criteria, not only a link here), with a cross-project *blocks* relation to the
  meme issue that needs it. First instance: SDK Release 0.1.5, `mantle-aa session export`
  (§8.1, WHI-2036) blocks meme 0.1.1 (WHI-2047).
- **Non-blocking feedback** goes to the SDK project's Backlog with the label
  `from:meme-launchpad`, outside any release until the SDK owner schedules it (first: WHI-2038, WHI-2039).
- **Not** `docs/DEFERRED_ISSUES.md` of the SDK: that file records debt deferred by the SDK's
  own reviews.
- **During implementation**, a meme implementer who finds a new SDK need records it on its meme
  issue; the orchestrator opens the SDK issue (blocking or backlog, as above) and the meme side
  waits for the release or uses a documented workaround.

## 12. Risks and open items

| Item | Handling |
|---|---|
| Create + buy-on-predicted-token in one batch may trip the SDK simulation, the sponsor or the hook | Closed (measured 0.1.0): spike PASS on the full sponsor path and direct (§7.2); the two-transaction fallback is not needed |
| Journal loss or a second session | Cost basis `null`, autopilot leaves the position alone; sell sizing stays on-chain; one session per account is the supported scope |
| Public RPC lag breaks sniping latency or the watcher | Overlap re-scan, dedup; configurable RPC URL |
| Sponsor budget drained by autopilot | Sponsor daily budget + per-account gas cap; the policy caps principal, not gas |
| Positions stranded at `Completed` | Accepted; reported to the user; graduation is a later version |
| Truncation leaves an allowance | Analysed in §4.3.3; trusted spender only; reset on revoke |
| OpenClaw version drift | Skill only, no plugin; pin the tested OpenClaw version in docs |
| Unaudited contracts | Invariants, anti-theft tests, review (0.1.0 checkpoint PASS, `docs/reviews/0.1.0.md`; CR-02 deferred in `docs/DEFERRED_ISSUES.md`), testnet only |

## Appendix A: Design interview record (2026-10-20)

Four rounds with the owner; every recommendation was accepted.

- **Round 1:** D1–D10 (audience, network, bonding curve, 打新 = sniping, MockUSD, no hook
  change, action set, command + autonomous, root key local, repository / workflow).
- **Round 2:** D11–D20 and the TG emergency channel as stretch (curve lifecycle, fees, CREATE2
  dev buy, on-chain discovery, deterministic autopilot, strategy set, packages, policy
  template, market simulator, sponsor + send lock).
- **Round 3:** D21–D28 (session export in AA 0.1.5, direct TG push, confirmation rule, skill
  shape, contract details, testing, acceptance, demo host, release split).
- **Round 4:** D29–D32 (final-buy truncation replacing "revert on overrun", curve numbers, exit
  codes, documentation).

## Appendix B: Independent design review record (2026-10-20)

Reviewer: independent REVIEWER agent `mantle/gpt-6-astra` (high), read-only, checked against the
upstream source at `mantle-7702-sdk` v0.1.4. Four rounds. Round 1 verdict: CHANGES REQUIRED;
round 3: APPROVE WITH CHANGES (R-8 open); **final: APPROVE**.

| ID | Severity | Topic | Disposition |
|---|---|---|---|
| R-1 | Blocker | Final-buy fee computed on the requested amount but only `amountInUsed` pulled → insolvency (≈0.94 mUSD in a 700-mUSD example) | Accepted: normative equations, fees and reserves from the pulled amount only, C1/C6 cover truncation (§4.3.2–4.3.3, §10) |
| R-2 | Major | `approve(amountIn)` above the remaining limit reverts before truncation helps; SDK simulation charges the BUY's `amountIn` | Accepted: SDK clamps approve and `amountIn` to `amountInUsed` when `completes`; on-chain truncation = race fallback; clamp test (§4.3.3, §5, §9.1) |
| R-3 | Major | `account status` / `session list` need a root profile, so they cannot run in an exported home | Accepted with author's fix: AA 0.1.5 stays export-only; acceptance reworded to account/session management commands; agent-side status from `mantle-meme portfolio` (§8.1) |
| R-4 | Minor | Dust trades charge a fee for zero output; odd-fee split | Accepted: `ZeroOutput`; creator floor half, protocol remainder; dust tests (§4.3, §10) |
| R-5 | Major | Price unit undefined across 6 / 18 decimals; entry price and cost basis undefined | Accepted: `priceE18`; weighted cost basis incl. fees; triggers on net sell value (§4.2, §5, §7.3) |
| R-6 | Suggestion | Autopilot exposed to sandwiching / stale prices | Accepted + entry guard `maxEntryPriceMultiple`, autopilot slippage 3%, re-quote, documented as not sandwich-resistant (§7.3) |
| R-7 | Minor | "Graduated, awaiting migration" implies a migration path that does not exist | Accepted: "curve completed … stranded" wording in CLI and skill (§4.5, §8.2) |
| R-8 | Major | `Trade` events cannot attribute buys to a session key, so per-session cost basis is undefined | Accepted: one active session per account is the supported scope; a local journal of the session's own submissions is the only cost-basis source; unknown → `null`, not managed by the autopilot (§1.3, §5, D33) |

Also settled in review:

- **Sponsor path (Q-a):** the sponsor decodes only the outer envelope and simulates with
  `eth_estimateGas`; create + approve + buy on a predicted address is not blocked off-chain. The
  0.1.0 spike must run the full sponsor path. (measured 0.1.0) Spike PASS on the full sponsor
  path and direct. On-chain, the hook does read the predicted token (in the BUY's
  `beforeExecute`); it is safe because Calibur runs the hooks around each call, after
  `createToken` deployed the token (§7.2).
- **On-chain shape (Q-b):** CREATE2 salt bound to `msg.sender`, full supply minted to the
  launchpad, `Completed` stopping both sides and no admin path for the reserve are compatible
  with AA-DESIGN §4.4.
- **Scope (Q-c):** stop-loss deferred; keyword filter, minimal portfolio and exact symbol
  resolution kept (author push-back, reviewer agreed); final review and publish moved after the demo (D34; later split into 0.1.3 / 0.1.4); the
  must-not-cut test list in §10.
