# Deferred issues

Known, accepted debt deferred by reviews. Each entry states the consequence, why it was
deferred and when to revisit it.

## CR-02 — Oversized buy budgets overflow before final-buy truncation

- **Severity:** Low (non-blocking)
- **Source:** [Contract review — 0.1.0](reviews/0.1.0.md), finding CR-02
- **Location:** `contracts/src/MemeLaunchpad.sol` (`quoteBuy`, `_fee`)
- **Issue:** `quoteBuy` computes the fee on the full requested budget before deciding
  whether the purchase truncates to the completion cost. For oversized budgets (≳1e73 quote
  base units) the checked multiplication `amountIn * FEE_BPS` panics (`Panic(0x11)`) before
  the final-buy truncation branch is reached.
- **Consequence:** a safe revert. `quoteBuy` and `buy` share the same code path, so quote and
  execution stay consistent; there is no state damage.
- **Why deferred:** the contract is immutable after the 0.1.0 deployment; the SDK clamps
  `amountIn` to `amountInUsed` for completing buys; real budgets are around 1e9 base units.
- **Revisit:** in a future launchpad version — compute the completion cost before any
  arithmetic on the requested budget.
