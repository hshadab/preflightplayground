/**
 * Time how long a real proof takes to generate for a given policy_id + action.
 *
 * This is a throwaway A/B harness for comparing proof-generation latency across
 * policy variants (e.g. the full pricing policy vs. policies/lite/ probes). It:
 *
 *   1. POSTs /v1/checkIt to get the decision + proof_id (handles JSON or SSE).
 *   2. Polls GET /v1/proof/:id until it goes ready (404 -> not ready, 200 -> ready).
 *      Readiness polling does NOT consume the single-use verifyProof, so this is
 *      safe to run repeatedly.
 *   3. Prints wall-clock seconds-to-ready, plus checkIt latency.
 *
 * It is READ-ONLY on config: it reads ICME_API_KEY / ICME_BASE_URL from the
 * environment or .env.local and never writes .env.local or the policy cache.
 *
 * COST: each run spends one real /v1/checkIt (~$0.01-0.03). Default is 1 run.
 *
 * Usage:
 *   npm run time:proof -- --policy-id <uuid> --action "Set price to 49.00 EUR ..."
 *   npm run time:proof -- --policy-id <uuid> --action-file ./action.txt
 *   npm run time:proof -- --policy-id <uuid> --action "..." --runs 3
 *   npm run time:proof -- --policy-id <uuid> --action "..." --timeout 90 --interval 1
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const ENV_LOCAL = join(ROOT, ".env.local");

function loadEnv() {
  if (!existsSync(ENV_LOCAL)) return;
  const raw = readFileSync(ENV_LOCAL, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

interface CheckItEvent {
  step?: string;
  result?: string;
  z3_result?: string;
  zk_proof_id?: string;
  proof_id?: string;
  detail?: string;
}

interface CheckOutcome {
  result: "SAT" | "UNSAT";
  proofId?: string;
  checkMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function checkIt(baseUrl: string, apiKey: string, policyId: string, action: string): Promise<CheckOutcome> {
  const start = Date.now();
  const res = await fetch(`${baseUrl}/checkIt`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify({ policy_id: policyId, action }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`checkIt failed: ${res.status} ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let done: CheckItEvent | null = null;

  if (contentType.includes("application/json")) {
    done = (await res.json()) as CheckItEvent;
  } else {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const consume = (line: string) => {
      const data = line.startsWith("data: ") ? line.slice(6) : line.trim();
      if (!data || !data.startsWith("{")) return;
      try {
        const parsed = JSON.parse(data) as CheckItEvent;
        if (parsed.step === "done" || parsed.result || parsed.zk_proof_id || parsed.proof_id) done = parsed;
      } catch {
        // ignore progress noise
      }
    };
    while (true) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (buffer) consume(buffer);
  }

  if (!done) throw new Error("checkIt ended without a result event");
  const event = done as CheckItEvent;
  const raw = event.result;
  const z3 = event.z3_result;
  let normalized: "SAT" | "UNSAT";
  if (raw === "SAT" || raw === "UNSAT") normalized = raw;
  else if (z3 === "SAT" || z3 === "UNSAT") normalized = z3;
  else normalized = "UNSAT";

  return {
    result: normalized,
    proofId: event.zk_proof_id ?? event.proof_id,
    checkMs: Date.now() - start,
  };
}

async function timeProofReady(
  baseUrl: string,
  apiKey: string,
  proofId: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/proof/${proofId}`, { headers: { "X-API-Key": apiKey } });
    if (res.status === 200) return Date.now() - start;
    // 404 (or transient non-200) => still generating; keep polling.
    await sleep(intervalMs);
  }
  return null;
}

function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s (${ms}ms)`;
}

function stats(xs: number[]): { min: number; max: number; mean: number; median: number } {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
    median,
  };
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);

  const policyId = argValue(args, "--policy-id");
  let action = argValue(args, "--action");
  const actionFile = argValue(args, "--action-file");
  const runs = Number(argValue(args, "--runs") ?? "1");
  const timeoutSec = Number(argValue(args, "--timeout") ?? "90");
  const intervalSec = Number(argValue(args, "--interval") ?? "1");

  if (actionFile) {
    if (!existsSync(actionFile)) {
      console.error(`action file not found: ${actionFile}`);
      process.exit(1);
    }
    action = readFileSync(actionFile, "utf8").trim();
  }

  if (!policyId || !action) {
    console.error("Required: --policy-id <uuid> and (--action \"...\" or --action-file <path>)");
    process.exit(1);
  }
  if (!/^[a-f0-9-]{36}$/i.test(policyId)) {
    console.error(`--policy-id does not look like a UUID: ${policyId}`);
    process.exit(1);
  }

  const apiKey = process.env.ICME_API_KEY;
  if (!apiKey) {
    console.error("ICME_API_KEY is not set. Add it to .env.local and re-run.");
    process.exit(1);
  }
  const baseUrl = process.env.ICME_BASE_URL ?? "https://api.icme.io/v1";

  console.log(`policy_id: ${policyId}`);
  console.log(`action:    ${action.length > 100 ? action.slice(0, 100) + "\u2026" : action}`);
  console.log(`runs:      ${runs}  (each run spends one real checkIt, ~$0.01-0.03)`);
  console.log(`base url:  ${baseUrl}`);
  console.log("");

  const proofTimes: number[] = [];
  const checkTimes: number[] = [];

  for (let i = 1; i <= runs; i++) {
    process.stdout.write(`run ${i}/${runs}: checkIt\u2026 `);
    const outcome = await checkIt(baseUrl, apiKey, policyId, action);
    checkTimes.push(outcome.checkMs);
    process.stdout.write(`${outcome.result} in ${fmtMs(outcome.checkMs)}; `);

    if (!outcome.proofId) {
      console.log(`no proof_id returned (no proof to time for this outcome).`);
      continue;
    }
    process.stdout.write(`proof ${outcome.proofId.slice(0, 8)}\u2026 polling\u2026 `);
    const ready = await timeProofReady(baseUrl, apiKey, outcome.proofId, timeoutSec * 1000, intervalSec * 1000);
    if (ready === null) {
      console.log(`NOT READY after ${timeoutSec}s (timed out).`);
    } else {
      proofTimes.push(ready);
      console.log(`ready in ${fmtMs(ready)}.`);
    }
  }

  console.log("");
  if (checkTimes.length) {
    const c = stats(checkTimes);
    console.log(`checkIt latency  -> min ${fmtMs(c.min)} | median ${fmtMs(c.median)} | mean ${fmtMs(c.mean)} | max ${fmtMs(c.max)}`);
  }
  if (proofTimes.length) {
    const p = stats(proofTimes);
    console.log(`proof seconds-to-ready -> min ${fmtMs(p.min)} | median ${fmtMs(p.median)} | mean ${fmtMs(p.mean)} | max ${fmtMs(p.max)}`);
  } else {
    console.log(`no proof timings collected (no proof_id, or all runs timed out).`);
  }
}

main().catch((err) => {
  console.error("\n[FAIL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
