# Verifiable Floe

**Cryptographic receipts for every paid call, every borrow, every liquidation.**

ICME's Preflight API drops in next to Floe's existing endpoints (`/v1/x402/estimate`, `/v1/credit/instant-borrow`, `liquidateLoan`) and emits a SNARK receipt every time an agent does anything that touches money. Two HTTPS calls (`/v1/checkIt` and `/v1/verifyProof`), no new infra, no new trust assumptions.

---

## What's actually new here

The Floe protocol enforces. Preflight records. Smart contracts give you a "no" via revert. Preflight gives you a "yes" with a SNARK. That positive evidence is what makes a Floe action shareable, auditable, and disputable without ever touching an RPC.

Beyond evidence, Preflight extends what Floe can enforce. The on-chain `OperatorPermission` is coarse by design (`borrowLimit`, `maxRateBps`, `expiry`, `onBehalfOfRestriction`). Volatility-aware LTV, time-of-day windows, multi-agent budget aggregation, sanctions-fresh checks, lender-wallet-age gates — none of these can live in a smart contract. They have to live in policy. Floe is the API layer every agent passes through. That is the right place for verifiable policy to sit.

The result is a **Floe-native dispute-resolution primitive**: every agent action ships with a cryptographic receipt of the conditions at the moment of execution. Lenders, borrowers, liquidators, and regulators all get the same artifact. None of them have to trust the agent, the AI vendor, the runtime, or even Preflight itself.

---

## #1 Verifiable agent borrow

Before an agent calls `instant_borrow`, Preflight runs a check on the request and emits a receipt.

**Value prop A — positive evidence.** The contract reverts if `OperatorPermission` is violated. Preflight records the inverse: a SNARK that says "this borrow request was inside the envelope at the moment of attempt." Audit trail without an RPC call. The artifact a lender's risk team can verify in milliseconds.

**Value prop B — checks the contract cannot do.** Volatility-halt (don't borrow if collateral asset moved ±5% in the last hour). Multi-agent aggregation (total across this principal's agents must stay under their parent budget). Time-of-day windows. Lender-wallet-age floors. None of these fit on-chain. They live in policy and produce a receipt.

*Why it matters (lender first):* lenders price agent loans against an unknown counterparty. With Verifiable Borrow, every loan in the lender's book ships with a verifiable record of the conditions at origination. Underwriting becomes auditable end-to-end.

---

## #2 Verifiable x402 spend

Floe's `/v1/x402/estimate` already returns `priceRaw, payTo, network, sessionSpendRemaining` before payment. Preflight wraps a rule layer on top: per-call cap, daily cap, OFAC screen on `payTo`, allowlist membership. SAT → `/v1/proxy/fetch`. UNSAT → blocked, no payment, receipt names the failing clause.

*Why it matters (lender first):* the lender funding an agent's working capital can now require a Preflight receipt for every paid API call against that capital. Spending governance becomes a property of the credit line, not a promise.

---

## #3 Verifiable liquidation

Before a liquidator bot calls `liquidateLoan(loanId)`, Preflight checks: `currentLtv > maxLtvBps` (loan is genuinely underwater), `oracleDeviation < 1500 bps` (not in circuit-breaker territory), `expectedProfit > MIN_PROFIT_USD + 2 × gasCost` (not a vanity grief liquidation). SAT → liquidate. UNSAT → wait. Receipt becomes evidence the liquidator acted in good faith.

This is the dispute-resolution primitive in concrete form. Today, a borrower who feels marginally liquidated has Discord. With Verifiable Liquidation, they have a SNARK to challenge — or no SNARK, which is itself the signal.

*Why it matters (lender first):* lenders today bear the reputational cost of bad liquidations on their book. With verifiable liquidation, they can require liquidator bots they fund or whitelist to ship a receipt with every action.

**Decision for Alex — pilot scope:**

- **Path A (ship in 30 days):** Preflight is opt-in for liquidator bot operators. Bots run it for the receipt. Lighter integration, weaker enforcement, easier to land.
- **Path B (the headline):** Floe makes valid Preflight receipts a presumption of legitimacy at the protocol level. Liquidations with receipts are presumed good-faith. Liquidations without are subject to a borrower challenge window or fee penalty.

Not mutually exclusive. A is the pilot. B is the investor story.

---

## Integration shape

Two endpoints. `POST /v1/checkIt` returns SAT/UNSAT and a `proof_id`. `POST /v1/verifyProof` is public, no API key, returns true/false in milliseconds. Drops in next to `/v1/x402/estimate`, `/v1/credit/instant-borrow`, and the `liquidateLoan` SDK call. Policies are compiled once (a few minutes, ~$3) and reused forever.

---

*Phase 2: portfolio-level zkML lender compliance via JOLT Atlas. Prove an institutional lender's underwriting model held across every loan in the book, without revealing the model or the borrowers.*

---

**Demo:** [floe-preflight.vercel.app](https://floe-preflight.vercel.app) *(placeholder)*

**Ask:** 30-min walkthrough. We come back with a pilot scope (Path A or B for #3), a fixed timeline, and a single integration PR against your facilitator.
