# Preflight Proofs Playground

A one-page sales/investor demo that runs the full Preflight flow end to end:

1. **Step 1 — Decision.** Pick a proposed agent action. Preflight evaluates it against a compiled 7-clause spending policy and returns SAT (allowed) or UNSAT (blocked), along with a per-clause breakdown.
2. **Step 2 — Cryptographic receipt.** The decision is sealed into a SNARK on the backend. The browser then calls the public `/v1/verifyProof` endpoint **directly** (no proxy, no API key) so a viewer can confirm in DevTools that the verification is genuinely independent of this site's backend.

The page is deliberately one URL, one scenario, three presets, and one verify button. It is meant to be paste-able into a VC chat or a prospect's email and have them watch a real proof generate and verify in their browser in well under a minute.

---

## What you see in the UI

- **Header** — Eyebrow, H1 ("Cryptographic receipts for AI agent actions."), one paragraph framing the problem and the audit-trail outcome. ICME logo links to `icme.io`.
- **Left column (sticky)** — collapsible Active Policy (7 clauses), three preset action buttons with expected SAT/UNSAT badges, "Talk to the founders" Calendly card, and a "Going deeper" stack of three further disclosures (what's in the receipt vs. what isn't, run on your own policy, what changes for a confidential policy).
- **Right column (tabbed)** — three tabs:
  - **Decision** — SAT/UNSAT badge, per-clause evaluation, "How SAT/UNSAT is computed" explainer (parse → Z3 → AR), then a clearly separated "Step 2 of 2 · Cryptographic receipt" block with proof_id, SNARK generation status, the verify-independently button, inline verify badges, and "How the receipt is sealed" + SNARK asymmetry disclosures.
  - **API call** — collapsible request/response payloads for both `POST /v1/checkIt` (via this site's proxy) and `POST /v1/verifyProof` (browser → ICME directly), plus copy-pasteable `curl` snippets.
  - **Receipt** — full signed JSON receipt and a field-by-field annotation.

The visual language follows `docs.icme.io`: light theme on `#F5F5F4`, primary blue `#346DDB`, success green `#00C950`, danger red `#FB2C36`.

## Architecture

- `app/page.tsx` — the entire UI. Two-column responsive layout, tabbed right column, reusable `Disclosure` component, polling hook for SNARK readiness.
- `app/api/check/route.ts` — Next.js Edge route that proxies `POST /v1/checkIt`. Holds `ICME_API_KEY` server-side. Handles both `application/json` and `text/event-stream` upstream responses, normalizes `result` / `z3_result` to fail-closed UNSAT, and remaps `zk_proof_id` to `proof_id`.
- `app/api/proof-status/route.ts` — Next.js Edge route that proxies `GET /v1/proof/:id` so the browser can poll readiness. Returns `{ready: false}` while the SNARK is still being generated and `{ready: true}` when it's available. Never returns the proof body itself — only readiness — to keep the verify button's call to `/v1/verifyProof` genuinely independent.
- `app/globals.css` — light palette + ICME brand variables.
- `scripts/compile-policy.ts` — one-time policy compile via `/v1/makeRules`. See "Avoiding the $3 trap" below.
- `policies/spending.txt` — the policy text. SHA-256 of this file is the cache key.
- The verify-independently button calls the public `https://api.icme.io/v1/verifyProof` endpoint **directly from the browser**, with no auth and no proxy.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in ICME_API_KEY in .env.local
```

Required environment variables (set in `.env.local` for local dev, in your host's dashboard for production):

| Variable                   | Scope  | What it does                                              |
| -------------------------- | ------ | --------------------------------------------------------- |
| `ICME_API_KEY`             | server | Used by both API routes. Never shipped to the browser.    |
| `ICME_BASE_URL`            | server | Defaults to `https://api.icme.io/v1`. Override for staging. |
| `NEXT_PUBLIC_POLICY_ID`    | client | Compiled policy id (output of `npm run policy:compile`).  |
| `NEXT_PUBLIC_CALENDLY_URL` | client | Link behind the "Talk to the founders" button.            |

## Compile the policy (one-time, ~$3)

`/v1/makeRules` charges 300 credits ($3) per call and there is no recovery endpoint if the SSE parser fails. The compile script defends against this with three layers:

1. **SHA-256 cache.** Re-running with the same policy text is a no-op. The `policy_id` is read from `.policy-cache/<hash>.json`.
2. **Raw SSE log on disk.** Every byte of the stream is appended to `.policy-cache/raw-sse-<timestamp>.log` *before* parsing. If every parser strategy fails, you can still recover the `policy_id` by `grep policy_id .policy-cache/raw-sse-*.log`.
3. **Three independent parsers** (clean JSON, SSE `data: ` prefix, raw JSON line) all watching for a `policy_id` field.

Run it:

```bash
npm run policy:compile
```

The script will print the SHA-256, warn that the call is non-refundable, and prompt for confirmation. After success it writes the `policy_id` to:

- stdout
- `.policy-cache/<hash>.json`
- `.env.local` (sets `NEXT_PUBLIC_POLICY_ID=...`)

If you already have a `policy_id` from a previous compile, just paste it into `.env.local` as `NEXT_PUBLIC_POLICY_ID=...` and skip this step.

## Run locally

```bash
npm run dev
# open http://localhost:3000
```

## Hosting

This app **cannot run on GitHub Pages** because the API routes need a server runtime. Pick one of:

- **Vercel (recommended)** — push to GitHub, import in Vercel, set the four env vars in the dashboard, deploy. Zero config.
- **Cloudflare Pages / Netlify** — same story; both support Next.js with API routes.
- **Static export + external proxy** — set `output: 'export'` in `next.config.mjs` and host the two API routes on Cloudflare Workers / a small VPS. Works, but adds CORS config and a moving part.
- **Static export with no proxy** — *not recommended.* You would have to either embed the API key in client JS (immediately scrape-able, billing exposure) or make visitors paste their own key (kills the frictionless demo).

For Vercel:

1. Push to GitHub.
2. Import in Vercel.
3. Set env vars: `ICME_API_KEY`, `ICME_BASE_URL` (optional), `NEXT_PUBLIC_POLICY_ID`, `NEXT_PUBLIC_CALENDLY_URL`.
4. Deploy.

## What is intentionally not here

- Email gate — gated demos kill paste-ability.
- Payment / `createUserCard` flow — add when someone asks how to buy.
- Other scenarios (refunds, prompt injection, data access) — add when prospects ask.
- Slack alerts — add when there's a domain log to react to.
- Cached example proofs — every click is a real proof, ~$0.01 each.
- Rate limiting — per-check cost is ~$0.01 and `policy_id` can't be exfiltrated to other endpoints, so this is a non-problem at sales-demo traffic levels.

## Cost model

- One-time setup: ~$3 (one `makeRules` call, cached forever after).
- Per visitor: ~$0.01–$0.03 (one `checkIt` per preset clicked).
- Per `verifyProof` call: free.
- 1,000 visitors clicking an average of 2 presets each: ~$20 total.

## Operational notes from the nanopayments post-mortem

These behaviors are baked into this codebase; flagging them so future maintainers don't re-learn them the hard way.

- `/v1/checkIt` returns `text/event-stream`, not JSON. The proxy handles both content types.
- `/v1/checkIt` may return `result: "AR uncertain"`. The proxy falls back to `z3_result`, then fail-closes to UNSAT.
- The proof field is named `zk_proof_id` in `checkIt` responses but `proof_id` everywhere else. The proxy normalizes to `proof_id`.
- `/v1/checkIt` returns the `proof_id` quickly but the SNARK itself is generated asynchronously on the backend. The UI polls `/api/proof-status` (which proxies `GET /v1/proof/:id`) and only enables the verify button once the proof is ready.
- `/v1/verifyProof` is single-use. Calling it twice on the same proof returns HTTP 409. The UI surfaces this as a clear message rather than a generic error.
- `/v1/makeRules` has no idempotency key and no `GET /v1/policies` endpoint. The compile script's SHA-256 cache is the only thing standing between you and another $3 charge.
