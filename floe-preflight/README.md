# Verifiable Floe — Preflight demo

A one-page demo that runs Preflight (by ICME) end-to-end against three Floe-specific agent actions:

1. **Step 1 — Decision.** Pick a Floe policy, pick a proposed Floe agent action. Preflight evaluates it against the compiled policy and returns SAT (clear to execute) or UNSAT (block before any side effect), with a per-clause breakdown.
2. **Step 2 — Cryptographic receipt.** The decision is sealed into a SNARK on the backend. The browser then calls the public `/v1/verifyProof` endpoint **directly** (no proxy, no API key) so a viewer can confirm in DevTools that the verification is genuinely independent of this site's backend.
3. **Step 3 — Integrate.** A copy-pasteable `curl` / TypeScript / Python snippet shows a Floe engineer exactly the request that produced the receipt they just watched.

This is a sales demo paired with a one-pager for Floe Labs. The page is meant to be paste-able into a chat or email and have someone watch a real proof generate and verify in their browser in well under a minute.

---

## The three Floe policies

Each policy is grounded in Floe's actual API surfaces (see floe-labs.gitbook.io/docs).

- **Verifiable agent borrow** — guards `instant_borrow` against the on-chain `OperatorPermission` (borrow limit, rate cap, expiry, onBehalfOf restriction), plus a 5% volatility halt, parent-budget ceiling, and 30-day lender wallet age.
- **Verifiable x402 spend** — guards `/v1/proxy/fetch` against per-call cap, `session_spend_remaining`, 24h cumulative cap, sanctions screening on `payTo`, principal allowlist, Base mainnet (chainId 8453), and USDC asset.
- **Verifiable liquidation** — guards `liquidateLoan(loanId)` against loan underwater state, oracle freshness (≤ 3600s), price deviation (< 1500 bps), profit floor (`> MIN_PROFIT_USD + 2 × gas`), no pending repayment intent, sanctions on the liquidator, and L2 sequencer up ≥ 3600s.

Each policy ships with three presets (one SAT, two UNSAT) chosen to match the lender, agent operator, and liquidator-bot personas.

## What you see in the UI

- **Header** — Eyebrow ("Verifiable Floe · Preflight demo"), H1 ("Cryptographic receipts for every Floe agent action."), one paragraph framing borrow / x402 / liquidation and the audit-trail outcome. Health-status dot. ICME logo links to `icme.io`.
- **Policy library** — three Floe policies (above), switchable mid-call.
- **Left column (sticky)** — collapsible Active Policy with all clauses, three preset action buttons with expected SAT/UNSAT badges, "Talk to the founders" Calendly card, and a "Going deeper" stack of further disclosures.
- **Right column (tabbed)** — Decision / API call / Receipt / Integrate.

Visual language follows `docs.icme.io`: light theme on `#F5F5F4`, primary blue `#346DDB`, success green `#00C950`, danger red `#FB2C36`.

## Replay mode

If a policy's compiled `policy_id` env var is unset (or you press `r`), that policy's presets play back from a pre-recorded happy-path trace. The UI labels this clearly with a "REPLAY" pill. The browser-side `/v1/verifyProof` call is real either way.

## Architecture

- `app/page.tsx` — the entire UI.
- `app/policies-data.ts` — single source of truth for the three Floe policies, their clauses, presets, per-clause evaluations, replay payloads, and presenter notes.
- `app/snippets.ts` — `curl` / TS / Python snippet generators.
- `app/api/check/route.ts` — Edge route proxying `POST /v1/checkIt`.
- `app/api/proof-status/route.ts` — Edge route proxying `GET /v1/proof/:id`.
- `app/api/health/route.ts` — Edge route used by the status dot.
- `scripts/compile-policy.ts` — one-time policy compile via `/v1/makeRules`.
- `policies/verifiable-borrow.txt`, `policies/verifiable-x402.txt`, `policies/verifiable-liquidation.txt` — the three policy texts. SHA-256 of each file is its cache key.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in ICME_API_KEY in .env.local
```

Required and optional environment variables:

| Variable                              | Scope  | What it does                                                              |
| ------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `ICME_API_KEY`                        | server | Used by all API routes. Never shipped to the browser.                     |
| `ICME_BASE_URL`                       | server | Defaults to `https://api.icme.io/v1`.                                     |
| `NEXT_PUBLIC_POLICY_ID_BORROW`        | client | Compiled policy id for verifiable-borrow.                                 |
| `NEXT_PUBLIC_POLICY_ID_X402`          | client | Compiled policy id for verifiable-x402.                                   |
| `NEXT_PUBLIC_POLICY_ID_LIQ`           | client | Compiled policy id for verifiable-liquidation.                            |
| `NEXT_PUBLIC_CALENDLY_URL`            | client | Link behind the "Talk to the founders" button.                            |
| `NEXT_PUBLIC_SITE_URL`                | client | Canonical URL for OG / Twitter image absolute paths.                      |

If a per-policy slug is left blank, that policy still appears but its presets play back as "REPLAY".

## Compile each policy (one-time, ~$3 each)

```bash
npm run policy:compile -- --policy verifiable-borrow
npm run policy:compile -- --policy verifiable-x402
npm run policy:compile -- --policy verifiable-liquidation
```

## Run locally

```bash
npm run dev
# open http://localhost:3000
```

## Hosting

Deployed at `floe-preflight.vercel.app`. Vercel: push to GitHub, import, set env vars, deploy.
