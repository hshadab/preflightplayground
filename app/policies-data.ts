/**
 * Policy library: data only, no React. The page reads from this module to
 * render the sidebar selector, presets, per-clause breakdowns, and replay
 * runs for policies that have not yet been compiled with /v1/makeRules.
 *
 * Adding a new policy:
 *   1. Drop a plain-text policy file in /policies/<slug>.txt
 *   2. Add an entry to POLICIES below (clauses, presets, optional replay)
 *   3. Run `npm run policy:compile -- --policy <slug>` to spend $3 and get a
 *      policy_id, then set NEXT_PUBLIC_POLICY_ID_<UPPER_SLUG> in .env.local.
 */

export type Outcome = "SAT" | "UNSAT";

export interface ClauseEval {
  num: number;
  status: "pass" | "fail";
  note: string;
}

export interface Preset {
  label: string;
  expected: Outcome;
  blurb: string;
  action: string;
  clauses: ClauseEval[];
  /**
   * Optional pre-recorded run. Used in two cases:
   *   - the policy has not been compiled yet (no env policy_id), OR
   *   - the live API is unhealthy / the presenter has toggled fallback mode.
   * The proof_id here is illustrative; the receipt-only view will surface
   * verifyProof failure messaging in those cases.
   */
  replay?: {
    proof_id: string;
    reason: string;
    elapsed_ms: number;
    proof_gen_seconds: number;
    verify: {
      valid: boolean;
      verify_ms: number;
      proof_bytes_len: number;
      policy_hash: string;
      claimed_result: Outcome;
    };
  };
}

export interface Policy {
  id: string;            // url-safe slug
  shortName: string;     // "Spending"
  longName: string;      // "Agent spending guardrail"
  audience: string;      // "Finance, AP, treasury"
  envKey: string;        // env var that holds the compiled policy_id
  clauses: string[];
  presets: Preset[];
  /** Per-policy talking points, surfaced in the presenter notes drawer. */
  presenterNotes: string[];
}

const SPENDING_CLAUSES = [
  "No single transaction may exceed $500.",
  "Cumulative spending in any 24-hour period may not exceed $5,000.",
  "Cumulative spending in any 30-day period may not exceed $50,000.",
  "Payments are only permitted to vendors on the approved vendor list.",
  "Any transaction over $200 requires a documented business justification of at least 20 characters.",
  'No payments may be sent to vendors with verification status equal to "pending" or "unverified."',
  "Transactions over $400 trigger a human-in-the-loop approval requirement.",
];

const REFUNDS_CLAUSES = [
  "No single refund may exceed $200.",
  "Cumulative refunds in any 24-hour period may not exceed $1,000 per agent.",
  "Cumulative refunds in any 30-day period may not exceed $10,000 per customer.",
  "Refunds are only permitted for orders placed within the past 90 days.",
  'Any refund over $50 requires a reason code from the approved list ("defective", "not_as_described", "shipping_damaged", "duplicate_charge", "customer_dissatisfaction").',
  'No refunds may be issued to customers with account status equal to "fraud_flag" or "chargeback_pending".',
  "Refunds over $100 trigger a human-in-the-loop approval requirement.",
];

const DATA_CLAUSES = [
  "The agent may only access customer records belonging to the requesting customer or to a customer who has granted explicit consent.",
  'Sensitive fields ("ssn", "full_dob", "card_number", "bank_account") require purpose equal to "fraud_investigation" or "regulatory_response".',
  "Bulk reads of more than 100 customer records in a single request are not permitted.",
  'Cross-region data transfers are only permitted between regions on the approved transfer list ("US-EU", "US-CA", "US-UK").',
  "Every access must include a non-empty business justification of at least 20 characters.",
  'Records flagged with retention status "deletion_pending" or "litigation_hold" may not be modified or exported.',
  "Access by an agent acting on behalf of a third party requires a documented data processing agreement reference.",
];

