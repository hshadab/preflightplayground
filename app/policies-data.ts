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

const COMMS_CLAUSES = [
  'Outbound messages may only be sent to recipients with marketing_opt_in equal to "true" or in a transactional context (order confirmation, security alert, support reply).',
  "No more than 3 outbound messages may be sent to the same recipient in any 24-hour period.",
  "Messages must not be sent during the recipient's local quiet hours (9pm to 8am in their declared timezone).",
  "AI-generated promotional content must include a clear disclosure that the message was drafted by an AI agent.",
  "Messages must not contain medical, legal, or investment advice unless the sender holds a certified-advisor flag.",
  'SMS channel may only be used for recipients with sms_opt_in equal to "true" and on the approved-country list ("US", "CA", "UK").',
  "Any message larger than 1,000 characters or containing an attachment requires human-in-the-loop review.",
];

// A short, deterministic "looks-real" UUID used in replays. The receipt
// labelling in the UI will say "REPLAY" so this is never confused with a
// live proof id.
const REPLAY_UUID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REPLAY_HASH = (label: string) =>
  "0x" + Array.from(label).reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(8, "0").repeat(8);

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
    id: "communications",
    shortName: "Communications",
    longName: "Outbound communications guardrail",
    audience: "Marketing, growth, customer ops",
    envKey: "NEXT_PUBLIC_POLICY_ID_COMMS",
    clauses: COMMS_CLAUSES,
    presenterNotes: [
      "Best policy for marketing / growth / CRM buyers. They already pay for opt-in management; the receipt is the auditable proof their AI didn't bypass it.",
      "Clause 4 (AI disclosure) is timely — it lines up with regulator chatter about disclosing AI-generated outreach.",
      "The SMS clause (6) demonstrates how channel-specific rules compose with the rest of the policy without writing extra code.",
    ],
    presets: [
      {
        label: "Order confirmation to an opted-in US recipient",
        expected: "SAT",
        blurb: "Transactional context exempts marketing opt-in; in-hours, short message, US recipient.",
        action:
          "Send an email to recipient R-5501 in timezone='America/New_York' (local time 2:14pm), context='order_confirmation', " +
          "channel='email', length=480 chars, contains_attachment=false, ai_drafted=false. " +
          "marketing_opt_in='false', sms_opt_in='false', country='US'. The recipient has received 1 message in the past 24 hours.",
        clauses: [
          { num: 1, status: "pass", note: "transactional context (order_confirmation) is exempt" },
          { num: 2, status: "pass", note: "1 + 1 = 2 messages < 3 / 24h cap" },
          { num: 3, status: "pass", note: "2:14pm local — outside quiet hours" },
          { num: 4, status: "pass", note: "not AI-drafted promotional content" },
          { num: 5, status: "pass", note: "no medical/legal/investment content" },
          { num: 6, status: "pass", note: "channel='email' — SMS rule does not apply" },
          { num: 7, status: "pass", note: "480 chars < 1,000, no attachment" },
        ],
        replay: {
          proof_id: REPLAY_UUID(401),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 372,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 41,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("communications"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "SMS at 11pm to a non-opted-in recipient",
        expected: "UNSAT",
        blurb: "Quiet-hours violation, missing SMS opt-in, missing marketing opt-in — multiple clauses fail.",
        action:
          "Send an SMS to recipient R-9920 in timezone='America/Los_Angeles' (local time 11:04pm), context='promotional', " +
          "channel='sms', length=320 chars, contains_attachment=false, ai_drafted=true (no disclosure). " +
          "marketing_opt_in='false', sms_opt_in='false', country='US'. The recipient has received 0 messages in the past 24 hours.",
        clauses: [
          { num: 1, status: "fail", note: "promotional context but marketing_opt_in='false'" },
          { num: 2, status: "pass", note: "0 + 1 = 1 message < 3 / 24h cap" },
          { num: 3, status: "fail", note: "11:04pm local — inside 9pm-8am quiet hours" },
          { num: 4, status: "fail", note: "AI-drafted promotional content with no disclosure" },
          { num: 5, status: "pass", note: "no medical/legal/investment content" },
          { num: 6, status: "fail", note: "channel='sms' but sms_opt_in='false'" },
          { num: 7, status: "pass", note: "320 chars < 1,000, no attachment" },
        ],
        replay: {
          proof_id: REPLAY_UUID(402),
          reason: "Action violates the policy. Both Z3 and the AR engine agree.",
          elapsed_ms: 441,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 49,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("communications"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "AI-drafted promo email without disclosure",
        expected: "UNSAT",
        blurb: "All recipient signals are fine, but the AI-disclosure tag is missing — violates clause 4.",
        action:
          "Send an email to recipient R-3380 in timezone='Europe/London' (local time 10:32am), context='promotional', " +
          "channel='email', length=720 chars, contains_attachment=false, ai_drafted=true (no disclosure). " +
          "marketing_opt_in='true', sms_opt_in='false', country='UK'. The recipient has received 1 message in the past 24 hours.",
        clauses: [
          { num: 1, status: "pass", note: "marketing_opt_in='true'" },
          { num: 2, status: "pass", note: "1 + 1 = 2 messages < 3 / 24h cap" },
          { num: 3, status: "pass", note: "10:32am local — outside quiet hours" },
          { num: 4, status: "fail", note: "AI-drafted promotional content with no disclosure" },
          { num: 5, status: "pass", note: "no medical/legal/investment content" },
          { num: 6, status: "pass", note: "channel='email' — SMS rule does not apply" },
          { num: 7, status: "pass", note: "720 chars < 1,000, no attachment" },
        ],
        replay: {
          proof_id: REPLAY_UUID(403),
          reason: "Action does not satisfy the policy. The AR engine identified a missing required disclosure against the natural-language rules.",
          elapsed_ms: 411,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 44,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("communications"),
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
