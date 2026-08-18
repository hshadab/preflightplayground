# Preflight Proofs Playground

A one-page B2B sales demo that runs the full Preflight flow end to end:

1. **Step 1 — Decision.** Pick a policy, pick a proposed agent action. Preflight evaluates it against the compiled policy and returns SAT (allowed) or UNSAT (blocked), with a per-clause breakdown.
2. **Step 2 — Cryptographic receipt.** The decision is sealed into a proof on the backend. The browser then calls the public `/v1/verifyProof` endpoint **directly** (no proxy, no API key) so a viewer can confirm in DevTools that the verification is genuinely independent of this site's backend.
3. **Step 3 — Integrate.** A copy-pasteable `curl` / TypeScript / Python snippet shows the buyer's engineer exactly the request that produced the receipt they just watched.

The page is meant to be paste-able into a VC chat or a prospect's email and have them watch a real proof generate and verify in their browser in well under a minute. It is **not** a self-serve product — it is a tool for live sales calls with technical buyers.

---

## What you see in the UI

- **Header** — Eyebrow, H1 ("Cryptographic receipts for AI agent actions."), one paragraph framing the problem and the audit-trail outcome. Health-status dot (green = upstream alive, amber = degraded, grey = unknown). ICME logo links to `icme.io`.
- **Policy library** — Four built-in policies the presenter can switch between mid-call:
  - **Spending** — agent budget caps, vendor allow-list, fraud signals.
  - **Refunds** — refund caps, customer caps, reason-code allow-list, human approval thresholds.
  - **Data access** — PII handling, sensitive-field elevation, bulk-export caps, third-party DPAs.
  - **Procurement** — supplier master + sanctions, MSA / COI / DPA gates, contract-template drift, segregation of duties (SOX-flavored, Leah / Coupa / Zip / Ariba shape).
  Each policy ships with three presets (one SAT, two UNSAT) chosen to provoke "huh, I have that exact rule" reactions from the corresponding buyer persona.
