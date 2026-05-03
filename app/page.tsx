"use client";

import { useState, useEffect, useRef } from "react";

const POLICY_ID = process.env.NEXT_PUBLIC_POLICY_ID ?? "";
const CALENDLY_URL = process.env.NEXT_PUBLIC_CALENDLY_URL ?? "https://calendly.com/";
const VERIFY_URL = "https://api.icme.io/v1/verifyProof";

const POLICY_TEXT = [
  "No single transaction may exceed $500.",
  "Cumulative spending in any 24-hour period may not exceed $5,000.",
  "Cumulative spending in any 30-day period may not exceed $50,000.",
  "Payments are only permitted to vendors on the approved vendor list.",
  "Any transaction over $200 requires a documented business justification of at least 20 characters.",
  'No payments may be sent to vendors with verification status equal to "pending" or "unverified."',
  "Transactions over $400 trigger a human-in-the-loop approval requirement.",
];

interface ClauseEval {
  num: number;
  status: "pass" | "fail";
  note: string;
}

interface Preset {
  label: string;
  expected: "SAT" | "UNSAT";
  blurb: string;
  action: string;
  clauses: ClauseEval[];
}

const PRESETS: Preset[] = [
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
  },
];

function formatMs(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function normalizeReason(reason: string, result: "SAT" | "UNSAT"): string {
  if (!reason) return "";
  if (/AR blocked.*local solver: SAT/i.test(reason)) {
    return "Action does not satisfy the policy. Z3 found the structural constraints met, but the AR engine identified a semantic violation against the natural-language rules.";
  }
  if (/^Satisfiable$/i.test(reason)) return "Action satisfies every clause of the policy.";
  if (/^Unsatisfiable.*confirmed by AR/i.test(reason)) return "Action violates the policy. Both Z3 and the AR engine agree.";
  return reason;
}

function Disclosure({
  summary,
  children,
  defaultOpen = false,
  tone = "default",
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "default" | "muted";
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      className={`rounded border ${
        tone === "muted" ? "border-stone-200 bg-stone-50" : "border-stone-200 bg-white"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs text-stone-700 hover:text-stone-900"
      >
        <span className="flex-1">{summary}</span>
        <span className="shrink-0 font-mono text-[10px] text-stone-500">{open ? "[ - hide ]" : "[ + show ]"}</span>
      </button>
      {open && <div className="border-t border-stone-200 px-3 py-3 text-xs text-stone-700">{children}</div>}
    </div>
  );
}

interface CheckResponse {
  result: "SAT" | "UNSAT";
  blocked: boolean;
  reason: string;
  proof_id?: string;
  check_id?: string;
  elapsed_ms: number;
}

function byteLen(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

function WireBlock({
  title,
  description,
  request,
  response,
  curlNote,
}: {
  title: string;
  description: React.ReactNode;
  request: { method: string; url: string; headers: Record<string, string>; body: unknown };
  response: unknown | null;
  curlNote?: React.ReactNode;
}) {
  const headerLines = Object.entries(request.headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const headerCount = Object.keys(request.headers).length;
  const reqBytes = byteLen(request.body);
  const resBytes = byteLen(response);
  const bodyText = JSON.stringify(request.body, null, 2);
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-700">{title}</div>
      <div className="mb-3 text-xs text-stone-600">{description}</div>
      <Disclosure
        tone="muted"
        summary={
          <span>
            <span className="font-mono text-[11px] text-emerald-700">{request.method}</span>{" "}
            <span className="font-mono text-[11px] text-stone-900">{request.url}</span>
            <span className="ml-2 text-[10px] text-stone-500">
              {headerCount} header{headerCount === 1 ? "" : "s"} &middot; body {reqBytes} B
            </span>
          </span>
        }
      >
        <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">headers</div>
        <pre className="mb-3 overflow-x-auto rounded bg-stone-100 p-3 font-mono text-[11px] leading-relaxed text-stone-900">
          {headerLines}
        </pre>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">body</div>
        <pre className="overflow-x-auto rounded bg-stone-100 p-3 font-mono text-[11px] leading-relaxed text-stone-900">
          {bodyText}
        </pre>
      </Disclosure>
      <div className="mt-2">
        <Disclosure
          tone="muted"
          summary={
            <span>
              <span className="font-mono text-[11px] text-[#346DDB]">response</span>
              <span className="ml-2 text-[10px] text-stone-500">
                {response ? `${resBytes} B JSON` : "(awaiting response...)"}
              </span>
            </span>
          }
        >
          <pre className="overflow-x-auto rounded bg-stone-100 p-3 font-mono text-[11px] leading-relaxed text-stone-900">
            {response ? JSON.stringify(response, null, 2) : "(awaiting response...)"}
          </pre>
        </Disclosure>
      </div>
      {curlNote && (
        <div className="mt-2">
          <Disclosure tone="muted" summary={<span className="text-stone-600">Try it from your terminal</span>}>
            <div className="text-[11px] text-stone-700">{curlNote}</div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}

interface VerifyResponse {
  valid?: boolean;
  verify_ms?: number;
  proof_bytes_len?: number;
  [k: string]: unknown;
}

export default function Page() {
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verify, setVerify] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [proofReady, setProofReady] = useState(false);
  const [proofGenSeconds, setProofGenSeconds] = useState(0);
  const proofGenStartRef = useRef<number | null>(null);
  const [tab, setTab] = useState<"decision" | "wire" | "receipt">("decision");

  // As soon as we have a proof_id, start a background poll against
  // /api/proof-status until the SNARK is ready. This lets us show a clean
  // separation between proof generation (seconds) and verification (sub-second).
  useEffect(() => {
    if (!check?.proof_id) return;
    setProofReady(false);
    setProofGenSeconds(0);
    proofGenStartRef.current = Date.now();
    let cancelled = false;

    const tick = setInterval(() => {
      if (proofGenStartRef.current && !cancelled) {
        setProofGenSeconds(Math.round((Date.now() - proofGenStartRef.current) / 1000));
      }
    }, 1000);

    const stop = () => {
      cancelled = true;
      clearInterval(tick);
    };

    (async () => {
      while (!cancelled) {
        try {
          const res = await fetch(`/api/proof-status?proof_id=${check.proof_id}`);
          const data = (await res.json()) as { ready: boolean };
          if (data.ready) {
            if (!cancelled) {
              // Snap to the exact seconds-to-ready value, then stop the ticker.
              if (proofGenStartRef.current) {
                setProofGenSeconds(Math.round((Date.now() - proofGenStartRef.current) / 1000));
              }
              setProofReady(true);
            }
            stop();
            return;
          }
        } catch {
          // keep polling
        }
        await new Promise((r) => setTimeout(r, 3000));
        if (Date.now() - (proofGenStartRef.current ?? Date.now()) > 180_000) {
          stop();
          return;
        }
      }
    })();

    return stop;
  }, [check?.proof_id]);

  const policyConfigured = Boolean(POLICY_ID);

  async function runCheck(preset: Preset) {
    if (!policyConfigured) {
      setCheckError(
        "NEXT_PUBLIC_POLICY_ID is not configured. Run `npm run policy:compile` and redeploy."
      );
      return;
    }
    setActivePreset(preset);
    setCheckLoading(true);
    setCheck(null);
    setCheckError(null);
    setVerify(null);
    setVerifyError(null);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy_id: POLICY_ID, action: preset.action }),
      });
      const data = (await res.json()) as CheckResponse | { error: string; detail?: string };
      if (!res.ok || "error" in data) {
        const errorData = data as { error: string; detail?: string };
        setCheckError(errorData.error + (errorData.detail ? `: ${errorData.detail}` : ""));
      } else {
        setCheck(data as CheckResponse);
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckLoading(false);
    }
  }

  async function runVerify() {
    if (!check?.proof_id) return;
    setVerifyLoading(true);
    setVerify(null);
    setVerifyError(null);
    try {
      const res = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof_id: check.proof_id }),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 409) {
          setVerifyError("Proof was already consumed (single-use, HTTP 409). Run a new check and try again.");
        } else if (res.status === 404) {
          setVerifyError("Proof is not yet ready. Wait a few seconds and try again.");
        } else {
          setVerifyError(`verifyProof failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return;
      }
      const data = (await res.json()) as VerifyResponse;
      setVerify(data);
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setVerifyLoading(false);
    }
  }

  function copyProofId() {
    if (!check?.proof_id) return;
    navigator.clipboard.writeText(check.proof_id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <div className="text-xs font-semibold uppercase tracking-widest text-[#346DDB]">Preflight Proofs Playground</div>
          <h1 className="mt-1 text-2xl font-semibold text-stone-900 sm:text-3xl">
            Cryptographic receipts for AI agent actions.
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-stone-600">
            AI agents are starting to spend real money on behalf of companies. How do you prove an autonomous
            action stayed inside the rules &mdash; without trusting the agent, the AI vendor, or even Preflight
            itself? Every action below generates a tamper-evident receipt: Preflight first decides whether the
            action satisfies your policy (SAT/UNSAT), then issues a SNARK that an auditor, a customer, or a
            regulator can verify in milliseconds against ICME&rsquo;s public endpoint &mdash; without ever
            seeing your business data.
          </p>
        </div>
        <a href="https://icme.io" target="_blank" rel="noreferrer" className="shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://lh3.googleusercontent.com/zIz4Vb9ksY4pKhfHUT2MyVeMeNWdviRQIDnVVL9fCBofCGvKFi-8s7JHbjFjD3Baoxbk9Q6iLAzoj3jKxf_VNGxd78h5beg3KQ=s0"
            alt="ICME Labs"
            className="h-10 w-auto sm:h-12"
          />
        </a>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
        {/* LEFT COLUMN: policy + presets, sticky on desktop */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          <section>
            <Disclosure
              summary={
                <span>
                  <span className="font-semibold uppercase tracking-wider text-stone-900">Active policy</span>
                  <span className="ml-2 text-stone-500">
                    Agent spending guardrail &middot; {POLICY_TEXT.length} clauses (no $500/tx, $5K/24h, $50K/30d, allowlist required, &hellip;)
                  </span>
                </span>
              }
            >
              <ol className="list-decimal space-y-1 pl-4 text-xs text-stone-600">
                {POLICY_TEXT.map((clause, i) => (
                  <li key={i}>{clause}</li>
                ))}
              </ol>
            </Disclosure>
          </section>

          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-700">
              Pick a proposed agent action
            </div>
            <div className="space-y-2">
              {PRESETS.map((preset) => {
                const isActive = activePreset?.label === preset.label;
                return (
                  <button
                    key={preset.label}
                    onClick={() => runCheck(preset)}
                    disabled={checkLoading}
                    className={`block w-full rounded-lg border p-3 text-left transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      isActive
                        ? "border-[#346DDB] bg-blue-50"
                        : "border-stone-200 bg-stone-100 hover:border-stone-400"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-xs font-medium text-stone-900">{preset.label}</div>
                      <div
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                          preset.expected === "SAT"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {preset.expected}
                      </div>
                    </div>
                    <div className="mt-1 text-[11px] text-stone-600">{preset.blurb}</div>
                  </button>
                );
              })}
            </div>
            {!policyConfigured && (
              <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-800">
                <code>NEXT_PUBLIC_POLICY_ID</code> is not set. Run <code>npm run policy:compile</code> and
                redeploy.
              </div>
            )}
          </section>

          <section className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="text-xs text-stone-700">Want this in your stack?</div>
            <a
              href={CALENDLY_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block rounded border border-stone-300 px-3 py-1.5 text-xs text-stone-900 hover:border-stone-400"
            >
              Talk to the founders &rarr;
            </a>
          </section>

          <section className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-stone-700">
              Going deeper
            </div>

            <Disclosure
              summary={
                <span>
                  <span className="font-semibold text-stone-900">What&rsquo;s in the receipt vs. what isn&rsquo;t</span>
                </span>
              }
            >
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-700">In the receipt</div>
                  <ul className="space-y-1 text-stone-600">
                    <li>&middot; <code>policy_hash</code> &mdash; which compiled ruleset</li>
                    <li>&middot; <code>claimed_result</code> &mdash; SAT or UNSAT</li>
                    <li>&middot; <code>proof_id</code> &mdash; reference for verifyProof</li>
                    <li>&middot; <code>verify_ms</code>, <code>proof_bytes_len</code></li>
                    <li>&middot; cryptographic SNARK that binds them together</li>
                  </ul>
                </div>
                <div>
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-rose-700">NOT in the receipt</div>
                  <ul className="space-y-1 text-stone-600">
                    <li>&middot; the underlying customer / vendor data</li>
                    <li>&middot; transaction amounts, account numbers</li>
                    <li>&middot; your approved-vendor list</li>
                    <li>&middot; the business justification text</li>
                    <li>&middot; cumulative spend totals</li>
                    <li>&middot; the policy text itself (in confidential mode)</li>
                  </ul>
                </div>
              </div>
            </Disclosure>

            <Disclosure
              summary={
                <span>
                  <span className="font-semibold text-stone-900">Run this against your own policy</span>
                </span>
              }
            >
              <ol className="list-decimal space-y-2 pl-4 text-stone-600">
                <li>
                  Write your policy in plain English (one rule per line). The compiler accepts the same
                  natural-language form you see above.
                </li>
                <li>
                  Compile it once:{" "}
                  <code className="rounded bg-stone-100 px-1 font-mono text-[11px] text-stone-900">
                    POST /v1/makeRules
                  </code>{" "}
                  with your API key. You get back a <code>policy_id</code>.
                </li>
                <li>
                  Swap the <code>policy_id</code> in this playground (or in your own agent orchestrator) and
                  every <code>checkIt</code> call will be evaluated against your rules.
                </li>
              </ol>
              <div className="mt-3 text-[11px] text-stone-500">
                Compilation is a one-time cost per policy version. Once compiled, evaluation is fast and the
                <code> policy_id</code> is reusable across as many actions as you want to check.
              </div>
            </Disclosure>

            <Disclosure
              summary={
                <span>
                  <span className="font-semibold text-stone-900">What changes for a confidential policy</span>
                </span>
              }
            >
              <p className="mb-2">
                In the default flow, ICME sees your compiled policy text on the server side. For policies
                that encode trade secrets, regulatory positions, or internal pricing, the same flow can run
                in confidential mode.
              </p>
              <p className="mb-2">
                In confidential mode, the policy is committed to a hash and the satisfiability check itself
                runs as a zero-knowledge proof. The wire payload and the public verifyProof receipt look
                the same as today &mdash; same <code>policy_hash</code>, same <code>claimed_result</code>,
                same sub-second verification.
              </p>
              <p>
                The difference: ICME never sees your policy text or your action inputs. Anyone can still
                independently verify the receipt, but no one (including ICME) can reconstruct what was
                checked.
              </p>
            </Disclosure>
          </section>
        </aside>

        {/* RIGHT COLUMN: tabbed (Decision / Wire / Receipt) */}
        <div className="rounded-lg border border-stone-200 bg-white">
          {/* Tab bar */}
          <div className="flex items-center gap-1 border-b border-stone-200 px-2 pt-2">
            {([
              { id: "decision", label: "Decision", enabled: true, dot: Boolean(check) },
              { id: "wire", label: "API call", enabled: Boolean(check && activePreset), dot: false },
              { id: "receipt", label: "Receipt", enabled: Boolean(verify || verifyError), dot: Boolean(verify) },
            ] as const).map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => t.enabled && setTab(t.id)}
                  disabled={!t.enabled}
                  className={`relative -mb-px rounded-t-md border px-3 py-2 text-xs transition ${
                    active
                      ? "border-stone-200 border-b-white bg-white text-[#346DDB] font-semibold"
                      : t.enabled
                      ? "border-transparent text-stone-600 hover:text-stone-900"
                      : "border-transparent text-stone-400 cursor-not-allowed"
                  }`}
                >
                  {t.label}
                  {t.dot && !active && (
                    <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 align-middle" />
                  )}
                </button>
              );
            })}
          </div>

          <div className="p-5">
            {/* DECISION TAB */}
            {tab === "decision" && (
              <div>
                {!check && !checkLoading && !checkError && (
                  <div className="rounded border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
                    Pick a preset on the left to run a real Preflight check.
                  </div>
                )}
                {checkLoading && (
                  <div className="text-sm text-stone-600">
                    <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Step 1 of 2 &middot; Decision</div>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#346DDB] align-middle" />{" "}
                    Computing SAT/UNSAT: parsing intent &rarr; Z3 solver &rarr; automated reasoning&hellip;
                  </div>
                )}
                {checkError && (
                  <div className="text-sm text-rose-700">
                    <div className="mb-1 font-medium">checkIt failed</div>
                    <div className="font-mono text-xs">{checkError}</div>
                  </div>
                )}
                {check && (
                  <div>
                    <div className="mb-2 flex items-baseline justify-between">
                      <div className="text-[10px] uppercase tracking-wider text-stone-500">Step 1 of 2 &middot; Decision</div>
                      <div className="text-[10px] uppercase tracking-wider text-stone-400">parse &rarr; Z3 &rarr; AR</div>
                    </div>
                    <div className="flex items-center justify-between">
                      <div
                        className={`inline-block rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider ${
                          check.result === "SAT"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        {check.result}
                        {check.blocked ? " (blocked)" : " (allowed)"}
                      </div>
                      <div className="text-xs text-stone-500">{formatMs(check.elapsed_ms)}</div>
                    </div>
                    {check.reason && (
                      <div className="mt-3 text-sm text-stone-700">{normalizeReason(check.reason, check.result)}</div>
                    )}

                    {activePreset && (
                      <div className="mt-4 space-y-2">
                        <Disclosure
                          summary={
                            <span>
                              <span className="font-semibold text-stone-900">Per-clause evaluation</span>
                              <span className="ml-2 text-stone-500">
                                {activePreset.clauses.filter((c) => c.status === "pass").length} pass &middot;{" "}
                                {activePreset.clauses.filter((c) => c.status === "fail").length} fail
                              </span>
                            </span>
                          }
                        >
                          <ul className="space-y-1">
                            {activePreset.clauses.map((c) => (
                              <li key={c.num} className="flex items-start gap-2">
                                <span
                                  className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                                    c.status === "pass"
                                      ? "bg-emerald-100 text-emerald-800"
                                      : "bg-rose-100 text-rose-800"
                                  }`}
                                >
                                  {c.status === "pass" ? "PASS" : "FAIL"}
                                </span>
                                <span className="text-stone-600">
                                  <span className="text-stone-700">Clause {c.num}.</span> {c.note}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </Disclosure>

                        <Disclosure
                          summary={
                            <span>
                              <span className="font-semibold text-stone-900">How SAT/UNSAT is computed</span>
                              <span className="ml-2 text-stone-500">parse &rarr; Z3 &rarr; AR</span>
                            </span>
                          }
                        >
                          <ol className="list-decimal space-y-2 pl-4 text-stone-600">
                            <li>
                              <span className="text-stone-900">Parse intent.</span> The natural-language action
                              string is parsed into structured constraints (amount, vendor, justification, totals).
                            </li>
                            <li>
                              <span className="text-stone-900">Z3 solver.</span> The structural constraints are
                              checked against the policy as a satisfiability problem. Returns SAT or UNSAT.
                            </li>
                            <li>
                              <span className="text-stone-900">Automated reasoning (AR).</span> A second engine
                              re-checks the action against the natural-language policy semantics, catching
                              violations Z3 cannot model. If Z3 and AR disagree, the system fails closed.
                            </li>
                          </ol>
                          <p className="mt-3 text-[11px] text-stone-500">
                            The decision is final at this point. Sealing it into a SNARK happens next, in step 2.
                          </p>
                        </Disclosure>
                      </div>
                    )}

                    {check.proof_id ? (
                      <div className="mt-6 border-t border-stone-200 pt-4">
                        <div className="mb-3 flex items-baseline justify-between">
                          <div className="text-[10px] uppercase tracking-wider text-stone-500">Step 2 of 2 &middot; Cryptographic receipt</div>
                          <div className="text-[10px] uppercase tracking-wider text-stone-400">SNARK &rarr; verify</div>
                        </div>
                        <p className="mb-3 text-xs text-stone-600">
                          The SAT/UNSAT decision above is final. Now Preflight seals it into a zero-knowledge proof
                          that anyone can verify independently &mdash; no API key, no access to your policy or inputs.
                        </p>
                        <div className="mt-3">
                          <Disclosure
                            tone="muted"
                            summary={
                              <span>
                                <span className="font-semibold text-stone-900">How the receipt is sealed</span>
                                <span className="ml-2 text-stone-500">decision &rarr; SNARK &rarr; public verifyProof</span>
                              </span>
                            }
                          >
                            <ol className="list-decimal space-y-2 pl-4 text-stone-600">
                              <li>
                                <span className="text-stone-900">Seal the decision.</span> The SAT/UNSAT outcome plus the
                                <code> policy_hash</code> are committed inside a SNARK circuit. This is the seconds-long
                                step you see counting up below.
                              </li>
                              <li>
                                <span className="text-stone-900">Publish a proof_id.</span> Once sealed, Preflight returns
                                a stable identifier you can hand to anyone, including auditors who hold no API key.
                              </li>
                              <li>
                                <span className="text-stone-900">Independent verification.</span> A third party hits the
                                public <code>verifyProof</code> endpoint and gets back <code>valid: true</code> in under
                                a second &mdash; without ever seeing your action, your vendor list, or your policy text.
                              </li>
                            </ol>
                          </Disclosure>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <span className="text-xs uppercase tracking-wider text-stone-500">proof_id</span>
                          <code className="break-all rounded bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-900">
                            {check.proof_id}
                          </code>
                          <button
                            onClick={copyProofId}
                            className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-700 hover:border-stone-400"
                          >
                            {copied ? "copied" : "copy"}
                          </button>
                        </div>

                        <div className="mt-3 flex items-center gap-2 text-xs">
                          {proofReady ? (
                            <>
                              <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />
                              <span className="text-emerald-700">
                                SNARK ready ({proofGenSeconds}s to generate). Verification is sub-second.
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                              <span className="text-amber-800">
                                SNARK generating on the backend... {proofGenSeconds}s
                              </span>
                            </>
                          )}
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <button
                            onClick={runVerify}
                            disabled={verifyLoading || !proofReady}
                            className="rounded bg-[#346DDB] px-4 py-2 text-sm font-medium text-white hover:bg-[#2756b8] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {verifyLoading
                              ? "verifying..."
                              : proofReady
                              ? "Verify this proof independently"
                              : "Waiting for SNARK to finalize..."}
                          </button>

                          {/* Inline verify badges — appear right next to the button */}
                          {verify && (
                            <>
                              <div
                                className={`inline-block rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider ${
                                  verify.valid ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                                }`}
                              >
                                valid: {String(verify.valid ?? "unknown")}
                              </div>
                              {typeof verify.verify_ms === "number" && (
                                <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
                                  verified in <span className="font-semibold text-stone-900">{formatMs(verify.verify_ms)}</span>
                                </div>
                              )}
                              {typeof verify.proof_bytes_len === "number" && (
                                <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
                                  <span className="font-semibold text-stone-900">{(verify.proof_bytes_len / 1024).toFixed(1)} KB</span>
                                </div>
                              )}
                            </>
                          )}
                          {verifyError && <div className="text-xs text-rose-700">{verifyError}</div>}
                        </div>

                        {verify && (
                          <div className="mt-2 text-[11px] text-stone-500">
                            Full signed receipt available in the <button className="underline hover:text-stone-700" onClick={() => setTab("receipt")}>Receipt</button> tab. Request and response payloads in the <button className="underline hover:text-stone-700" onClick={() => setTab("wire")}>API call</button> tab.
                          </div>
                        )}

                        <div className="mt-3">
                          <Disclosure
                            summary={
                              <span>
                                <span className="font-semibold text-stone-900">Why generation is slow but verify is fast</span>
                                <span className="ml-2 text-stone-500">the SNARK asymmetry</span>
                              </span>
                            }
                          >
                            <p className="mb-2">
                              Generating a SNARK requires evaluating the entire policy circuit and producing a
                              ~90 KB proof &mdash; that is the seconds-long step.
                            </p>
                            <p className="mb-2">
                              Verifying a SNARK only requires checking a small number of elliptic-curve pairings
                              against the proof &mdash; that is the sub-second step, and it does not depend on the
                              size of the original policy.
                            </p>
                            <p>
                              That asymmetry is the whole point: anyone can verify cheaply and independently,
                              without re-running your policy or seeing your inputs.
                            </p>
                          </Disclosure>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 text-xs text-stone-500">
                        No proof_id returned (UNSAT checks may not produce a ZK proof on every deployment).
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* WIRE TAB */}
            {tab === "wire" && (
              <div>
                {!check || !activePreset ? (
                  <div className="rounded border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
                    Run a check first to inspect the API call payloads.
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-stone-500">
                      Your agent orchestrator makes one outbound call to Preflight before each action. Preflight returns
                      a small signed receipt: the SAT/UNSAT decision, a policy version hash, and a proof_id pointing to a
                      ZK proof. None of your underlying business data crosses the wire &mdash; only the action description
                      and the outcome.
                    </p>
                    <WireBlock
                      title="1. Your agent orchestrator → Preflight"
                      description={
                        <>
                          Single outbound call before the agent acts. The <code>action</code> field is the natural-language
                          description of what the agent wants to do; <code>policy_id</code> identifies which compiled
                          ruleset to verify against. Sensitive fields can be hashed before transmission, and for
                          confidential policies the same flow runs as a zero-knowledge proof so Preflight never sees
                          the policy or the inputs.
                        </>
                      }
                      request={{
                        method: "POST",
                        url: "https://api.icme.io/v1/checkIt",
                        headers: {
                          "Content-Type": "application/json",
                          "X-API-Key": "sk-smt-... (kept server-side, never in the browser)",
                        },
                        body: { policy_id: POLICY_ID, action: activePreset.action },
                      }}
                      response={{
                        result: check.result,
                        blocked: check.blocked,
                        reason: check.reason,
                        proof_id: check.proof_id,
                        check_id: check.check_id,
                      }}
                      curlNote={
                        <>
                          Run it yourself with your own key:{" "}
                          <code>
                            curl -X POST -H &apos;X-API-Key: $ICME_API_KEY&apos; -H &apos;Content-Type:
                            application/json&apos; -d &apos;{`{"policy_id":"...","action":"..."}`}&apos;
                            https://api.icme.io/v1/checkIt
                          </code>
                        </>
                      }
                    />
                    {check.proof_id && (
                      <WireBlock
                        title="2. Anyone → Preflight (independent verification, no API key)"
                        description={
                          <>
                            The <code>verifyProof</code> endpoint is public. An external auditor verifies the
                            cryptographic receipt the same way you verify a digital signature: by checking the math,
                            not by trusting any party in the chain.
                          </>
                        }
                        request={{
                          method: "POST",
                          url: "https://api.icme.io/v1/verifyProof",
                          headers: { "Content-Type": "application/json" },
                          body: { proof_id: check.proof_id },
                        }}
                        response={verify}
                        curlNote={
                          <>
                            Run it yourself, no auth:{" "}
                            <code>
                              curl -X POST -H &apos;Content-Type: application/json&apos; -d &apos;{`{"proof_id":"${check.proof_id}"}`}&apos;
                              https://api.icme.io/v1/verifyProof
                            </code>
                          </>
                        }
                      />
                    )}
                  </div>
                )}
              </div>
            )}

            {/* RECEIPT TAB */}
            {tab === "receipt" && (
              <div>
                {!verify && !verifyError ? (
                  <div className="rounded border border-dashed border-stone-200 p-8 text-center text-sm text-stone-500">
                    Click &ldquo;Verify this proof independently&rdquo; in the Decision tab to populate the receipt.
                  </div>
                ) : verifyError ? (
                  <div className="text-sm text-rose-700">{verifyError}</div>
                ) : (
                  <div className="space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        className={`inline-block rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider ${
                          verify!.valid ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                        }`}
                      >
                        valid: {String(verify!.valid ?? "unknown")}
                      </div>
                      {typeof verify!.verify_ms === "number" && (
                        <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
                          verified in <span className="font-semibold text-stone-900">{formatMs(verify!.verify_ms)}</span>
                        </div>
                      )}
                      {typeof verify!.proof_bytes_len === "number" && (
                        <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
                          proof size{" "}
                          <span className="font-semibold text-stone-900">{(verify!.proof_bytes_len / 1024).toFixed(1)} KB</span>
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">
                        full signed receipt
                      </div>
                      <pre className="max-h-96 overflow-auto rounded bg-stone-100 p-3 font-mono text-[11px] leading-relaxed text-stone-900">
                        {JSON.stringify(verify, null, 2)}
                      </pre>
                    </div>

                    <div>
                      <div className="mb-2 text-[10px] uppercase tracking-wider text-stone-500">
                        what each field means
                      </div>
                      <ul className="space-y-1 text-xs text-stone-600">
                        <li>
                          <code className="text-stone-900">valid</code> &mdash; the cryptographic check passed.
                          The proof was generated by Preflight against the policy identified by <code>policy_hash</code>.
                        </li>
                        <li>
                          <code className="text-stone-900">verify_ms</code> &mdash; how long this verification took.
                          Independent of policy size.
                        </li>
                        <li>
                          <code className="text-stone-900">proof_bytes_len</code> &mdash; size of the SNARK proof.
                          Constant-ish regardless of how complex the policy is.
                        </li>
                        <li>
                          <code className="text-stone-900">policy_hash</code> (when present) &mdash; commits to the
                          exact ruleset that was checked, so the auditor knows which version of policy passed.
                        </li>
                        <li>
                          <code className="text-stone-900">claimed_result</code> (when present) &mdash; the SAT/UNSAT
                          outcome that this proof attests to.
                        </li>
                      </ul>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <footer className="mt-12 border-t border-stone-200 pt-6 text-xs text-stone-500">
        Built on the ICME Preflight API. Proofs are generated and verified against{" "}
        <a className="underline" href="https://api.icme.io/v1" target="_blank" rel="noreferrer">
          api.icme.io
        </a>
        . Docs at{" "}
        <a className="underline" href="https://docs.icme.io" target="_blank" rel="noreferrer">
          docs.icme.io
        </a>
        .
      </footer>
    </main>
  );
}
