"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { POLICIES, policyById, type Policy, type Preset } from "./policies-data";
import { curlSnippet, tsSnippet, pythonSnippet } from "./snippets";

const CALENDLY_URL = process.env.NEXT_PUBLIC_CALENDLY_URL ?? "https://calendly.com/";
const VERIFY_URL = "https://api.icme.io/v1/verifyProof";

// Per-policy env keys; legacy NEXT_PUBLIC_POLICY_ID is honored as a default
// for the spending policy so existing deployments keep working.
const ENV_POLICY_IDS: Record<string, string> = {
  spending: process.env.NEXT_PUBLIC_POLICY_ID_SPENDING ?? process.env.NEXT_PUBLIC_POLICY_ID ?? "",
  refunds: process.env.NEXT_PUBLIC_POLICY_ID_REFUNDS ?? "",
  "data-access": process.env.NEXT_PUBLIC_POLICY_ID_DATA ?? "",
  procurement: process.env.NEXT_PUBLIC_POLICY_ID_PROC ?? "",
};

const PROOF_TIMEOUT_MS = 90_000;
const HEALTH_REFRESH_MS = 60_000;

// ---------- helpers ---------------------------------------------------------

function formatMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}

function normalizeReason(reason: string, _result: "SAT" | "UNSAT"): string {
  if (!reason) return "";
  if (/AR blocked.*local solver: SAT/i.test(reason)) {
    return "Action does not satisfy the policy. Z3 found the structural constraints met, but the AR engine identified a semantic violation against the natural-language rules.";
  }
  if (/^Satisfiable$/i.test(reason)) return "Action satisfies every clause of the policy.";
  if (/^Unsatisfiable.*confirmed by AR/i.test(reason)) return "Action violates the policy. Both Z3 and the AR engine agree.";
  return reason;
}

