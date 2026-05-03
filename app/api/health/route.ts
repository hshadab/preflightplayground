import { NextResponse } from "next/server";

export const runtime = "edge";

const BASE_URL = process.env.ICME_BASE_URL ?? "https://api.icme.io/v1";

/**
 * Lightweight health probe used by the playground's status dot.
 *
 * Purpose: surface whether the upstream ICME API is reachable and responding
 * BEFORE a presenter clicks a preset on a sales call. Distinct from a full
 * checkIt because we do not want to spend a real check just to render a dot.
 *
 * Strategy: hit /v1/verifyProof with an obviously-bogus proof_id. We expect a
 * fast 4xx response (likely 400 invalid or 404 not found). Any 4xx = upstream
 * is alive and processing requests. 5xx or timeout = degraded.
 */
export async function GET() {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${BASE_URL}/verifyProof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proof_id: "00000000-0000-4000-8000-000000000000" }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - start;
    // Any structured response within budget = upstream alive.
    if (res.status < 500) {
      return NextResponse.json({ status: "ok", upstream_status: res.status, elapsed_ms: elapsed });
    }
    return NextResponse.json({ status: "degraded", upstream_status: res.status, elapsed_ms: elapsed });
  } catch (err) {
    return NextResponse.json({
      status: "degraded",
      upstream_status: 0,
      elapsed_ms: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
