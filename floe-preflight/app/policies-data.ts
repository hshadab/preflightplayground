/**
 * Floe-shaped policy library for the Verifiable Floe demo.
 *
 * Three policies, each modeled on a real Floe surface:
 *   - verifiable-borrow      → instant_borrow against OperatorPermission
 *   - verifiable-x402        → /v1/proxy/fetch via x402/estimate
 *   - verifiable-liquidation → liquidateLoan(loanId) good-faith gate
 *
 * Each preset carries a fully-canned `replay` block. In replay mode the page
 * surfaces these as if a real check had run. Verification (`/v1/verifyProof`)
 * still calls ICME's public endpoint with the proof_id, so the verify side of
 * the demo is genuinely cryptographic.
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
  id: string;
  shortName: string;
  longName: string;
  audience: string;
  envKey: string;
  clauses: string[];
  presets: Preset[];
  presenterNotes: string[];
}

const BORROW_CLAUSES = [
  "borrowAmount must be <= (borrowLimit - borrowed) on the agent's OperatorPermission.",
  "maxInterestRateBps in the borrow request must be <= maxRateBps in the OperatorPermission.",
  "Current Unix time must be < expiry in the OperatorPermission.",
  "If onBehalfOfRestriction is non-zero, onBehalfOf in the request must equal it exactly.",
  "Collateral asset must not have moved by more than 5% in absolute value over the last 60 minutes.",
  "Total outstanding principal across this principal's agents must remain <= the parent budget.",
  "The lender wallet selected by the matcher must be at least 30 days old (first on-chain tx >= 30d ago).",
  "Cross-protocol exposure (outstanding principal across Floe and any other lending protocols this principal uses) must remain <= the configured cross-protocol exposure cap.",
];

const X402_CLAUSES = [
  "priceRaw from x402/estimate must be <= the agent's per-call USDC cap.",
  "session_spend_remaining returned by x402/estimate must be >= priceRaw.",
  "Trailing 24h cumulative spend, plus priceRaw, must be <= the agent's daily USDC cap.",
  "payTo must clear OFAC SDN, EU consolidated, UK HMT, and UN sanctions, screened within the last 24h.",
  "payTo must be on the principal's allowlist, OR the agent role must permit unlisted counterparties.",
  "Settlement network must be Base mainnet (chain id 8453).",
  "Settlement asset must be USDC.",
  "OperatorPermission must be approved and unexpired, and any auto-borrow this call would trigger (priceRaw - session_spend_remaining, floored at 0) must fit under remaining (borrowLimit - borrowed) headroom.",
];

const LIQUIDATION_CLAUSES = [
  "Loan must be genuinely underwater: currentLtvBps must be strictly > liquidationLtvBps configured for that loan.",
  "Circuit breaker must not be active: oracle deviation < 1500 bps, Base sequencer continuously online >= 3600s, oracle price <= 3600s old at execution.",
  "Liquidation must not be a malicious low-value action: expectedProfit USD must be > MIN_PROFIT_USD floor (default 10 USD).",
];

// Stable, "looks-real" UUIDs and policy hashes for replay. The UI tags every
// replay receipt with "REPLAY" so this is never confused with a live proof_id.
const REPLAY_UUID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REPLAY_HASH = (label: string) =>
  "0x" + Array.from(label).reduce((a, c) => (a * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16).padStart(8, "0").repeat(8);

export const POLICIES: Policy[] = [
  {
    id: "verifiable-borrow",
    shortName: "Borrow",
    longName: "Verifiable agent borrow",
    audience: "Floe lenders, principals running agents on Agent Working Capital",
    envKey: "NEXT_PUBLIC_POLICY_ID_BORROW",
    clauses: BORROW_CLAUSES,
    presenterNotes: [
      "Lead with this for the founder demo. It anchors directly on Floe's core product (instant_borrow) and on the on-chain OperatorPermission they already ship.",
      "Two value props live in this policy. (A) Positive evidence: the contract reverts if violated; Preflight emits the inverse, a SNARK that says the request was inside the envelope. (B) Off-chain checks the contract structurally cannot do: volatility-halt (clause 5), parent-budget aggregation (clause 6), lender-wallet age (clause 7), cross-protocol exposure (clause 8).",
      "If a Floe engineer pushes back with 'we already enforce this on-chain,' point at clauses 5 through 8. None of them can live in a smart contract. They have to live somewhere off-chain that produces a receipt.",
    ],
    presets: [
      {
        label: "$5,000 USDC borrow against 2 ETH, 12% cap, principal in good standing",
        expected: "SAT",
        blurb: "Inside on-chain envelope, collateral stable, parent budget healthy, lender wallet mature, cross-protocol exposure clear.",
        action:
          "Floe instant_borrow request from agent 0xA11CE. borrowAmount=5,000 USDC, collateralAmount=2 ETH (~$7,500), " +
          "maxInterestRateBps=1200, duration=2,592,000 (30 days), onBehalfOf=0xPay111. " +
          "OperatorPermission for this operator: borrowLimit=20,000 USDC, borrowed=8,000 USDC, maxRateBps=1500, expiry=2027-01-01, onBehalfOfRestriction=0xPay111. " +
          "Collateral asset (ETH) moved -1.8% in the last 60 minutes against Chainlink reference. " +
          "Total outstanding principal across this principal's three agents is 31,000 USDC; parent borrow ceiling is 50,000 USDC. " +
          "Selected lender wallet 0xLEND01 first transacted 187 days ago. " +
          "Cross-protocol outstanding (Floe + 1 other venue) = 18,000 USDC; configured cross-protocol cap = 75,000 USDC.",
        clauses: [
          { num: 1, status: "pass", note: "5,000 <= (20,000 - 8,000) = 12,000 remaining" },
          { num: 2, status: "pass", note: "1200 bps <= 1500 bps cap" },
          { num: 3, status: "pass", note: "now < 2027-01-01 expiry" },
          { num: 4, status: "pass", note: "onBehalfOf 0xPay111 == restriction" },
          { num: 5, status: "pass", note: "ETH 60-min move 1.8% < 5%" },
          { num: 6, status: "pass", note: "31,000 + 5,000 = 36,000 <= 50,000 parent budget" },
          { num: 7, status: "pass", note: "lender wallet age 187 days >= 30" },
          { num: 8, status: "pass", note: "18,000 + 5,000 = 23,000 <= 75,000 cross-protocol cap" },
        ],
        replay: {
          proof_id: REPLAY_UUID(1101),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 392,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 43,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-borrow"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "$15,000 borrow during a 7% ETH drop, rate above cap",
        expected: "UNSAT",
        blurb: "Volatility halt fires (clause 5), and the requested rate exceeds the OperatorPermission cap (clause 2).",
        action:
          "Floe instant_borrow request from agent 0xB22BD. borrowAmount=15,000 USDC, collateralAmount=4 ETH (~$14,200), " +
          "maxInterestRateBps=1900, duration=2,592,000, onBehalfOf=0xPay222. " +
          "OperatorPermission: borrowLimit=20,000 USDC, borrowed=2,000 USDC, maxRateBps=1500, expiry=2027-01-01, onBehalfOfRestriction=0xPay222. " +
          "Collateral asset (ETH) moved -7.2% in the last 60 minutes against Chainlink reference. " +
          "Parent borrow ceiling 50,000; outstanding 8,000. Selected lender wallet 0xLEND02 first transacted 412 days ago. " +
          "Cross-protocol outstanding 22,000 USDC; cross-protocol cap 75,000 USDC.",
        clauses: [
          { num: 1, status: "pass", note: "15,000 <= (20,000 - 2,000) = 18,000 remaining" },
          { num: 2, status: "fail", note: "1900 bps > 1500 bps cap (rate above OperatorPermission)" },
          { num: 3, status: "pass", note: "now < expiry" },
          { num: 4, status: "pass", note: "onBehalfOf == restriction" },
          { num: 5, status: "fail", note: "ETH 60-min move 7.2% > 5% volatility halt" },
          { num: 6, status: "pass", note: "8,000 + 15,000 = 23,000 <= 50,000 parent budget" },
          { num: 7, status: "pass", note: "lender wallet age 412 days >= 30" },
          { num: 8, status: "pass", note: "22,000 + 15,000 = 37,000 <= 75,000 cross-protocol cap" },
        ],
        replay: {
          proof_id: REPLAY_UUID(1102),
          reason: "Action violates the policy. Both Z3 and the AR engine agree.",
          elapsed_ms: 431,
          proof_gen_seconds: 8,
          verify: {
            valid: true,
            verify_ms: 47,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-borrow"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "$8,000 borrow that breaches the principal's cross-protocol exposure cap",
        expected: "UNSAT",
        blurb: "Every on-chain clause and every per-Floe check passes. Aggregate exposure across Floe plus other lending venues (clause 8) is the only failure, and it cannot live on-chain.",
        action:
          "Floe instant_borrow request from agent 0xC33CC. borrowAmount=8,000 USDC, collateralAmount=3 ETH (~$11,400), " +
          "maxInterestRateBps=1100, duration=2,592,000, onBehalfOf=0xPay333. " +
          "OperatorPermission: borrowLimit=20,000 USDC, borrowed=4,000 USDC, maxRateBps=1500, expiry=2027-01-01, onBehalfOfRestriction=0xPay333. " +
          "Collateral asset (ETH) moved +0.9% in the last 60 minutes. " +
          "Total outstanding principal across this principal's four agents is 26,000 USDC. Parent borrow ceiling is 50,000 USDC. " +
          "Selected lender wallet 0xLEND03 first transacted 91 days ago. " +
          "Cross-protocol outstanding (Floe 26,000 + other venues 44,500) = 70,500 USDC; cross-protocol cap = 75,000 USDC.",
        clauses: [
          { num: 1, status: "pass", note: "8,000 <= (20,000 - 4,000) = 16,000 remaining" },
          { num: 2, status: "pass", note: "1100 bps <= 1500 bps cap" },
          { num: 3, status: "pass", note: "now < expiry" },
          { num: 4, status: "pass", note: "onBehalfOf == restriction" },
          { num: 5, status: "pass", note: "ETH 60-min move 0.9% < 5%" },
          { num: 6, status: "pass", note: "26,000 + 8,000 = 34,000 <= 50,000 parent budget" },
          { num: 7, status: "pass", note: "lender wallet age 91 days >= 30" },
          { num: 8, status: "fail", note: "70,500 + 8,000 = 78,500 > 75,000 cross-protocol cap" },
        ],
        replay: {
          proof_id: REPLAY_UUID(1103),
          reason: "Action does not satisfy the policy. The AR engine identified that aggregate cross-protocol exposure exceeds the configured ceiling.",
          elapsed_ms: 415,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 45,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-borrow"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "verifiable-x402",
    shortName: "x402 spend",
    longName: "Verifiable x402 spend",
    audience: "Lenders funding agent working capital, principals running paid-API agents",
    envKey: "NEXT_PUBLIC_POLICY_ID_X402",
    clauses: X402_CLAUSES,
    presenterNotes: [
      "Highest-volume Floe surface (every paid API call passes through the facilitator). Pitch this as 'spending governance becomes a property of the credit line, not a promise.'",
      "Floe's /v1/x402/estimate already returns priceRaw, payTo, network, sessionSpendRemaining. Preflight is the rule layer that goes on top before /v1/proxy/fetch is called.",
      "The OFAC / sanctions clause (clause 4) is the institutional unlock. Clause 8 ties paid spend to the OperatorPermission borrow envelope: if a paid call would trigger an auto-borrow that exceeds OperatorPermission headroom, the call is blocked even when the per-call and daily caps are clean.",
    ],
    presets: [
      {
        label: "$0.50 weather API call, allowlisted seller, healthy session budget",
        expected: "SAT",
        blurb: "Inside per-call cap, daily cap, and session budget. payTo on allowlist, sanctions clear, USDC on Base, OperatorPermission envelope healthy.",
        action:
          "Floe x402/estimate result for agent 0xA11CE then POST /v1/proxy/fetch. " +
          "url=https://api.weatherco.example/forecast, method=GET. priceRaw=500,000 (0.50 USDC), asset=USDC, network=base, payTo=0xWEA101, scheme=exact. " +
          "Agent per-call cap 1,000,000 (1.00 USDC). Agent daily cap 50,000,000 (50 USDC). " +
          "session_spend_remaining 38,500,000 (38.50 USDC). Trailing-24h cumulative spend 12,400,000 (12.40 USDC). " +
          "OFAC/EU/UK/UN screen of payTo 0xWEA101 cleared at T-43 minutes. " +
          "0xWEA101 is on the principal's allowlist (entry weatherco-prod). chainId=8453. asset=USDC. " +
          "OperatorPermission status=approved, expiry=2027-01-01. Auto-borrow trigger = max(priceRaw - session_spend_remaining, 0) = 0; remaining headroom (borrowLimit - borrowed) = 12,000,000,000 (12,000 USDC).",
        clauses: [
          { num: 1, status: "pass", note: "priceRaw 500,000 <= per-call cap 1,000,000" },
          { num: 2, status: "pass", note: "session_spend_remaining 38,500,000 >= priceRaw 500,000" },
          { num: 3, status: "pass", note: "12,400,000 + 500,000 = 12,900,000 <= daily cap 50,000,000" },
          { num: 4, status: "pass", note: "OFAC/EU/UK/UN clear at T-43 min (< 24h)" },
          { num: 5, status: "pass", note: "0xWEA101 on principal allowlist" },
          { num: 6, status: "pass", note: "chainId 8453 == Base mainnet" },
          { num: 7, status: "pass", note: "asset == USDC" },
          { num: 8, status: "pass", note: "auto-borrow=0 fits under 12,000 USDC headroom; permission approved & unexpired" },
        ],
        replay: {
          proof_id: REPLAY_UUID(2101),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 380,
          proof_gen_seconds: 6,
          verify: {
            valid: true,
            verify_ms: 41,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-x402"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "$3.20 paid API call, payTo on UK HMT sanctions list",
        expected: "UNSAT",
        blurb: "Otherwise-clean call blocked outright by a sanctions hit on payTo. One match is enough.",
        action:
          "Floe x402/estimate result for agent 0xB22BD then POST /v1/proxy/fetch. " +
          "url=https://datafeed.example.io/quote, method=POST. priceRaw=3,200,000 (3.20 USDC), asset=USDC, network=base, payTo=0xSAN912, scheme=exact. " +
          "Agent per-call cap 5,000,000 (5.00 USDC). Agent daily cap 50,000,000. session_spend_remaining 41,000,000. Trailing-24h spend 6,300,000. " +
          "OFAC/EU/UK/UN screen of payTo 0xSAN912 at T-12 minutes: UK HMT match (entry RUS0421); OFAC/EU/UN clear. " +
          "0xSAN912 is on the principal's allowlist (entry datafeed-prod). Allowlist does NOT override sanctions. chainId=8453. asset=USDC. " +
          "OperatorPermission status=approved, expiry=2027-01-01. Auto-borrow trigger = 0; remaining headroom 9,000 USDC.",
        clauses: [
          { num: 1, status: "pass", note: "priceRaw 3,200,000 <= per-call cap 5,000,000" },
          { num: 2, status: "pass", note: "session_spend_remaining 41,000,000 >= priceRaw" },
          { num: 3, status: "pass", note: "6,300,000 + 3,200,000 = 9,500,000 <= daily cap" },
          { num: 4, status: "fail", note: "UK HMT sanctions match on payTo 0xSAN912 (entry RUS0421)" },
          { num: 5, status: "pass", note: "0xSAN912 on allowlist (does not override sanctions)" },
          { num: 6, status: "pass", note: "chainId 8453 == Base mainnet" },
          { num: 7, status: "pass", note: "asset == USDC" },
          { num: 8, status: "pass", note: "auto-borrow=0 fits under headroom; permission approved & unexpired" },
        ],
        replay: {
          proof_id: REPLAY_UUID(2102),
          reason: "Action violates the policy. The AR engine identified a sanctions match on the payment counterparty.",
          elapsed_ms: 412,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 46,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-x402"),
            claimed_result: "UNSAT",
          },
        },
      },
      {
        label: "$4.00 call that would auto-borrow past OperatorPermission headroom",
        expected: "UNSAT",
        blurb: "Per-call cap, daily cap, sanctions, network, asset all pass. Session is empty, so the paid call would trigger an auto-borrow that exceeds remaining (borrowLimit - borrowed) on the agent's OperatorPermission. Blocked at clause 8.",
        action:
          "Floe x402/estimate result for agent 0xC33CC then POST /v1/proxy/fetch. " +
          "url=https://oracle.example.io/tick, method=GET. priceRaw=4,000,000 (4.00 USDC), asset=USDC, network=base, payTo=0xORC777, scheme=exact. " +
          "Agent per-call cap 5,000,000 (5.00 USDC). Agent daily cap 50,000,000 (50.00 USDC). " +
          "session_spend_remaining 0 (session exhausted). Trailing-24h cumulative spend 9,990,000 (9.99 USDC). " +
          "OFAC/EU/UK/UN screen of payTo 0xORC777 cleared at T-7 minutes. 0xORC777 is on the principal's allowlist. chainId=8453. asset=USDC. " +
          "OperatorPermission status=approved, expiry=2027-01-01. borrowLimit=10,000,000 (10 USDC), borrowed=8,000,000 (8 USDC). " +
          "Auto-borrow trigger = max(4,000,000 - 0, 0) = 4,000,000 (4.00 USDC). Remaining headroom = 10,000,000 - 8,000,000 = 2,000,000 (2.00 USDC).",
        clauses: [
          { num: 1, status: "pass", note: "priceRaw 4,000,000 <= per-call cap 5,000,000" },
          { num: 2, status: "fail", note: "session_spend_remaining 0 < priceRaw 4,000,000" },
          { num: 3, status: "pass", note: "9,990,000 + 4,000,000 = 13,990,000 <= daily cap 50,000,000" },
          { num: 4, status: "pass", note: "OFAC/EU/UK/UN clear at T-7 min" },
          { num: 5, status: "pass", note: "0xORC777 on allowlist" },
          { num: 6, status: "pass", note: "chainId 8453 == Base mainnet" },
          { num: 7, status: "pass", note: "asset == USDC" },
          { num: 8, status: "fail", note: "auto-borrow 4,000,000 > remaining headroom 2,000,000 (borrowLimit - borrowed)" },
        ],
        replay: {
          proof_id: REPLAY_UUID(2103),
          reason: "Action does not satisfy the policy. The AR engine flagged that the auto-borrow this paid call would trigger does not fit under remaining OperatorPermission headroom.",
          elapsed_ms: 398,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 44,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-x402"),
            claimed_result: "UNSAT",
          },
        },
      },
    ],
  },
  {
    id: "verifiable-liquidation",
    shortName: "Liquidation",
    longName: "Verifiable liquidation",
    audience: "Floe lenders, liquidator-bot operators, borrowers seeking dispute primitives",
    envKey: "NEXT_PUBLIC_POLICY_ID_LIQ",
    clauses: LIQUIDATION_CLAUSES,
    presenterNotes: [
      "This is the slide that lands the institutional pitch. Today a borrower who feels marginally liquidated has Discord. With Verifiable Liquidation, they have a SNARK to challenge, or no SNARK, which is itself the signal.",
      "Three conditions only: loan genuinely underwater (currentLtvBps > liquidationLtvBps), circuit breaker not active (oracle deviation, sequencer uptime, oracle freshness), and expected USD profit clears the MIN_PROFIT_USD floor (default 10 USD).",
      "Path A (pilot): opt-in for liquidator-bot operators. They run Preflight for the receipt. Path B (the headline): Floe makes valid Preflight receipts a presumption of legitimacy at the protocol level. Liquidations with receipts presumed good-faith. Liquidations without subject to a borrower challenge window or fee penalty.",
    ],
    presets: [
      {
        label: "Loan at 92% LTV, oracle quiet, profit covers floor, clean liquidation",
        expected: "SAT",
        blurb: "Genuinely underwater (currentLtvBps > liquidationLtvBps), circuit breaker calm, expected profit comfortably above MIN_PROFIT_USD.",
        action:
          "Liquidator bot 0xLBOT01 calls liquidateLoan(loanId=0xLN_AAA1). Loan facts: collateral=4 ETH, debt=8,200 USDC, currentLtvBps=9,200, liquidationLtvBps=8,500. " +
          "Oracle ETH/USD reading at T-22s, age 22s. Deviation between latest and prior reading = 38 bps. Base sequencer continuously online for 50,400s (14h). " +
          "Expected USD profit = 280; configured MIN_PROFIT_USD = 10.",
        clauses: [
          { num: 1, status: "pass", note: "currentLtvBps 9,200 > liquidationLtvBps 8,500 (loan underwater)" },
          { num: 2, status: "pass", note: "deviation 38 bps < 1,500; sequencer up 50,400s >= 3,600; oracle age 22s <= 3,600" },
          { num: 3, status: "pass", note: "expectedProfit $280 > MIN_PROFIT_USD $10" },
        ],
        replay: {
          proof_id: REPLAY_UUID(3101),
          reason: "Action satisfies every clause of the policy.",
          elapsed_ms: 405,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 44,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-liquidation"),
            claimed_result: "SAT",
          },
        },
      },
      {
        label: "Liquidation during a 17% oracle price swing",
        expected: "UNSAT",
        blurb: "Loan looks underwater, but oracle deviation is in circuit-breaker territory. Wait, do not liquidate.",
        action:
          "Liquidator bot 0xLBOT02 calls liquidateLoan(loanId=0xLN_BBB2). Loan facts: collateral=2 ETH, debt=4,300 USDC, currentLtvBps=9,400, liquidationLtvBps=8,500. " +
          "Oracle ETH/USD reading at T-12s, age 12s. Deviation between latest and prior reading = 1,720 bps (17.2% jump). Base sequencer continuously online for 21,600s (6h). " +
          "Expected USD profit = 95; MIN_PROFIT_USD = 10.",
        clauses: [
          { num: 1, status: "pass", note: "currentLtvBps 9,400 > liquidationLtvBps 8,500" },
          { num: 2, status: "fail", note: "deviation 1,720 bps >= 1,500 bps (circuit-breaker territory)" },
          { num: 3, status: "pass", note: "expectedProfit $95 > MIN_PROFIT_USD $10" },
        ],
        replay: {
          proof_id: REPLAY_UUID(3102),
          reason: "Action violates the policy. Both Z3 and the AR engine agree the oracle deviation is in circuit-breaker territory.",
          elapsed_ms: 425,
          proof_gen_seconds: 7,
          verify: {
            valid: true,
            verify_ms: 46,
            proof_bytes_len: 92160,
            policy_hash: REPLAY_HASH("verifiable-liquidation"),
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