function byteLen(v: unknown): number {
  if (v === null || v === undefined) return 0;
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

function b64urlEncode(s: string): string {
  if (typeof window === "undefined") return "";
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  if (typeof window === "undefined") return "";
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return decodeURIComponent(escape(atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"))));
}

// ---------- types -----------------------------------------------------------

interface CheckResponse {
  result: "SAT" | "UNSAT";
  blocked: boolean;
  reason: string;
  proof_id?: string;
  check_id?: string;
  elapsed_ms: number;
}

interface VerifyResponse {
  valid?: boolean;
  verify_ms?: number;
  proof_bytes_len?: number;
  policy_hash?: string;
  claimed_result?: string;
  [k: string]: unknown;
}

interface SharePayload {
  policy_id: string;
  policy_short: string;
  preset_label: string;
  action: string;
  check: CheckResponse;
  verify: VerifyResponse;
  ts: number;
  replay?: boolean;
}

type HealthStatus = "ok" | "degraded" | "unknown";

// ---------- small reusable bits --------------------------------------------

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

function HealthDot({ status, latencyMs }: { status: HealthStatus; latencyMs: number | null }) {
  const color =
    status === "ok" ? "bg-emerald-500" : status === "degraded" ? "bg-rose-500" : "bg-stone-300";
  const label =
    status === "ok"
      ? `Live${latencyMs !== null ? ` · ${latencyMs}ms` : ""}`
      : status === "degraded"
      ? "Degraded — falling back to replays"
      : "Checking…";
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-stone-200 bg-white px-2 py-1 text-[11px] text-stone-700">
      <span className={`h-2 w-2 rounded-full ${color} ${status === "unknown" ? "animate-pulse" : ""}`} />
      <span>{label}</span>
    </span>
  );
}

function ArchitectureDiagram() {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-stone-700">
        Trust model — what crosses each line
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <div className="rounded border border-stone-200 bg-stone-50 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Your stack</div>
          <div className="text-xs font-semibold text-stone-900">Your agent</div>
          <div className="mt-2 text-[11px] text-stone-600">
            Holds your <code>ICME_API_KEY</code>. Calls <code>checkIt</code> before every consequential
            action. Sees the SAT/UNSAT decision and a <code>proof_id</code>.
          </div>
        </div>
        <div className="rounded border border-[#346DDB] bg-blue-50 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[#346DDB]">Preflight (ICME)</div>
          <div className="text-xs font-semibold text-stone-900">Decision + SNARK</div>
          <div className="mt-2 text-[11px] text-stone-700">
            Evaluates the action against your compiled <code>policy_id</code> using Z3 + AR, then seals
            the decision into a SNARK. In confidential mode, sees only commitments — never the action
            text or the policy text.
          </div>
        </div>
        <div className="rounded border border-stone-200 bg-stone-50 p-3">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">External</div>
          <div className="text-xs font-semibold text-stone-900">Auditor / counterparty / regulator</div>
          <div className="mt-2 text-[11px] text-stone-600">
            Holds <em>no</em> API key. Calls <code>verifyProof</code> with just the <code>proof_id</code>.
            Gets <code>valid: true</code> in milliseconds. Cannot reconstruct the action, your data,
            or your policy text.
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-[11px] text-stone-700 sm:grid-cols-2">
        <div className="rounded bg-stone-100 p-2">
          <span className="font-mono text-emerald-700">→</span>{" "}
          <span className="font-semibold">Your agent → Preflight:</span> the action description and{" "}
          <code>policy_id</code>. <span className="text-stone-500">(authenticated, server-side)</span>
        </div>
        <div className="rounded bg-stone-100 p-2">
          <span className="font-mono text-[#346DDB]">←</span>{" "}
          <span className="font-semibold">Preflight → your agent:</span> SAT/UNSAT, reason, and{" "}
          <code>proof_id</code>. <span className="text-stone-500">(small JSON, no proof body)</span>
        </div>
        <div className="rounded bg-stone-100 p-2">
          <span className="font-mono text-stone-500">→</span>{" "}
          <span className="font-semibold">Anyone → Preflight:</span> just the <code>proof_id</code>.{" "}
          <span className="text-stone-500">(no auth)</span>
        </div>
        <div className="rounded bg-stone-100 p-2">
          <span className="font-mono text-stone-500">←</span>{" "}
          <span className="font-semibold">Preflight → anyone:</span>{" "}
          <code>{`{ valid, verify_ms, policy_hash, claimed_result }`}</code>.{" "}
          <span className="text-stone-500">(no business data, ever)</span>
        </div>
      </div>
    </div>
  );
}

function PresenterNotesDrawer({
  open,
  onClose,
  policy,
}: {
  open: boolean;
  onClose: () => void;
  policy: Policy;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-y-0 right-0 z-50 w-full max-w-sm overflow-y-auto border-l border-stone-300 bg-white p-5 shadow-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[#346DDB]">Presenter notes</div>
          <div className="text-sm font-semibold text-stone-900">{policy.longName}</div>
          <div className="text-[11px] text-stone-500">Audience: {policy.audience}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:border-stone-400"
          aria-label="Close presenter notes"
        >
          esc
        </button>
      </div>
      <div className="space-y-3 text-xs text-stone-700">
        <div>
          <div className="mb-1 font-semibold text-stone-900">Talking points</div>
          <ul className="space-y-2 pl-4">
            {policy.presenterNotes.map((note, i) => (
              <li key={i} className="list-disc text-stone-600">
                {note}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-1 font-semibold text-stone-900">Suggested order</div>
          <ol className="list-decimal space-y-1 pl-4 text-stone-600">
            {policy.presets.map((p) => (
              <li key={p.label}>
                <span className="font-medium text-stone-900">{p.expected}:</span> {p.label}
              </li>
            ))}
          </ol>
        </div>
        <div>
          <div className="mb-1 font-semibold text-stone-900">Common objections</div>
          <ul className="space-y-2 pl-4 text-stone-600">
            <li className="list-disc">
              <span className="font-medium text-stone-900">&ldquo;Why not just write code?&rdquo;</span>{" "}
              The receipt is a portable, third-party-verifiable artifact. Hand-rolled rules can&rsquo;t
              produce one.
            </li>
            <li className="list-disc">
              <span className="font-medium text-stone-900">&ldquo;Why ZK?&rdquo;</span> So the auditor /
              counterparty can verify the decision without seeing your inputs or your policy text.
            </li>
            <li className="list-disc">
              <span className="font-medium text-stone-900">&ldquo;Latency?&rdquo;</span> Sub-second
              decision; SNARK seal happens in the background; verify is single-digit milliseconds.
            </li>
          </ul>
        </div>
        <div className="rounded border border-stone-200 bg-stone-50 p-2 text-[11px] text-stone-500">
          Hotkeys: <kbd className="rounded border border-stone-300 px-1">?</kbd> toggle these notes,{" "}
          <kbd className="rounded border border-stone-300 px-1">r</kbd> toggle replay mode,{" "}
          <kbd className="rounded border border-stone-300 px-1">esc</kbd> close.
        </div>
      </div>
    </div>
  );
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

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="relative">
      <button
        onClick={onCopy}
        className="absolute right-2 top-2 z-10 rounded border border-stone-300 bg-white px-2 py-0.5 text-[10px] text-stone-700 hover:border-stone-400"
      >
        {copied ? "copied" : "copy"}
      </button>
      <pre className="overflow-x-auto rounded bg-stone-900 p-4 pr-16 font-mono text-[11px] leading-relaxed text-stone-100">
        <code className={`language-${lang}`}>{code}</code>
      </pre>
    </div>
  );
}

// ---------- the page -------------------------------------------------------

export default function Page() {
  // ---- shareable receipt-only view (URL hash) ----------------------------
  const [shareView, setShareView] = useState<SharePayload | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.location.hash.match(/share=([^&]+)/);
    if (!m) return;
    try {
      const decoded = b64urlDecode(m[1]);
      const data = JSON.parse(decoded) as SharePayload;
      setShareView(data);
    } catch (err) {
      setShareError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // ---- deep-link state: ?policy=<slug>&preset=<1-based-idx> ---------------
  // Read once on mount. We only auto-fire after this has run, so a deep-link
  // never gets clobbered by the default-policy auto-fire.
  const [didProcessUrl, setDidProcessUrl] = useState(false);
  const initialPresetIdxRef = useRef<number>(0);
  const didAutofireRef = useRef(false);

  // ---- core demo state ---------------------------------------------------
  const [selectedPolicyId, setSelectedPolicyId] = useState<string>("spending");
  const [activePreset, setActivePreset] = useState<Preset | null>(null);
  const [checkLoading, setCheckLoading] = useState(false);
  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verify, setVerify] = useState<VerifyResponse | null>(null);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [proofReady, setProofReady] = useState(false);
  const [proofGenSeconds, setProofGenSeconds] = useState(0);
  const [proofTimedOut, setProofTimedOut] = useState(false);
  const proofGenStartRef = useRef<number | null>(null);
  const [tab, setTab] = useState<"decision" | "wire" | "receipt" | "integrate">("decision");
  const [integrateLang, setIntegrateLang] = useState<"curl" | "ts" | "python">("curl");

  // ---- demo reliability state -------------------------------------------
  const [health, setHealth] = useState<HealthStatus>("unknown");
  const [healthLatency, setHealthLatency] = useState<number | null>(null);
  // Replay (fallback) mode: when on, presets show the recorded happy-path
  // run rather than calling the live API. Auto-flipped to true if the
  // policy has no compiled policy_id, or when the user hits 'r'.
  const [replayMode, setReplayMode] = useState(false);
  const [showPresenter, setShowPresenter] = useState(false);

  // ---- derived ----------------------------------------------------------
  const policy = policyById(selectedPolicyId) ?? POLICIES[0];
  const policyId = ENV_POLICY_IDS[policy.id] ?? "";
  const policyConfigured = Boolean(policyId);
  const effectiveReplay = replayMode || !policyConfigured;

  // ---- deep-link reader: hydrate state from ?policy=&preset= -------------
  // Runs once. Skipped entirely when a #share= hash is present, since that
  // takes over the whole render. Sets didProcessUrl whether or not it
  // matched; the auto-fire effect waits on this flag so a deep-link is
  // never raced by the default-policy auto-fire.
  useEffect(() => {
    if (typeof window === "undefined") {
      setDidProcessUrl(true);
      return;
    }
    if (window.location.hash.includes("share=")) {
      setDidProcessUrl(true);
      return;
    }
    const sp = new URLSearchParams(window.location.search);
    const reqPolicy = sp.get("policy");
    const reqPreset = sp.get("preset");
    if (reqPolicy && policyById(reqPolicy)) {
      setSelectedPolicyId(reqPolicy);
    }
    if (reqPreset) {
      const n = parseInt(reqPreset, 10);
      const idx = Number.isFinite(n) ? n - 1 : 0;
      initialPresetIdxRef.current = Math.max(0, idx);
    }
    setDidProcessUrl(true);
  }, []);

  // ---- health probe + pre-warm on mount ---------------------------------
  useEffect(() => {
    let cancelled = false;
    async function probe() {
      try {
        const t0 = Date.now();
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json()) as { status: HealthStatus; elapsed_ms?: number };
        if (cancelled) return;
        setHealth(data.status === "ok" ? "ok" : "degraded");
        setHealthLatency(typeof data.elapsed_ms === "number" ? data.elapsed_ms : Date.now() - t0);
      } catch {
        if (!cancelled) {
          setHealth("degraded");
          setHealthLatency(null);
        }
      }
    }
    probe();
    const id = setInterval(probe, HEALTH_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ---- hotkeys: '?' presenter notes, 'r' replay, esc close ---------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Ignore when typing in inputs.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "?") {
        e.preventDefault();
        setShowPresenter((v) => !v);
      } else if (e.key === "r" || e.key === "R") {
        setReplayMode((v) => !v);
      } else if (e.key === "Escape") {
        setShowPresenter(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- proof polling with hard timeout + retry --------------------------
  const pollAbortRef = useRef<{ cancel: () => void } | null>(null);

  const startPolling = useCallback((proofId: string) => {
    pollAbortRef.current?.cancel();
    setProofReady(false);
    setProofGenSeconds(0);
    setProofTimedOut(false);
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
    pollAbortRef.current = { cancel: stop };

    (async () => {
      while (!cancelled) {
        try {
          const res = await fetch(`/api/proof-status?proof_id=${proofId}`);
          const data = (await res.json()) as { ready: boolean };
          if (data.ready) {
            if (!cancelled) {
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
        if (Date.now() - (proofGenStartRef.current ?? Date.now()) > PROOF_TIMEOUT_MS) {
          if (!cancelled) {
            // Snap the visible counter to actual wall-clock elapsed.
            // The 1s tick interval can be throttled by the browser when the tab
            // is backgrounded, so proofGenSeconds may otherwise read low.
            if (proofGenStartRef.current) {
              setProofGenSeconds(Math.round((Date.now() - proofGenStartRef.current) / 1000));
            }
            setProofTimedOut(true);
          }
          stop();
          return;
        }
      }
    })();
  }, []);

  useEffect(() => {
    if (!check?.proof_id) return;
    if (effectiveReplay) {
      // Replay mode: fake the SNARK ready state immediately based on the
      // preset's recorded data so the UI flow looks identical.
      const seconds = activePreset?.replay?.proof_gen_seconds ?? 5;
      setProofReady(false);
      setProofGenSeconds(0);
      setProofTimedOut(false);
      let i = 0;
      const id = setInterval(() => {
        i += 1;
        setProofGenSeconds(i);
        if (i >= seconds) {
          setProofReady(true);
          clearInterval(id);
        }
      }, 250); // accelerated for replays so the demo doesn't stall.
      return () => clearInterval(id);
    }
    startPolling(check.proof_id);
    return () => pollAbortRef.current?.cancel();
  }, [check?.proof_id, effectiveReplay, activePreset, startPolling]);

  // ---- run a check ------------------------------------------------------
  async function runCheck(preset: Preset) {
    setActivePreset(preset);
    setCheck(null);
    setCheckError(null);
    setVerify(null);
    setVerifyError(null);
    setProofReady(false);
    setProofTimedOut(false);

    if (effectiveReplay) {
      // Use the recorded run. Animate the request a touch so it doesn't
      // feel instant in front of an audience.
      setCheckLoading(true);
      await new Promise((r) => setTimeout(r, 350));
      const replay = preset.replay;
      if (!replay) {
        setCheckLoading(false);
        setCheckError("No replay recorded for this preset.");
        return;
      }
      setCheck({
        result: preset.expected,
        blocked: preset.expected !== "SAT",
        reason: replay.reason,
        proof_id: replay.proof_id,
        check_id: `replay-${replay.proof_id.slice(0, 8)}`,
        elapsed_ms: replay.elapsed_ms,
      });
      setCheckLoading(false);
      return;
    }

    setCheckLoading(true);
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy_id: policyId, action: preset.action }),
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

    if (effectiveReplay && activePreset?.replay) {
      // Replay mode: surface the recorded receipt with a short delay.
      await new Promise((r) => setTimeout(r, 280));
      setVerify(activePreset.replay.verify);
      setVerifyLoading(false);
      return;
    }

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

  function copyShareLink() {
    if (!check || !verify || !activePreset) return;
    const payload: SharePayload = {
      policy_id: policyId || `(${policy.id} replay)`,
      policy_short: policy.shortName,
      preset_label: activePreset.label,
      action: activePreset.action,
      check,
      verify,
      ts: Date.now(),
      replay: effectiveReplay || undefined,
    };
    const encoded = b64urlEncode(JSON.stringify(payload));
    const url = `${window.location.origin}${window.location.pathname}#share=${encoded}`;
    navigator.clipboard.writeText(url);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1500);
  }

  function selectPolicy(id: string) {
    if (id === selectedPolicyId) return;
    setSelectedPolicyId(id);
    setActivePreset(null);
    setCheck(null);
    setCheckError(null);
    setVerify(null);
    setVerifyError(null);
    setProofReady(false);
    setProofTimedOut(false);
    setTab("decision");
  }

  // ---- auto-fire first preset on mount (or deep-linked preset) ----------
  // Fires exactly once after the URL has been processed, so visitors land
  // on a populated Decision pane instead of the empty "pick a preset"
  // dead state. The didAutofireRef guard prevents re-firing when policy
  // changes via the policy-library buttons later.
  useEffect(() => {
    if (!didProcessUrl) return;
    if (didAutofireRef.current) return;
    if (shareView) return;
    if (checkLoading || activePreset) return;
    const idx = initialPresetIdxRef.current;
    const preset = policy.presets[idx] ?? policy.presets[0];
    if (!preset) return;
    didAutofireRef.current = true;
    runCheck(preset);
  }, [didProcessUrl, policy, shareView, checkLoading, activePreset]);

  // ---- URL sync: keep ?policy=&preset= in step with current state -------
  // replaceState (not pushState) so we don't pollute back-button history.
  // Skipped while a #share= hash is being decoded.
  useEffect(() => {
    if (!didProcessUrl) return;
    if (typeof window === "undefined") return;
    if (window.location.hash.includes("share=")) return;
    const sp = new URLSearchParams(window.location.search);
    sp.set("policy", policy.id);
    if (activePreset) {
      const idx = policy.presets.findIndex((p) => p.label === activePreset.label);
      if (idx >= 0) sp.set("preset", String(idx + 1));
      else sp.delete("preset");
    } else {
      sp.delete("preset");
    }
    const newUrl = `${window.location.pathname}?${sp.toString()}${window.location.hash}`;
    window.history.replaceState(null, "", newUrl);
  }, [didProcessUrl, policy, activePreset]);

  // ---- shareable receipt-only view --------------------------------------
  if (shareView) {
    return <ReceiptOnlyView payload={shareView} onClear={() => {
      window.location.hash = "";
      setShareView(null);
    }} />;
  }
  if (shareError) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-12 text-sm text-rose-700">
        <div className="rounded border border-rose-200 bg-rose-50 p-4">
          Could not parse shared receipt: {shareError}
        </div>
      </main>
    );
  }

  // ---- main render -------------------------------------------------------
  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      <header className="mb-6 flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#346DDB]">Preflight live demo</div>
            <HealthDot status={health} latencyMs={healthLatency} />
            {effectiveReplay && (
              <span className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                <span className="h-2 w-2 rounded-full bg-amber-500" />
                Replay mode {policyConfigured ? "(toggle: r)" : "(no compiled policy_id)"}
              </span>
            )}
            <button
              type="button"
              onClick={() => setShowPresenter((v) => !v)}
              className="rounded border border-stone-300 px-2 py-1 text-[11px] text-stone-700 hover:border-stone-400"
              title="Presenter notes (?)"
            >
              ? notes
            </button>
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-stone-900 sm:text-3xl">
            Cryptographic receipts for AI agent actions.
          </h1>
          <p className="mt-3 max-w-3xl text-sm text-stone-600">
            AI agents are starting to spend real money, refund customers, access regulated data, and message
            customers on behalf of companies. How do you prove an autonomous action stayed inside the rules
            &mdash; without trusting the agent, the AI vendor, or even Preflight itself? Every action below
            generates a tamper-evident receipt: Preflight first decides whether the action satisfies your
            policy (SAT/UNSAT), then issues a SNARK that an auditor, a customer, or a regulator can verify
            in milliseconds against ICME&rsquo;s public endpoint &mdash; without ever seeing your business
            data.
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
        {/* LEFT COLUMN: policy library + presets, sticky on desktop */}
        <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
          {/* policy library */}
          <section>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-stone-700">
              Policy library
            </div>
            <div className="grid grid-cols-2 gap-2">
              {POLICIES.map((p) => {
                const isActive = p.id === selectedPolicyId;
                const isLive = Boolean(ENV_POLICY_IDS[p.id]);
                return (
                  <button
                    key={p.id}
                    onClick={() => selectPolicy(p.id)}
                    className={`rounded-lg border p-2 text-left transition ${
                      isActive
                        ? "border-[#346DDB] bg-blue-50"
                        : "border-stone-200 bg-stone-100 hover:border-stone-400"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <div className="text-xs font-medium text-stone-900">{p.shortName}</div>
                      <span
                        className={`shrink-0 rounded px-1 py-0 text-[8px] font-semibold uppercase tracking-wider ${
                          isLive
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-stone-200 text-stone-700"
                        }`}
                      >
                        {isLive ? "live" : "replay"}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-stone-500">{p.audience}</div>
                  </button>
                );
              })}
            </div>
          </section>

          <section>
            <Disclosure
              summary={
                <span>
                  <span className="font-semibold uppercase tracking-wider text-stone-900">Active policy</span>
                  <span className="ml-2 text-stone-500">
                    {policy.longName} &middot; {policy.clauses.length} clauses
                  </span>
                </span>
              }
            >
              <ol className="list-decimal space-y-1 pl-4 text-xs text-stone-600">
                {policy.clauses.map((clause, i) => (
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
              {policy.presets.map((preset) => {
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
                <code>{policy.envKey}</code> is not set, so this policy runs as a deterministic replay of a
                pre-recorded run. To make it live, run{" "}
                <code>npm run policy:compile -- --policy {policy.id}</code> and set the env var.
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
                    <li>&middot; the underlying customer / vendor / recipient data</li>
                    <li>&middot; transaction amounts, account numbers, refund reasons</li>
                    <li>&middot; allowlists, opt-in lists, vendor lists</li>
                    <li>&middot; justification text, message bodies</li>
                    <li>&middot; cumulative spend / refund / messaging totals</li>
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
                  Swap the <code>policy_id</code> here (or in your own agent) and
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

        {/* RIGHT COLUMN: tabbed (Decision / Wire / Receipt / Integrate) */}
        <div className="rounded-lg border border-stone-200 bg-white">
          {/* Tab bar */}
          <div className="flex flex-wrap items-center gap-1 border-b border-stone-200 px-2 pt-2">
            {([
              { id: "decision", label: "Decision", enabled: true, dot: Boolean(check) },
              { id: "wire", label: "API call", enabled: Boolean(check && activePreset), dot: false },
              { id: "receipt", label: "Receipt", enabled: Boolean(verify || verifyError), dot: Boolean(verify) },
              { id: "integrate", label: "Integrate", enabled: true, dot: false },
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
              <DecisionTabContent
                policy={policy}
                activePreset={activePreset}
                check={check}
                checkLoading={checkLoading}
                checkError={checkError}
                verify={verify}
                verifyError={verifyError}
                verifyLoading={verifyLoading}
                proofReady={proofReady}
                proofGenSeconds={proofGenSeconds}
                proofTimedOut={proofTimedOut}
                replay={effectiveReplay}
                copied={copied}
                shareCopied={shareCopied}
                onCopyProofId={copyProofId}
                onCopyShareLink={copyShareLink}
                onVerify={runVerify}
                onRetryPolling={() => check?.proof_id && startPolling(check.proof_id)}
                onSwitchTab={setTab}
              />
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
                      Your agent makes one outbound call to Preflight before each action. Preflight returns
                      a small signed receipt: the SAT/UNSAT decision, a policy version hash, and a proof_id pointing to a
                      ZK proof. None of your underlying business data crosses the wire &mdash; only the action description
                      and the outcome.
                    </p>
                    <WireBlock
                      title="1. Your agent → Preflight"
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
                        body: { policy_id: policyId || `(${policy.id}: not compiled, replay mode)`, action: activePreset.action },
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
                      <button
                        onClick={copyShareLink}
                        className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:border-stone-400"
                      >
                        {shareCopied ? "link copied" : "share this receipt"}
                      </button>
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

            {/* INTEGRATE TAB */}
            {tab === "integrate" && (
              <IntegrateTabContent
                policyId={policyId || `<${policy.envKey}>`}
                action={activePreset?.action ?? policy.presets[0].action}
                proofId={check?.proof_id}
                lang={integrateLang}
                onLang={setIntegrateLang}
              />
            )}
          </div>
        </div>
      </div>

      {/* Architecture diagram (always visible below the fold for technical buyers) */}
      <div className="mt-8">
        <ArchitectureDiagram />
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
        . Hotkeys: <kbd className="rounded border border-stone-300 px-1">?</kbd> presenter notes,{" "}
        <kbd className="rounded border border-stone-300 px-1">r</kbd> toggle replay mode.
      </footer>

      <PresenterNotesDrawer
        open={showPresenter}
        onClose={() => setShowPresenter(false)}
        policy={policy}
      />
    </main>
  );
}

// ---------- Decision tab content (extracted to keep the page bearable) -----

function DecisionTabContent({
  policy: _policy,
  activePreset,
  check,
  checkLoading,
  checkError,
  verify,
  verifyError,
  verifyLoading,
  proofReady,
  proofGenSeconds,
  proofTimedOut,
  replay,
  copied,
  shareCopied,
  onCopyProofId,
  onCopyShareLink,
  onVerify,
  onRetryPolling,
  onSwitchTab,
}: {
  policy: Policy;
  activePreset: Preset | null;
  check: CheckResponse | null;
  checkLoading: boolean;
  checkError: string | null;
  verify: VerifyResponse | null;
  verifyError: string | null;
  verifyLoading: boolean;
  proofReady: boolean;
  proofGenSeconds: number;
  proofTimedOut: boolean;
  replay: boolean;
  copied: boolean;
  shareCopied: boolean;
  onCopyProofId: () => void;
  onCopyShareLink: () => void;
  onVerify: () => void;
  onRetryPolling: () => void;
  onSwitchTab: (t: "decision" | "wire" | "receipt" | "integrate") => void;
}) {
  return (
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
            <div className="text-[10px] uppercase tracking-wider text-stone-500">
              Step 1 of 2 &middot; Decision {replay && <span className="ml-1 text-amber-700">(replay)</span>}
            </div>
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

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-xs uppercase tracking-wider text-stone-500">proof_id</span>
                <code className="break-all rounded bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-900">
                  {check.proof_id}
                </code>
                <button
                  onClick={onCopyProofId}
                  className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-700 hover:border-stone-400"
                >
                  {copied ? "copied" : "copy"}
                </button>
              </div>

              <div className="mt-3 flex items-center gap-2 text-xs">
                {proofTimedOut ? (
                  <>
                    <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
                    <span className="text-amber-800">
                      Still generating after {proofGenSeconds}s. The proof may already be ready &mdash; try verify now, or retry the status check.
                    </span>
                    <button
                      onClick={onRetryPolling}
                      className="rounded border border-stone-300 px-2 py-0.5 text-[11px] text-stone-700 hover:border-stone-400"
                    >
                      Retry
                    </button>
                  </>
                ) : proofReady ? (
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
                  onClick={onVerify}
                  disabled={verifyLoading || (!proofReady && !proofTimedOut)}
                  className="rounded bg-[#346DDB] px-4 py-2 text-sm font-medium text-white hover:bg-[#2756b8] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {verifyLoading
                    ? "verifying..."
                    : proofReady
                    ? "Verify this proof independently"
                    : proofTimedOut
                    ? "Try verify now"
                    : "Waiting for SNARK to finalize..."}
                </button>

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
                    <button
                      onClick={onCopyShareLink}
                      className="rounded border border-stone-300 px-2 py-1 text-xs text-stone-700 hover:border-stone-400"
                    >
                      {shareCopied ? "link copied" : "share this receipt"}
                    </button>
                  </>
                )}
                {verifyError && <div className="text-xs text-rose-700">{verifyError}</div>}
              </div>

              {verify && verify.valid && typeof verify.verify_ms === "number" && (
                <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-5 py-4">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                    Verified &middot; independent of this site
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
                    <div className="font-mono text-4xl font-semibold leading-none text-emerald-900">
                      {verify.verify_ms}
                      <span className="ml-1 text-xl font-normal text-emerald-700">ms</span>
                    </div>
                    <div className="max-w-prose text-xs leading-snug text-emerald-800">
                      The browser called <span className="font-mono">api.icme.io/v1/verifyProof</span> directly &mdash;
                      no API key, no proxy through this site. Open DevTools &rarr; Network to confirm.
                    </div>
                  </div>
                </div>
              )}
              {verify && (
                <div className="mt-2 text-[11px] text-stone-500">
                  Full signed receipt available in the{" "}
                  <button className="underline hover:text-stone-700" onClick={() => onSwitchTab("receipt")}>Receipt</button>{" "}
                  tab. Request and response payloads in the{" "}
                  <button className="underline hover:text-stone-700" onClick={() => onSwitchTab("wire")}>API call</button>{" "}
                  tab. Code snippets in the{" "}
                  <button className="underline hover:text-stone-700" onClick={() => onSwitchTab("integrate")}>Integrate</button>{" "}
                  tab.
                </div>
              )}

              <div className="mt-3">
                <Disclosure
                  summary={
                    <span>
                      <span className="font-semibold text-stone-900">Why proof verification is faster than generation</span>
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
  );
}

// ---------- Integrate tab content ------------------------------------------

function IntegrateTabContent({
  policyId,
  action,
  proofId,
  lang,
  onLang,
}: {
  policyId: string;
  action: string;
  proofId: string | undefined;
  lang: "curl" | "ts" | "python";
  onLang: (l: "curl" | "ts" | "python") => void;
}) {
  const code =
    lang === "curl"
      ? curlSnippet(policyId, action, proofId)
      : lang === "ts"
      ? tsSnippet(policyId, action, proofId)
      : pythonSnippet(policyId, action, proofId);

  return (
    <div>
      <div className="mb-3 text-xs text-stone-600">
        End-to-end snippet using the values from the scenario you just ran. No SDK, no bespoke wrappers
        &mdash; just <code>fetch</code>/<code>requests</code> against the public Preflight API. Drop into
        your agent, swap in your <code>ICME_API_KEY</code>, and you have policy-checked
        actions plus an externally-verifiable receipt for each.
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1">
        {([
          { id: "curl", label: "cURL" },
          { id: "ts", label: "TypeScript / Node" },
          { id: "python", label: "Python" },
        ] as const).map((t) => (
          <button
            key={t.id}
            onClick={() => onLang(t.id)}
            className={`rounded border px-3 py-1 text-xs ${
              lang === t.id
                ? "border-[#346DDB] bg-blue-50 text-[#346DDB]"
                : "border-stone-200 bg-white text-stone-700 hover:border-stone-400"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <CodeBlock code={code} lang={lang} />

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <div className="rounded border border-stone-200 bg-stone-50 p-3 text-[11px] text-stone-700">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Step 1: check</div>
          The first call needs your API key &mdash; keep it server-side. The response carries the SAT/UNSAT
          decision and a <code>zk_proof_id</code> you can hand to anyone.
        </div>
        <div className="rounded border border-stone-200 bg-stone-50 p-3 text-[11px] text-stone-700">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Step 2: poll</div>
          The SNARK is sealed asynchronously (a few seconds). Poll <code>/v1/proof/&lt;id&gt;</code> until
          you get a 200, then move on. The example uses a 45-second timeout.
        </div>
        <div className="rounded border border-stone-200 bg-stone-50 p-3 text-[11px] text-stone-700">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Step 3: verify</div>
          Anyone &mdash; you, an auditor, a counterparty &mdash; can call <code>/v1/verifyProof</code>{" "}
          unauthenticated. The response is the public receipt. Single-use: a fresh check produces a fresh
          proof.
        </div>
      </div>

      <div className="mt-4 rounded border border-stone-200 bg-white p-3 text-[11px] text-stone-700">
        <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">Production checklist</div>
        <ul className="list-disc space-y-1 pl-4 text-stone-600">
          <li>Run <code>checkIt</code> from your backend, not your client. The API key must stay server-side.</li>
          <li>Store the <code>proof_id</code> alongside the agent action&rsquo;s audit log entry.</li>
          <li>For every customer-facing claim of compliance, hand them the <code>proof_id</code> and link to <code>/v1/verifyProof</code>.</li>
          <li>For confidential policies, request the confidential-mode build &mdash; payloads on the wire stay identical.</li>
          <li>Compile new policy versions sparingly; each <code>policy_id</code> is reusable across millions of checks.</li>
        </ul>
      </div>
    </div>
  );
}

// ---------- Receipt-only view (for shareable links) -----------------------

function ReceiptOnlyView({ payload, onClear }: { payload: SharePayload; onClear: () => void }) {
  const [reverify, setReverify] = useState<VerifyResponse | null>(null);
  const [reverifyError, setReverifyError] = useState<string | null>(null);
  const [reverifyLoading, setReverifyLoading] = useState(false);

  async function runReverify() {
    setReverifyLoading(true);
    setReverify(null);
    setReverifyError(null);
    try {
      const res = await fetch(VERIFY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof_id: payload.check.proof_id }),
      });
      if (!res.ok) {
        const text = await res.text();
        if (res.status === 409) {
          setReverifyError(
            "This proof has already been consumed (single-use, HTTP 409). The receipt above is what verifyProof returned the first time it ran. To run a fresh independent verification, ask the sender to generate a new check."
          );
        } else if (res.status === 404) {
          setReverifyError("Proof not found (HTTP 404). Either it has expired or was never sealed.");
        } else {
          setReverifyError(`verifyProof failed: HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return;
      }
      const data = (await res.json()) as VerifyResponse;
      setReverify(data);
    } catch (err) {
      setReverifyError(err instanceof Error ? err.message : String(err));
    } finally {
      setReverifyLoading(false);
    }
  }

  const v = payload.verify;
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-6">
        <div className="text-xs font-semibold uppercase tracking-widest text-[#346DDB]">Preflight receipt</div>
        <h1 className="mt-1 text-2xl font-semibold text-stone-900">Shared by a Preflight customer</h1>
        <p className="mt-2 text-sm text-stone-600">
          This is a portable, third-party-verifiable record that an AI agent action was checked against a
          policy {payload.replay && "(captured in replay mode for demo purposes)"}. The receipt does not
          contain the underlying business data, only the cryptographic outcome.
        </p>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-5">
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">Policy</div>
            <div className="text-sm font-semibold text-stone-900">{payload.policy_short}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">Captured</div>
            <div className="text-sm text-stone-700">{new Date(payload.ts).toLocaleString()}</div>
          </div>
          <div className="sm:col-span-2">
            <div className="text-[10px] uppercase tracking-wider text-stone-500">Scenario</div>
            <div className="text-sm text-stone-900">{payload.preset_label}</div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <div
            className={`rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider ${
              payload.check.result === "SAT"
                ? "bg-emerald-100 text-emerald-800"
                : "bg-rose-100 text-rose-800"
            }`}
          >
            {payload.check.result} {payload.check.blocked ? "(blocked)" : "(allowed)"}
          </div>
          <div
            className={`rounded px-2 py-1 text-xs font-semibold uppercase tracking-wider ${
              v.valid ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
            }`}
          >
            valid: {String(v.valid ?? "unknown")}
          </div>
          {typeof v.verify_ms === "number" && (
            <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
              verified in <span className="font-semibold text-stone-900">{formatMs(v.verify_ms)}</span>
            </div>
          )}
          {typeof v.proof_bytes_len === "number" && (
            <div className="rounded bg-stone-100 px-2 py-1 text-xs text-stone-700">
              proof size{" "}
              <span className="font-semibold text-stone-900">{(v.proof_bytes_len / 1024).toFixed(1)} KB</span>
            </div>
          )}
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">proof_id</div>
          <code className="block break-all rounded bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-900">
            {payload.check.proof_id}
          </code>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-stone-500">signed receipt (as captured)</div>
          <pre className="max-h-72 overflow-auto rounded bg-stone-100 p-3 font-mono text-[11px] leading-relaxed text-stone-900">
            {JSON.stringify(v, null, 2)}
          </pre>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            onClick={runReverify}
            disabled={reverifyLoading || payload.replay}
            className="rounded bg-[#346DDB] px-4 py-2 text-sm font-medium text-white hover:bg-[#2756b8] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reverifyLoading ? "verifying..." : "Re-verify on chain"}
          </button>
          {payload.replay && (
            <span className="text-xs text-amber-700">
              Replay-mode receipt — re-verify is disabled because the proof_id is illustrative.
            </span>
          )}
          <button
            onClick={onClear}
            className="rounded border border-stone-300 px-3 py-1.5 text-xs text-stone-700 hover:border-stone-400"
          >
            ← Back to playground
          </button>
        </div>

        {reverify && (
          <div className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-xs text-emerald-900">
            Re-verification succeeded:{" "}
            <code>{JSON.stringify(reverify, null, 2)}</code>
          </div>
        )}
        {reverifyError && (
          <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            {reverifyError}
          </div>
        )}
      </div>

      <div className="mt-6 text-xs text-stone-500">
        Built on the ICME Preflight API. Anyone can verify a receipt against{" "}
        <a className="underline" href="https://api.icme.io/v1/verifyProof" target="_blank" rel="noreferrer">
          api.icme.io/v1/verifyProof
        </a>
        .
      </div>
    </main>
  );
}