const PROCUREMENT_CLAUSES = [
  "No single purchase order may commit more than $250,000, and cumulative quarterly spend with a single supplier may not exceed $1,000,000. Anything above either threshold escalates to a human procurement officer.",
  'Supplier must be present in the supplier master with status equal to "active", with a current tax document on file (W-9 within 12 months for US, W-8 within 36 months for non-US) and a beneficial-ownership record for non-US entities.',
  "Supplier and each disclosed beneficial owner must clear OFAC SDN, EU consolidated, UK HMT, and UN sanctions screening, with a screening timestamp no more than 24 hours before the PO is committed.",
  "For any PO of $25,000 or more: executed MSA on file (effective and not expired); certificate of insurance with cyber liability ≥ $5,000,000 and general liability ≥ $2,000,000; DPA on file if the supplier will process personal or employee data; payment terms ≥ Net-30; advance payment ≤ 25% of PO total.",
  "Contract clauses must stay inside the approved playbook: liability caps ≥ 1x annual contract value or $1,000,000 (whichever is higher); IP-infringement indemnity uncapped; auto-renewal includes ≥ 60 days prior written notice.",
  "PO must be charged to a GL code mapped to the requesting cost center, and the encumbrance plus YTD spend on that GL must not exceed the cost center's remaining annual budget.",
  "PO approver must be a distinct identity from the requester, must sit in the requesting cost center's approval chain, and must hold sufficient delegated authority. Any PO ≥ $100,000 requires a second approver at Controller level or above.",
];

const PRICING_CLAUSES = [
  "No price set by the action may be below the documented cost floor for that product.",
  "No action may set, request, recommend, or enforce a minimum or fixed resale price for an independent reseller or distributor.",
  "No action may disclose future prices, future output, or future capacity to a competitor or to a competitor's agent.",
  "No action may set different prices for two customers of the same type when the basis for the difference is the customer's nationality, ethnicity, gender, or religion.",
  "No action is permitted if the counterparty type or the documented cost floor required to evaluate it is unknown or unverified.",
];

