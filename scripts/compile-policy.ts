/**
 * Safely compile a policy via /v1/makeRules.
 *
 * Background: makeRules costs $3 per call. The policy_id is returned ONLY in
 * the SSE stream body. There is no recovery endpoint. If the parser fails,
 * the credits are gone. This script defends against that with:
 *
 *   1. Local file cache keyed by SHA-256 of the policy text. A second run with
 *      the same policy text is a no-op (free).
 *   2. Raw SSE log written line-by-line to disk DURING the call, so even if
 *      every parser strategy fails, the policy_id can be recovered manually
 *      from the log file.
 *   3. Three independent capture strategies for the policy_id (SSE "data: "
 *      prefixed, raw JSON line, JSON envelope).
 *   4. Explicit confirmation prompt before spending the $3, unless --yes is
 *      passed.
 *   5. On success, the policy_id is written to THREE places: stdout, the cache
 *      file, and appended to .env.local (if present).
 *
 * Usage:
 *   npm run policy:compile                     # interactive, prompts before $3 spend
 *   npm run policy:compile -- --yes            # non-interactive
 *   npm run policy:compile -- --policy other   # compile a different file under policies/
 *   npm run policy:compile -- --policy spending --lite
 *                                              # compile policies/lite/<slug>.txt for an
 *                                              # A/B proof-time test. NEVER writes .env.local,
 *                                              # so it can't disturb the live wiring. Caches
 *                                              # by SHA like normal, so re-runs are free.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = join(import.meta.dirname ?? __dirname, "..");
const CACHE_DIR = join(ROOT, ".policy-cache");
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

interface CacheEntry {
  policy_id: string;
  policy_sha256: string;
  policy_text: string;
  compiled_at: string;
  scenario_count?: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function cachePathFor(hash: string): string {
  return join(CACHE_DIR, `${hash}.json`);
}

function readCache(hash: string): CacheEntry | null {
  const path = cachePathFor(hash);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePathFor(entry.policy_sha256), JSON.stringify(entry, null, 2));
}

// Map a policy slug to the per-policy env var. The spending policy also writes
// the legacy NEXT_PUBLIC_POLICY_ID for back-compat with older deployments.
const SLUG_TO_ENV_KEY: Record<string, string> = {
  spending: "NEXT_PUBLIC_POLICY_ID_SPENDING",
  refunds: "NEXT_PUBLIC_POLICY_ID_REFUNDS",
  "data-access": "NEXT_PUBLIC_POLICY_ID_DATA",
  procurement: "NEXT_PUBLIC_POLICY_ID_PROC",
  "algorithmic-pricing": "NEXT_PUBLIC_POLICY_ID_PRICING",
};

function upsertEnvLine(current: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(current)) return current.replace(re, `${key}=${value}`);
  return current.endsWith("\n") ? `${current}${key}=${value}\n` : `${current}\n${key}=${value}\n`;
}

function writeEnvLocal(slug: string, policyId: string) {
  if (!existsSync(ENV_LOCAL)) return;
  let current = readFileSync(ENV_LOCAL, "utf8");
  const envKey = SLUG_TO_ENV_KEY[slug];
  const keysToWrite = envKey ? [envKey] : [];
  // Spending also writes the legacy variable so older deployments keep working.
  if (slug === "spending") keysToWrite.push("NEXT_PUBLIC_POLICY_ID");
  // Fallback: if the slug isn't recognised, still write to the legacy var so the
  // user has *some* way to wire it up.
  if (keysToWrite.length === 0) keysToWrite.push("NEXT_PUBLIC_POLICY_ID");
  for (const key of keysToWrite) {
    current = upsertEnvLine(current, key, policyId);
  }
  writeFileSync(ENV_LOCAL, current);
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

interface CompileResult {
  policyId: string;
  scenarioCount?: number;
  rawSseLogPath: string;
}

async function compile(policy: string, baseUrl: string, apiKey: string): Promise<CompileResult> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const rawLogPath = join(CACHE_DIR, `raw-sse-${Date.now()}.log`);
  writeFileSync(rawLogPath, `# raw SSE stream for /v1/makeRules\n# started: ${new Date().toISOString()}\n\n`);

  const res = await fetch(`${baseUrl}/makeRules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ policy }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`makeRules failed: ${res.status} ${text}`);
  }

  const contentType = res.headers.get("content-type") ?? "";

  // Strategy 0: clean JSON response (some deployments may return this).
  if (contentType.includes("application/json")) {
    const data = (await res.json()) as { policy_id?: string; scenario_count?: number };
    appendFileSync(rawLogPath, `# JSON response\n${JSON.stringify(data)}\n`);
    if (data.policy_id) {
      return { policyId: data.policy_id, scenarioCount: data.scenario_count, rawSseLogPath: rawLogPath };
    }
    throw new Error(`makeRules JSON had no policy_id. See ${rawLogPath}`);
  }

  // SSE path. Buffer line-by-line, log every chunk to disk before parsing.
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let policyId = "";
  let scenarioCount: number | undefined;

  const tryExtract = (raw: string): void => {
    const candidates: string[] = [];
    if (raw.startsWith("data: ")) candidates.push(raw.slice(6));
    const trimmed = raw.trim();
    if (trimmed.startsWith("{")) candidates.push(trimmed);
    for (const candidate of candidates) {
      try {
        const obj = JSON.parse(candidate) as { policy_id?: string; scenario_count?: number; msg?: string; step?: string };
        if (obj.policy_id) {
          policyId = obj.policy_id;
          if (typeof obj.scenario_count === "number") scenarioCount = obj.scenario_count;
        }
        if (obj.msg) process.stdout.write(`  ${obj.step ? `[${obj.step}] ` : ""}${obj.msg}\n`);
      } catch {
        // ignore -- log file is the safety net
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    appendFileSync(rawLogPath, chunk);
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) tryExtract(line);
  }
  if (buffer) tryExtract(buffer);

  appendFileSync(rawLogPath, `\n# stream closed: ${new Date().toISOString()}\n`);

  if (!policyId) {
    throw new Error(
      `Stream completed but no policy_id was parsed.\n` +
      `Inspect the raw SSE log to recover it manually:\n  ${rawLogPath}\n` +
      `Look for any JSON object containing a "policy_id" field.`
    );
  }

  return { policyId, scenarioCount, rawSseLogPath: rawLogPath };
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const skipConfirm = args.includes("--yes") || args.includes("-y");
  const policyArgIdx = args.findIndex((a) => a === "--policy");
  const policyName = policyArgIdx !== -1 ? args[policyArgIdx + 1] : "spending";
  const lite = args.includes("--lite");
  const policyPath = lite
    ? join(ROOT, "policies", "lite", `${policyName}.txt`)
    : join(ROOT, "policies", `${policyName}.txt`);

  if (!existsSync(policyPath)) {
    console.error(`policy file not found: ${policyPath}`);
    process.exit(1);
  }

  const apiKey = process.env.ICME_API_KEY;
  if (!apiKey) {
    console.error("ICME_API_KEY is not set. Add it to .env.local and re-run.");
    process.exit(1);
  }
  const baseUrl = process.env.ICME_BASE_URL ?? "https://api.icme.io/v1";

  const policyText = readFileSync(policyPath, "utf8");
  const hash = sha256(policyText);

  console.log(`policy file:   ${policyPath}`);
  console.log(`policy sha256: ${hash}`);

  const cached = readCache(hash);
  if (cached) {
    console.log(`\n[CACHE HIT] policy already compiled, skipping the $3 spend.`);
    console.log(`  policy_id:      ${cached.policy_id}`);
    console.log(`  compiled_at:    ${cached.compiled_at}`);
    if (cached.scenario_count) console.log(`  scenario_count: ${cached.scenario_count}`);
    if (lite) {
      console.log(`\n[LITE] .env.local NOT modified. Use this id only for the A/B test:`);
      console.log(`  policy_id: ${cached.policy_id}`);
    } else {
      writeEnvLocal(policyName, cached.policy_id);
      const envKey = SLUG_TO_ENV_KEY[policyName] ?? "NEXT_PUBLIC_POLICY_ID";
      console.log(`\n${envKey}=${cached.policy_id}`);
      if (policyName === "spending") console.log(`NEXT_PUBLIC_POLICY_ID=${cached.policy_id}  # legacy alias`);
    }
    return;
  }

  console.log(`\n[CACHE MISS] this policy has not been compiled before.`);
  console.log(`Compiling will charge ~$3 of ICME credits and is NON-REFUNDABLE.`);

  if (!skipConfirm) {
    const ok = await confirm("\nProceed with $3 compile? [y/N] ");
    if (!ok) {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  console.log(`\nCalling ${baseUrl}/makeRules ...`);
  const result = await compile(policyText, baseUrl, apiKey);

  const entry: CacheEntry = {
    policy_id: result.policyId,
    policy_sha256: hash,
    policy_text: policyText,
    compiled_at: new Date().toISOString(),
    scenario_count: result.scenarioCount,
  };
  writeCache(entry);
  if (!lite) writeEnvLocal(policyName, result.policyId);

  console.log(`\n[OK] policy compiled.`);
  console.log(`  policy_id:        ${result.policyId}`);
  if (result.scenarioCount) console.log(`  scenario_count:   ${result.scenarioCount}`);
  console.log(`  cache file:       ${cachePathFor(hash)}`);
  console.log(`  raw SSE log:      ${result.rawSseLogPath}`);
  if (lite) {
    console.log(`\n[LITE] .env.local NOT modified. Use this id only for the A/B test:`);
    console.log(`  policy_id: ${result.policyId}`);
  } else {
    const envKey = SLUG_TO_ENV_KEY[policyName] ?? "NEXT_PUBLIC_POLICY_ID";
    console.log(`\n${envKey}=${result.policyId}`);
    if (policyName === "spending") console.log(`NEXT_PUBLIC_POLICY_ID=${result.policyId}  # legacy alias`);
  }
}

main().catch((err) => {
  console.error("\n[FAIL]", err instanceof Error ? err.message : err);
  console.error("\nIMPORTANT: if a $3 charge already occurred, inspect .policy-cache/raw-sse-*.log");
  console.error("for any 'policy_id' field before re-running. Re-running will charge again.");
  process.exit(1);
});