- **Left column (sticky)** — collapsible Active Policy with all clauses, three preset action buttons with expected SAT/UNSAT badges, "Talk to the founders" Calendly card, and a "Going deeper" stack of further disclosures (what's in the receipt vs. what isn't, run on your own policy, what changes for a confidential policy, audit trail downstream).
- **Right column (tabbed)** — four tabs:
  - **Decision** — SAT/UNSAT badge, per-clause evaluation, "How SAT/UNSAT is computed" explainer (parse → Z3 → AR), then a clearly separated "Step 2 of 2 · Cryptographic receipt" block with `proof_id`, proof generation status, the verify-independently button, inline verify badges, and "How the receipt is sealed" + proof asymmetry disclosures.
  - **API call** — collapsible request/response payloads for both `POST /v1/checkIt` (via this site's proxy) and `POST /v1/verifyProof` (browser → ICME directly).
  - **Receipt** — full signed JSON receipt and a field-by-field annotation, plus a one-click "Share this receipt" button (URL-hash, never hits a server).
  - **Integrate** — `curl` / TypeScript / Python snippets pre-populated with the *current scenario's* `policy_id`, `action`, and (when available) `proof_id`, plus an architecture diagram of the three boxes (Your stack / Preflight / External).

The visual language follows `docs.icme.io`: light theme on `#F5F5F4`, primary blue `#346DDB`, success green `#00C950`, danger red `#FB2C36`.

## Presenter hotkeys

These let you drive the demo without leaving the keyboard during a call.

| Key   | What it does                                                                       |
| ----- | ---------------------------------------------------------------------------------- |
| `?`   | Toggle the presenter notes drawer (per-preset talking points and "what to skip"). |
| `r`   | Toggle replay mode (forces deterministic replay even when a real `policy_id` is set). |
| `Esc` | Close the presenter drawer.                                                        |

## Replay mode (demo continuity)

If a policy's compiled `policy_id` env var is unset (or you press `r`), that policy's presets play back from a pre-recorded happy-path trace. The UI labels this clearly with a "REPLAY" pill — never claim it's live. This exists so:

- You can show all four policies on a sales call without spending $3 × 4 in `makeRules` calls during the trial period.
- You can keep going if the upstream is degraded or your laptop is offline (e.g. backstage at a conference).
- Recordings/screenshares are deterministic.

When the env var **is** set, replay mode defaults to off and you get real proofs.

## Prewarming (why live proofs feel instant)

Proof sealing is the slow step — measured ~60s on the procurement policy (and
that time is a property of the compiled policy on ICME's prover: it does not
vary with action length, and a 4-clause "lite" recompile measured *slower*,
~88s; see `scripts/time-proof.ts`). So the page prewarms the selected policy's
presets, live mode only — **sequentially**: it fires preset 1's `/api/check`,
waits until that proof is actually ready, then warms preset 2, then 3. The
prover works through roughly one proof a minute per account, so firing all
presets at once queues them against each other and against whatever the
presenter clicks (observed: a ~60s proof blowing past the timeout). One at a
time, prewarming never contends with the live demo — which also means the
green dots appear one by one over ~3 minutes, in the same order as the
suggested demo script. While the presenter narrates the action and clauses, the proofs are
already sealing; by the time a preset is clicked, the verdict is instant and
the receipt is ready or nearly so. The proof-age counter shows true wall-clock
time since the check actually fired, so nothing is misrepresented.

Costs: ~1 credit per preset per policy tab opened per session (~$0.03 per
tab). Prewarmed entries are one-shot — proofs are single-use, so a repeat
click of the same preset runs a fresh live check. Prewarming is skipped in
replay mode, on share-link views, and for unconfigured policies.

**Warming before a call.** Prewarmed checks persist in `localStorage` for
12 hours and survive page reloads, so the prep ritual is: open the page
(and click through the policy tabs you plan to show) a few minutes before
the call. Each preset button shows a small green dot once its check is
warm. On the call, the verdict is instant, the receipt panel says plainly
that the proof was sealed earlier ("sealed 9m ago — the check fired when
this policy tab was opened"), and the Verify button still performs a real,
first-time `verifyProof` against `api.icme.io` from the browser — proofs
are single-use *for verification*, so an unverified prewarmed proof is
exactly as verifiable as a fresh one. Clicking a preset consumes its
warm entry; verifying consumes the proof. Nothing about the verification
is replayed.

## Shareable receipts

The Receipt tab has a "Share this receipt" button that captures the full verified receipt into a `#share=<base64url(JSON)>` URL fragment. Hash fragments are never sent to servers, so this is safe to paste into Slack/email — the recipient sees exactly the captured `verify` response (`policy_hash`, `claimed_result`, `verify_ms`, etc.) without re-spending a proof verification or hitting the single-use 409. There's a "Re-verify on chain" button, but in replay mode and on already-consumed proofs it explains the 409 instead of failing silently.

## Architecture

- `app/page.tsx` — the entire UI. Two-column responsive layout, tabbed right column, reusable `Disclosure` component, polling hook for proof readiness, share-link encoder/decoder, presenter drawer, replay-mode controller.
- `app/policies-data.ts` — single source of truth for all four policies, their clauses, presets, per-clause evaluations, replay payloads, and presenter notes.
- `app/snippets.ts` — `curl` / TS / Python snippet generators for the Integrate tab. Library-free, properly escaped per-language.
- `app/api/check/route.ts` — Edge route proxying `POST /v1/checkIt`. Holds `ICME_API_KEY` server-side. Handles both JSON and SSE upstream responses, fail-closes to UNSAT, normalizes `zk_proof_id` → `proof_id`.
- `app/api/proof-status/route.ts` — Edge route proxying `GET /v1/proof/:id`. Returns only `{ready: boolean}` so the verify-independently button stays genuinely independent.
- `app/api/health/route.ts` — Edge route used by the status dot. Hits `/v1/verifyProof` with a bogus UUID expecting a fast 4xx (4xx = upstream alive). 4-second budget. We don't spend a real `checkIt` just to render a dot.
- `app/globals.css` — light palette + ICME brand variables.
- `scripts/compile-policy.ts` — one-time policy compile via `/v1/makeRules`. Supports `--policy <slug>`. See "Avoiding the $3 trap" below.
- `policies/spending.txt`, `policies/refunds.txt`, `policies/data-access.txt`, `policies/procurement.txt` — the four policy texts. SHA-256 of each file is its cache key.

## Setup

```bash
npm install
cp .env.example .env.local
# fill in ICME_API_KEY in .env.local
```

Required and optional environment variables (set in `.env.local` for local dev, in your host's dashboard for production):

| Variable                              | Scope  | What it does                                                              |
| ------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `ICME_API_KEY`                        | server | Used by all API routes. Never shipped to the browser.                     |
| `ICME_BASE_URL`                       | server | Defaults to `https://api.icme.io/v1`. Override for staging.               |
| `NEXT_PUBLIC_POLICY_ID_SPENDING`      | client | Compiled policy id for the spending policy.                               |
| `NEXT_PUBLIC_POLICY_ID_REFUNDS`       | client | Compiled policy id for the refunds policy.                                |
| `NEXT_PUBLIC_POLICY_ID_DATA`          | client | Compiled policy id for the data-access policy.                            |
| `NEXT_PUBLIC_POLICY_ID_PROC`          | client | Compiled policy id for the procurement policy.                            |
| `NEXT_PUBLIC_POLICY_ID`               | client | **Legacy alias** — used as a fallback for spending if the slug var is unset. Older deployments keep working. |
| `NEXT_PUBLIC_CALENDLY_URL`            | client | Link behind the "Talk to the founders" button.                            |

If a per-policy slug is left blank, that policy still appears in the playground but its presets play back as "REPLAY" (see above).

## Compile each policy (one-time, ~$3 each)

`/v1/makeRules` charges 300 credits ($3) per call and there is no recovery endpoint if the SSE parser fails. The compile script defends against this with three layers:

1. **SHA-256 cache.** Re-running with the same policy text is a no-op. The `policy_id` is read from `.policy-cache/<hash>.json`.
2. **Raw SSE log on disk.** Every byte of the stream is appended to `.policy-cache/raw-sse-<timestamp>.log` *before* parsing. If every parser strategy fails, you can still recover the `policy_id` by `grep policy_id .policy-cache/raw-sse-*.log`.
3. **Three independent parsers** (clean JSON, SSE `data: ` prefix, raw JSON line) all watching for a `policy_id` field.

Run it for each policy you want live (the script will prompt for $3 confirmation each time):

```bash
npm run policy:compile -- --policy spending
npm run policy:compile -- --policy refunds
npm run policy:compile -- --policy data-access
npm run policy:compile -- --policy procurement
```

After success the script writes the `policy_id` to:

- stdout
- `.policy-cache/<hash>.json`
- the matching `NEXT_PUBLIC_POLICY_ID_*` line in `.env.local`

If you already have a `policy_id` from a previous compile, just paste it into `.env.local` and skip the spend.

You don't have to compile every policy. Any policy whose env var is blank simply runs in REPLAY mode in the UI — fine for sales calls where you're focused on a single persona.

## Run locally

```bash
npm run dev
# open http://localhost:3000
```

## Hosting

This app **cannot run on GitHub Pages** because the API routes need a server runtime. Pick one of:

- **Vercel (recommended)** — push to GitHub, import in Vercel, set the env vars in the dashboard, deploy. Zero config.
- **Cloudflare Pages / Netlify** — same story; both support Next.js with API routes.
- **Static export + external proxy** — set `output: 'export'` in `next.config.mjs` and host the API routes on Cloudflare Workers / a small VPS. Works, but adds CORS config and a moving part.
- **Static export with no proxy** — *not recommended.* You would have to either embed the API key in client JS (immediately scrape-able, billing exposure) or make visitors paste their own key (kills the frictionless demo).

For Vercel:

1. Push to GitHub.
2. Import in Vercel.
3. Set env vars (at minimum `ICME_API_KEY`; add per-policy `NEXT_PUBLIC_POLICY_ID_*` for any policy you've compiled; add `NEXT_PUBLIC_CALENDLY_URL` for the founders CTA).
4. Deploy.

## What is intentionally not here

- Email gate — gated demos kill paste-ability.
- npm SDK / embeddable verifier widget — this is a sales tool, not a product surface.
- Self-serve policy compile from the browser — `/v1/makeRules` is non-refundable; we don't expose that to anonymous traffic.
- Public OpenAPI spec / Postman collection — the Integrate tab covers the three calls a buyer's engineer needs.
- Rate limiting — per-check cost is ~$0.01 and `policy_id` can't be exfiltrated to other endpoints, so this is a non-problem at sales-demo traffic levels.

## Cost model

- One-time setup: ~$3 per policy you choose to compile (cached forever after). Compiling all four is ~$12 total.
- Per visitor: ~$0.01–$0.03 per real preset click (REPLAY presets are free).
- Per `verifyProof` call: free.
- 1,000 visitors clicking an average of 2 real presets each: ~$20 total.

## Operational notes from the nanopayments post-mortem

These behaviors are baked into this codebase; flagging them so future maintainers don't re-learn them the hard way.

- `/v1/checkIt` returns `text/event-stream`, not JSON. The proxy handles both content types.
- `/v1/checkIt` may return `result: "AR uncertain"`. The proxy falls back to `z3_result`, then fail-closes to UNSAT.
- The proof field is named `zk_proof_id` in `checkIt` responses but `proof_id` everywhere else. The proxy normalizes to `proof_id`.
- `/v1/checkIt` returns the `proof_id` quickly but the proof itself is generated asynchronously on the backend. The UI polls `/api/proof-status` (which proxies `GET /v1/proof/:id`) and only enables the verify button once the proof is ready. The poll has a 45-second timeout and a Retry button.
- `/v1/verifyProof` is single-use. Calling it twice on the same proof returns HTTP 409. The UI surfaces this as a clear message rather than a generic error, and the share-link receiver shows the captured receipt instead of trying a redundant verify.
- `/v1/makeRules` has no idempotency key and no `GET /v1/policies` endpoint. The compile script's SHA-256 cache is the only thing standing between you and another $3 charge.
- The status-dot health probe deliberately calls `/v1/verifyProof` with a bogus UUID rather than `/v1/checkIt`, because we don't want to spend a real check just to render a dot.