// Deterministic pseudo-random generator for realistic-looking replay data.
// The UI labels replays clearly so these are never confused with live proofs.
function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REPLAY_UUID = (n: number) => {
  const rng = mulberry32(n * 31337);
  const hex = (len: number) =>
    Array.from({ length: len }, () => Math.floor(rng() * 16).toString(16)).join("");
  // UUIDv4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx (y = 8,9,a,b)
  const y = ["8", "9", "a", "b"][Math.floor(rng() * 4)];
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${y}${hex(3)}-${hex(12)}`;
};

const REPLAY_HASH = (label: string) => {
  // Generate a realistic 64-char hex hash from the label
  const seed = Array.from(label).reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381);
  const rng = mulberry32(seed);
  return "0x" + Array.from({ length: 64 }, () => Math.floor(rng() * 16).toString(16)).join("");
};

export const POLICIES: Policy[] = [
  {
    id: "spending",
    shortName: "Spending",
    longName: "Agent spending guardrail",
    audience: "Finance, AP, treasury",
    envKey: "NEXT_PUBLIC_POLICY_ID_SPENDING",
    clauses: SPENDING_CLAUSES,
    presenterNotes: [
      "Use this as the default. Most buyers immediately recognize the shape: per-tx caps, allowlists, justifications, escalation.",
      "Lead with the SAT case to establish the happy path, then the multi-violation UNSAT to show the per-clause breakdown, then the subtle '$300 no justification' UNSAT to show that the AR engine catches the kind of thing pure regex would miss.",
      "If the buyer asks 'why not just use code?' — point at clause 5 (justification text) and clause 6 (semantic vendor status). These are intentionally things a hand-rolled rule engine would get wrong.",
    ],
    presets: [
      {
        label: "$150 SaaS purchase to an approved vendor",
        expected: "SAT",
        blurb: "Under all spending thresholds, vendor is approved and verified, no justification required below $200.",
        action:
          "Send a $150 payment to Acme Cloud, which is on the approved vendor allowlist and has verification status 'verified', " +
          "for monthly SaaS subscription renewal. Cumulative spending in the past 24 hours is $1,200 and in the past 30 days is $18,000. " +
          "No human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "pass", note: "$150 < $500 single-tx cap" },
          { num: 2, status: "pass", note: "$1,200 + $150 < $5,000 / 24h" },
          { num: 3, status: "pass", note: "$18,000 + $150 < $50,000 / 30d" },
          { num: 4, status: "pass", note: "Acme Cloud on allowlist" },
          { num: 5, status: "pass", note: "$150 < $200 — no justification required" },
          { num: 6, status: "pass", note: "verification status = 'verified'" },
          { num: 7, status: "pass", note: "$150 < $400 — no human approval required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(101),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 380,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 42,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("spending"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "$1,000 payment to an unapproved vendor",
        expected: "UNSAT",
        blurb: "Vendor is not on the allowlist and the amount exceeds the $500 single-transaction cap.",
        action:
          "Send a $1,000 payment to Unknown Co, which is NOT on the approved vendor allowlist and has verification status 'unverified', " +
          "for marketing services. Cumulative spending in the past 24 hours is $1,200 and in the past 30 days is $18,000. " +
          "Human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "fail", note: "$1,000 > $500 single-tx cap" },
          { num: 2, status: "pass", note: "$1,200 + $1,000 < $5,000 / 24h" },
          { num: 3, status: "pass", note: "$18,000 + $1,000 < $50,000 / 30d" },
          { num: 4, status: "fail", note: "Unknown Co NOT on allowlist" },
          { num: 5, status: "pass", note: "marketing services counts as justification" },
          { num: 6, status: "fail", note: "verification status = 'unverified'" },
          { num: 7, status: "pass", note: "human approval has been obtained" },
        ],
        replay: {
          proof_id: REPLAY_UUID(102),
          reason: "Action violates the policy. Both Z3 and the AR engine agree.",
          elapsed_ms: 410,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 47,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("spending"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "$300 to approved vendor with no justification",
        expected: "UNSAT",
        blurb: "Over the $200 threshold but no documented business justification — violates clause 5.",
        action:
          "Send a $300 payment to Acme Cloud, which is on the approved vendor allowlist and has verification status 'verified'. " +
          "No business justification has been provided. Cumulative spending in the past 24 hours is $1,200 and in the past 30 days is $18,000. " +
          "No human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "pass", note: "$300 < $500 single-tx cap" },
          { num: 2, status: "pass", note: "$1,200 + $300 < $5,000 / 24h" },
          { num: 3, status: "pass", note: "$18,000 + $300 < $50,000 / 30d" },
          { num: 4, status: "pass", note: "Acme Cloud on allowlist" },
          { num: 5, status: "fail", note: "$300 > $200 but no justification provided" },
          { num: 6, status: "pass", note: "verification status = 'verified'" },
          { num: 7, status: "pass", note: "$300 < $400 — no human approval required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(103),
          reason: "Action does not satisfy the policy. Z3 found the structural constraints met, but the AR engine identified a semantic violation against the natural-language rules.",
          elapsed_ms: 425,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 44,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("spending"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "refunds",
    shortName: "Refunds",
    longName: "Customer-service refund guardrail",
    audience: "Customer support, ops, fraud",
    envKey: "NEXT_PUBLIC_POLICY_ID_REFUNDS",
    clauses: REFUNDS_CLAUSES,
    presenterNotes: [
      "Best policy to demo to CS / ops / fraud leadership. Refund leakage and fraud-flag bypass are dollarized risks they already track.",
      "The reason-code allowlist (clause 5) is the cleanest example of 'AR catches what regex misses' — the agent must produce a code from a finite set, and the receipt commits to which one.",
      "Clause 6 (no refunds to fraud_flag customers) is the headline 'compliant by construction' line. A signed UNSAT receipt for that case is exactly what an internal audit team wants for chargeback disputes.",
    ],
    presets: [
      {
        label: "$80 refund for a defective item, customer in good standing",
        expected: "SAT",
        blurb: "Under the $200 cap, valid reason code, customer not flagged, no human review required (under $100).",
        action:
          "Issue an $80 refund to customer C-7421 for order O-99812 placed 14 days ago, reason_code='defective'. " +
          "Customer account status is 'active' (no fraud or chargeback flags). The agent's cumulative refunds in the past 24 hours are $320. " +
          "The customer's cumulative refunds in the past 30 days are $80. No human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "pass", note: "$80 < $200 single-refund cap" },
          { num: 2, status: "pass", note: "$320 + $80 < $1,000 / 24h per agent" },
          { num: 3, status: "pass", note: "$80 < $10,000 / 30d per customer" },
          { num: 4, status: "pass", note: "order is 14 days old (< 90 days)" },
          { num: 5, status: "pass", note: "reason_code='defective' is on the allowlist" },
          { num: 6, status: "pass", note: "account status='active'" },
          { num: 7, status: "pass", note: "$80 < $100 — no human approval required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(201),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 395,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 41,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("refunds"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "$300 refund to a fraud-flagged customer",
        expected: "UNSAT",
        blurb: "Over the $200 cap and the customer is on a fraud flag — multiple clauses fail.",
        action:
          "Issue a $300 refund to customer C-3140 for order O-44021 placed 22 days ago, reason_code='customer_dissatisfaction'. " +
          "Customer account status is 'fraud_flag'. The agent's cumulative refunds in the past 24 hours are $400. " +
          "The customer's cumulative refunds in the past 30 days are $0. Human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "fail", note: "$300 > $200 single-refund cap" },
          { num: 2, status: "pass", note: "$400 + $300 < $1,000 / 24h" },
          { num: 3, status: "pass", note: "$0 + $300 < $10,000 / 30d" },
          { num: 4, status: "pass", note: "order is 22 days old (< 90 days)" },
          { num: 5, status: "pass", note: "reason_code='customer_dissatisfaction' is on the allowlist" },
          { num: 6, status: "fail", note: "account status='fraud_flag' — refund not permitted" },
          { num: 7, status: "pass", note: "human approval has been obtained" },
        ],
        replay: {
          proof_id: REPLAY_UUID(202),
          reason: "Action violates the policy. Both Z3 and the AR engine agree.",
          elapsed_ms: 415,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 46,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("refunds"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "$60 refund with no reason code",
        expected: "UNSAT",
        blurb: "Over the $50 reason-code threshold but the agent did not supply one — violates clause 5.",
        action:
          "Issue a $60 refund to customer C-1188 for order O-77104 placed 5 days ago. No reason_code has been supplied. " +
          "Customer account status is 'active'. The agent's cumulative refunds in the past 24 hours are $120. " +
          "The customer's cumulative refunds in the past 30 days are $0. No human-in-the-loop approval has been obtained.",
        clauses: [
          { num: 1, status: "pass", note: "$60 < $200 single-refund cap" },
          { num: 2, status: "pass", note: "$120 + $60 < $1,000 / 24h" },
          { num: 3, status: "pass", note: "$0 + $60 < $10,000 / 30d" },
          { num: 4, status: "pass", note: "order is 5 days old (< 90 days)" },
          { num: 5, status: "fail", note: "$60 > $50 but no reason_code supplied" },
          { num: 6, status: "pass", note: "account status='active'" },
          { num: 7, status: "pass", note: "$60 < $100 — no human approval required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(203),
          reason: "Action does not satisfy the policy. The AR engine identified a missing required field against the natural-language rules.",
          elapsed_ms: 405,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 43,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("refunds"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "data-access",
    shortName: "Data access",
    longName: "Customer-data access guardrail",
    audience: "Security, privacy, compliance",
    envKey: "NEXT_PUBLIC_POLICY_ID_DATA",
    clauses: DATA_CLAUSES,
    presenterNotes: [
      "Best policy for security / privacy / GRC buyers. The receipt is a portable artifact you can hand to an auditor or DPO without sharing the data itself.",
      "Lead with the fact that the policy is enforced *before* the data is touched — not by post-hoc log analysis. The blocked-access UNSAT receipt is the technical buyer's favorite slide.",
      "Clause 2 (sensitive-field elevation) is the GDPR / CCPA hook. Clause 7 (DPA reference) is the enterprise-procurement hook.",
    ],
    presets: [
      {
        label: "Read 5 own records for a support ticket",
        expected: "SAT",
        blurb: "Customer is reading their own data, justification provided, no sensitive fields touched, well under the bulk cap.",
        action:
          "Read 5 customer records belonging to the requesting customer C-2233, purpose='support', " +
          "fields=['email','order_history','last_login']. Business justification: 'Customer opened ticket #88421 about a missing order'. " +
          "Region transfer: US to US. No retention flags. No third-party processing.",
        clauses: [
          { num: 1, status: "pass", note: "records belong to the requesting customer" },
          { num: 2, status: "pass", note: "no sensitive fields requested" },
          { num: 3, status: "pass", note: "5 records < 100 bulk cap" },
          { num: 4, status: "pass", note: "US→US is in-region (no transfer)" },
          { num: 5, status: "pass", note: "justification supplied (47 chars)" },
          { num: 6, status: "pass", note: "no retention flags on these records" },
          { num: 7, status: "pass", note: "first-party access, no DPA required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(301),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 388,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 42,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("data-access"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "Bulk read 500 records including SSN, marketing purpose",
        expected: "UNSAT",
        blurb: "Over the bulk cap, requests sensitive fields without an elevated purpose — multiple clauses fail.",
        action:
          "Read 500 customer records, purpose='marketing_segmentation', fields=['email','ssn','full_dob','last_purchase']. " +
          "Business justification: 'Build lookalike segment for Q3 campaign'. Region transfer: US to EU. " +
          "Records do not have retention flags. The agent is operating directly for the company (no third party).",
        clauses: [
          { num: 1, status: "fail", note: "records are not requestor's own and no consent provided" },
          { num: 2, status: "fail", note: "ssn, full_dob requested with purpose='marketing_segmentation' (not elevated)" },
          { num: 3, status: "fail", note: "500 records > 100 bulk cap" },
          { num: 4, status: "pass", note: "US→EU is on the approved transfer list" },
          { num: 5, status: "pass", note: "justification supplied (38 chars)" },
          { num: 6, status: "pass", note: "no retention flags" },
          { num: 7, status: "pass", note: "first-party access, no DPA required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(302),
          reason: "Action violates the policy. Both Z3 and the AR engine agree.",
          elapsed_ms: 432,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 48,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("data-access"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "Read records with no business justification",
        expected: "UNSAT",
        blurb: "All other clauses pass, but justification is empty — violates clause 5.",
        action:
          "Read 12 customer records with explicit consent on file, purpose='analytics', fields=['email','last_login']. " +
          "Business justification field is empty. Region transfer: US to US. No retention flags. No third-party processing.",
        clauses: [
          { num: 1, status: "pass", note: "consent on file" },
          { num: 2, status: "pass", note: "no sensitive fields requested" },
          { num: 3, status: "pass", note: "12 records < 100 bulk cap" },
          { num: 4, status: "pass", note: "US→US is in-region (no transfer)" },
          { num: 5, status: "fail", note: "justification empty — required to be ≥20 chars" },
          { num: 6, status: "pass", note: "no retention flags" },
          { num: 7, status: "pass", note: "first-party access, no DPA required" },
        ],
        replay: {
          proof_id: REPLAY_UUID(303),
          reason: "Action does not satisfy the policy. The AR engine identified a missing required field against the natural-language rules.",
          elapsed_ms: 401,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 43,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("data-access"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "procurement",
    shortName: "Procurement",
    longName: "Procurement and supplier governance",
    audience: "Procurement, finance, internal audit, legal ops",
    envKey: "NEXT_PUBLIC_POLICY_ID_PROC",
    clauses: PROCUREMENT_CLAUSES,
    presenterNotes: [
      "This is the right policy for any buyer who's been through a SOX audit or runs an enterprise procurement / CLM workflow (think Coupa / SAP Ariba / Leah AI / Zip). They already think in clauses; this is the receipt for each one.",
      "Lead with the clean Dell laptop reorder to anchor the happy path. Then the Pericles cyber-retainer preset is the demo's punchline: the SAME person both requested AND approved a $112k spend on a vendor with no MSA, sub-minimum cyber insurance, and Net-15 with 50% upfront. Six clauses fail simultaneously.",
      "Close with the Cyprus sanctions hit. That preset is designed to show that the OFAC/EU clause is binary — every other clause passes, but a single sanctions match blocks the PO. Useful when a buyer asks 'what stops a clever agent from finding a way around our controls?'",
      "If the buyer is on a CLM/procurement platform already, lean into clause 4 (MSA + COI + DPA) and clause 5 (template drift). These are exactly the checks their existing playbooks try to enforce — but today they live in a Word doc, not a cryptographic receipt.",
    ],
    presets: [
      {
        label: "$189k laptop refresh from Dell — clean PO",
        expected: "SAT",
        blurb: "Routine in-master vendor, MSA + COI + W-9 current, three competing quotes, dual approval, on-budget GL.",
        action:
          "Issue PO 2026-04812 to Dell Technologies Inc. for 250 ThinkPad T16 refresh laptops at $758/unit, total $189,500. " +
          "GL=6210 (IT-Hardware), cost_center=4400 (Engineering Platform), payment_terms=Net-30, advance_payment=0%. " +
          "Supplier master: status='active', W-9 dated 2025-08-04, beneficial_owner=N/A (US entity). " +
          "Sanctions screen: cleared 2026-04-30T19:11Z (OFAC, EU, UK, UN — all negative). " +
          "MSA: executed 2024-03-12, expires 2027-03-11. COI: cyber=$10,000,000, general_liability=$5,000,000. DPA: not required (no PII in scope). " +
          "Three competing quotes attached; no contract drift from template; CC 4400 GL 6210 has $480,000 remaining of $1,200,000 annual budget. " +
          "Requester: alex.chen (Engineering Platform). Approver: margo.reed (Director, Engineering Platform; $250k delegated authority). Distinct identity, in approval chain.",
        clauses: [
          { num: 1, status: "pass", note: "$189,500 < $250k single-PO ceiling; quarterly Dell spend $612k < $1M cap" },
          { num: 2, status: "pass", note: "Dell active in master, W-9 within 12 months, US entity (no BO required)" },
          { num: 3, status: "pass", note: "OFAC/EU/UK/UN screen clear at 2026-04-30T19:11Z (< 24h before commit)" },
          { num: 4, status: "pass", note: "MSA current, cyber $10M ≥ $5M, GL $5M ≥ $2M, Net-30, no advance, DPA n/a" },
          { num: 5, status: "pass", note: "Standard PO referencing approved MSA template — no clause drift" },
          { num: 6, status: "pass", note: "GL 6210 mapped to CC 4400; $480k remaining > $189,500 encumbrance" },
          { num: 7, status: "pass", note: "Requester ≠ approver, in chain, $250k authority covers; <$100k Controller floor" },
        ],
        replay: {
          proof_id: REPLAY_UUID(401),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 392,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 43,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("procurement"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "$112k cyber retainer — self-approved, MSA pending, sub-min insurance",
        expected: "UNSAT",
        blurb: "Same person requested and approved. MSA not executed. Cyber insurance below minimum. Net-15 with 50% upfront. Six clauses fail.",
        action:
          "Issue PO 2026-04934 to Pericles Cyber LLC for a 12-month incident-response retainer, total $112,000. " +
          "GL=6450 (Security-Services), cost_center=8100 (CISO Office), payment_terms=Net-15, advance_payment=50%. " +
          "Supplier master: status='active', W-9 dated 2025-09-22. " +
          "Sanctions screen: cleared 2026-04-30T18:02Z. " +
          "MSA: in-flight, redlines outstanding, NOT executed. COI: cyber=$2,000,000, general_liability=$1,500,000. DPA: missing (vendor will access incident data including employee identifiers). " +
          "No competing bids; sole-source justification field length = 19 chars ('urgent, breach pending'). No template-drift flags raised because no contract is on file. " +
          "GL 6450 mapped to CC 8100, $340k remaining of $400k. " +
          "Requester: david.park (Security Architect). Approver: david.park (self-approval). No second approver despite $112k > $100k Controller threshold.",
        clauses: [
          { num: 1, status: "pass", note: "$112k < $250k ceiling and quarterly Pericles spend $0 < $1M cap" },
          { num: 2, status: "pass", note: "Pericles active in master with current W-9" },
          { num: 3, status: "pass", note: "Sanctions clear at 2026-04-30T18:02Z" },
          { num: 4, status: "fail", note: "MSA NOT executed; cyber $2M < $5M required; DPA missing; Net-15 < Net-30; advance 50% > 25% cap" },
          { num: 5, status: "pass", note: "No referenced contract — playbook drift not assessable" },
          { num: 6, status: "pass", note: "GL 6450 / CC 8100 within remaining budget" },
          { num: 7, status: "fail", note: "Self-approval (requester == approver); also $112k ≥ $100k requires Controller-level second approver" },
        ],
        replay: {
          proof_id: REPLAY_UUID(402),
          reason: "Action violates the policy on commercial terms (clause 4) and segregation of duties (clause 7). Z3 confirmed UNSAT and the AR engine flagged the same control gaps in plain language.",
          elapsed_ms: 458,
          proof_gen_seconds: 8,
          verify: {
            valid: true,
            verify_ms: 51,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("procurement"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "$42k Cyprus supplier — sanctions hit on beneficial owner",
        expected: "UNSAT",
        blurb: "Every other clause passes. A single sanctions match on the disclosed beneficial owner blocks the PO outright.",
        action:
          "Issue PO 2026-05007 to Neva Trading Group Ltd. (Cyprus) for $42,800 in cross-border fulfillment services. " +
          "GL=6300 (Logistics-Outbound), cost_center=5200 (Operations), payment_terms=Net-30, advance_payment=0%. " +
          "Supplier master: status='active', W-8BEN-E dated 2024-11-09. Beneficial owner disclosed: Igor Volkov (50.1% shareholder), nationality RU. " +
          "Sanctions screen result at 2026-04-30T18:55Z: Neva Trading clear on OFAC SDN; parent Petroneva Holdings Ltd. (BVI) flagged on EU consolidated list (entry 2024/1287); beneficial owner I. Volkov flagged on UK HMT list (entry RUS0421). " +
          "MSA executed 2025-11-02, valid through 2026-11-01. COI cyber $5,000,000, general liability $2,000,000. DPA on file (vendor processes shipping-recipient PII). " +
          "Two competing quotes attached; no template drift. GL 6300 / CC 5200 has $138,000 remaining. " +
          "Requester: ops-bot-prod (service identity). Approver: ramona.silva (Director, Operations; $250k delegated authority). Distinct identity, in chain.",
        clauses: [
          { num: 1, status: "pass", note: "$42,800 < $250k ceiling; quarterly Neva spend $11k < $1M cap" },
          { num: 2, status: "pass", note: "Neva active in master, W-8 within 36 months, beneficial owner record present" },
          { num: 3, status: "fail", note: "EU sanctions match on parent Petroneva Holdings (entry 2024/1287); UK HMT match on beneficial owner I. Volkov (entry RUS0421)" },
          { num: 4, status: "pass", note: "MSA, COI, DPA, Net-30 all satisfied for ≥$25k tier" },
          { num: 5, status: "pass", note: "No template drift" },
          { num: 6, status: "pass", note: "GL 6300 / CC 5200 within remaining budget" },
          { num: 7, status: "pass", note: "Approver distinct, in chain, sufficient authority" },
        ],
        replay: {
          proof_id: REPLAY_UUID(403),
          reason: "Action violates the policy. The AR engine identified two distinct sanctions matches on the supplier's parent entity and disclosed beneficial owner. A single sanctions hit is sufficient to block the PO regardless of how clean the rest of the file is.",
          elapsed_ms: 421,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 46,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("procurement"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "algorithmic-pricing",
    shortName: "Pricing",
    longName: "Competition pricing guardrail",
    audience: "Antitrust, competition, digital markets",
    envKey: "NEXT_PUBLIC_POLICY_ID_PRICING",
    clauses: PRICING_CLAUSES,
    presenterNotes: [
      "An automated pricing agent can commit a competition violation at machine speed and scale. The guardrail checks each pricing or commercial action against the competition rules before it executes — four recognizable violations on one screen: below-cost exclusion, resale price maintenance, information exchange with a competitor, and price discrimination on a prohibited factor. Each is blocked before it executes.",
      "This tab leads with an allowed action — a routine price update above the cost floor — so the audience sees legitimate pricing sails through, then four recognizable violations get blocked. Every action, allowed or blocked, produces a signed receipt proving the check ran and what verdict it returned.",
      "The information-exchange scenario is the one for the agentic economy: when pricing agents talk to each other, a concerted practice can form with no human in the loop. The guardrail blocks the disclosure before it is sent.",
      "What the receipt proves: the competition check ran before the action and returned the verdict, verifiable by a competition authority or internal audit without exposing the firm's pricing logic or cost data. In confidential mode the cost floors and pricing model stay private — the proof shows only that the action was checked and what the verdict was.",
      "Scope honestly: this enforces bright-line, per-action constraints the legal team has already set. It does NOT detect tacit collusion or emergent coordination — those are multi-party properties not visible in one action. An antitrust lawyer will distrust any tool that claims to 'prevent collusion,' so say this plainly.",
      "The receipt proves the policy was evaluated correctly against the facts asserted in the action (e.g. that the recipient is a competitor, or the price is below the stated floor). It does NOT prove those facts are true — binding asserted facts to reality is a separate control. Name it before a sharp buyer does.",
      "Objection, 'competition compliance is a legal judgment, not a rules engine.' True for the hard cases. The guardrail is not the legal analysis; it enforces the bright lines already set, at a speed and volume no human can review. The receipt is the evidence the constraint held.",
      "For Carolina: this is her ACT practice in one screen — usable as client-facing and teaching material, and it speaks to algorithmic decisioning in digital markets, her stated focus.",
    ],
    presets: [
      {
        label: "Routine price update above the cost floor",
        expected: "SAT",
        blurb: "A normal list-price update above the documented cost floor, no resale terms, no competitor disclosure, uniform across same-type customers. Allowed.",
        action:
          "Set the list price of product SKU-204 to 49.00 EUR for direct end customers. The documented cost floor for SKU-204 is 38.00 EUR, " +
          "so the 49.00 EUR price is above the cost floor. The action sets no resale price for any independent reseller, discloses no pricing or " +
          "capacity information to any competitor, and applies the same price to all customers of the same type with no difference based on any prohibited factor. " +
          "The counterparty type and the documented cost floor are known and verified.",
        clauses: [
          { num: 1, status: "pass", note: "49.00 EUR ≥ 38.00 EUR cost floor" },
          { num: 2, status: "pass", note: "no resale price set" },
          { num: 3, status: "pass", note: "no competitor disclosure" },
          { num: 4, status: "pass", note: "uniform price, no prohibited-factor difference" },
          { num: 5, status: "pass", note: "counterparty type and cost floor are known and verified" },
        ],
        replay: {
          proof_id: REPLAY_UUID(601),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 396,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 43,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("algorithmic-pricing"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "Below-cost pricing to exclude a rival",
        expected: "UNSAT",
        blurb: "Price set below the documented cost floor to exclude a rival. Blocked by clause 1.",
        action:
          "Set the list price of product SKU-204 to 31.00 EUR. The documented cost floor for SKU-204 is 38.00 EUR. " +
          "The price of 31.00 EUR is below the 38.00 EUR cost floor. The action sets no resale price and discloses no information to a competitor. " +
          "The counterparty type and the documented cost floor are known and verified.",
        clauses: [
          { num: 1, status: "fail", note: "31.00 EUR < 38.00 EUR cost floor" },
          { num: 2, status: "pass", note: "no resale price set" },
          { num: 3, status: "pass", note: "no competitor disclosure" },
          { num: 4, status: "pass", note: "no price difference between customers" },
          { num: 5, status: "pass", note: "counterparty type and cost floor are known" },
        ],
        replay: {
          proof_id: REPLAY_UUID(602),
          reason: "Action violates the policy. The price is below the documented cost floor.",
          elapsed_ms: 412,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 45,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("algorithmic-pricing"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "Resale price maintenance",
        expected: "UNSAT",
        blurb: "Sets a minimum resale price on an independent reseller. Blocked by clause 2. Resale price maintenance is a hardcore restriction.",
        action:
          "Instruct independent reseller Delta Retail to sell product SKU-204 at no less than 59.00 EUR. " +
          "This sets a minimum resale price for an independent reseller. The documented cost floor for SKU-204 is 38.00 EUR. " +
          "The counterparty type is an independent reseller and is known and verified.",
        clauses: [
          { num: 1, status: "pass", note: "no own price set below the floor" },
          { num: 2, status: "fail", note: "sets a minimum resale price on independent reseller Delta Retail" },
          { num: 3, status: "pass", note: "no competitor disclosure" },
          { num: 4, status: "pass", note: "no price difference between customers" },
          { num: 5, status: "pass", note: "counterparty type known (independent reseller)" },
        ],
        replay: {
          proof_id: REPLAY_UUID(603),
          reason: "Action violates the policy. It imposes a minimum resale price on an independent reseller (resale price maintenance).",
          elapsed_ms: 418,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 46,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("algorithmic-pricing"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "Disclosing future pricing to a competitor's agent",
        expected: "UNSAT",
        blurb: "Discloses future pricing to a competitor's agent. Blocked by clause 3. Agent-to-agent exchange of forward prices is a concerted-practice risk.",
        action:
          "Send next quarter's planned price list for the full product line to the pricing agent of Orion Corp. " +
          "Orion Corp is a competitor. The information is next quarter's planned prices, which are future prices. " +
          "The counterparty type is a competitor and is known and verified.",
        clauses: [
          { num: 1, status: "pass", note: "no price set below the floor" },
          { num: 2, status: "pass", note: "no resale price set" },
          { num: 3, status: "fail", note: "discloses next quarter's prices to competitor Orion Corp's agent" },
          { num: 4, status: "pass", note: "no price difference between customers" },
          { num: 5, status: "pass", note: "counterparty type known (competitor)" },
        ],
        replay: {
          proof_id: REPLAY_UUID(604),
          reason: "Action violates the policy. It discloses competitively sensitive future pricing to a competitor's agent.",
          elapsed_ms: 421,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 47,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("algorithmic-pricing"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "Price discrimination on a prohibited factor",
        expected: "UNSAT",
        blurb: "Charges same-type customers different prices based on nationality, a prohibited factor. Blocked by clause 4.",
        action:
          "Set the price of product SKU-204 to 55.00 EUR for business customer Alpha and 42.00 EUR for business customer Beta. " +
          "Alpha and Beta are customers of the same type. The only stated basis for the price difference is the customers' nationality. " +
          "Both prices are above the documented cost floor of 38.00 EUR. " +
          "The counterparty type, the documented cost floor, and the basis for the price difference are known and verified.",
        clauses: [
          { num: 1, status: "pass", note: "both 55.00 and 42.00 EUR ≥ 38.00 EUR floor" },
          { num: 2, status: "pass", note: "no resale price set" },
          { num: 3, status: "pass", note: "no competitor disclosure" },
          { num: 4, status: "fail", note: "price difference based on nationality, a prohibited factor" },
          { num: 5, status: "pass", note: "counterparty type, cost floor, and basis all known" },
        ],
        replay: {
          proof_id: REPLAY_UUID(605),
          reason: "Action violates the policy. It differentiates between equivalent customers using a prohibited factor.",
          elapsed_ms: 415,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 45,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("algorithmic-pricing"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
];

export function policyById(id: string): Policy | undefined {
  return POLICIES.find((p) => p.id === id);
}
