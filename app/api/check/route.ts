import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

interface CheckRequest {
  policy_id: string;
  action: string;
}

interface CheckItSseEvent {
  step?: string;
  result?: string;
  z3_result?: string;
  ar_result?: string;
  detail?: string;
  zk_proof_id?: string;
  proof_id?: string;
  check_id?: string;
  extracted?: Record<string, unknown>;
  violated_rule?: number;
  verification_time_ms?: number;
}

interface CheckResponse {
  result: "SAT" | "UNSAT";
  blocked: boolean;
  reason: string;
  proof_id?: string;
  check_id?: string;
  elapsed_ms: number;
  extracted?: Record<string, unknown>;
  violated_rule?: number;
  z3_result?: string;
  ar_result?: string;
  verification_time_ms?: number;
}

const BASE_URL = process.env.ICME_BASE_URL ?? "https://api.icme.io/v1";

export async function POST(req: NextRequest) {
  const apiKey = process.env.ICME_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "server misconfigured: ICME_API_KEY missing" }, { status: 500 });
  }

  let body: CheckRequest;
  try {
    body = (await req.json()) as CheckRequest;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.policy_id || !body.action) {
    return NextResponse.json({ error: "policy_id and action are required" }, { status: 400 });
  }

  const start = Date.now();
  const upstream = await fetch(`${BASE_URL}/checkIt`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ policy_id: body.policy_id, action: body.action }),
  });

  if (!upstream.ok) {
    const text = await upstream.text();
    return NextResponse.json(
      { error: `upstream checkIt failed: ${upstream.status}`, detail: text.slice(0, 500) },
      { status: 502 }
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  let doneEvent: CheckItSseEvent | null = null;

  if (contentType.includes("application/json")) {
    doneEvent = (await upstream.json()) as CheckItSseEvent;
  } else {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const consume = (line: string) => {
      const data = line.startsWith("data: ") ? line.slice(6) : line.trim();
      if (!data || !data.startsWith("{")) return;
      try {
        const parsed = JSON.parse(data) as CheckItSseEvent;
        if (parsed.step === "done" || parsed.result || parsed.zk_proof_id || parsed.proof_id) {
          doneEvent = parsed;
        }
      } catch {
        // ignore unparseable progress events
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) consume(line);
    }
    if (buffer) consume(buffer);
  }

  if (!doneEvent) {
    return NextResponse.json({ error: "checkIt stream ended without a result event" }, { status: 502 });
  }

  // Per nanopayments lesson: the API may return "AR uncertain". Fall back to
  // z3_result, then fail-closed to UNSAT.
  const event = doneEvent as CheckItSseEvent;
  const raw = event.result;
  const z3 = event.z3_result;
  let normalized: "SAT" | "UNSAT";
  if (raw === "SAT" || raw === "UNSAT") normalized = raw;
  else if (z3 === "SAT" || z3 === "UNSAT") normalized = z3;
  else normalized = "UNSAT";

  const response: CheckResponse = {
    result: normalized,
    blocked: normalized !== "SAT",
    reason: event.detail ?? "",
    proof_id: event.zk_proof_id ?? event.proof_id,
    check_id: event.check_id,
    elapsed_ms: Date.now() - start,
    extracted: event.extracted,
    violated_rule: event.violated_rule,
    z3_result: event.z3_result,
    ar_result: event.ar_result,
    verification_time_ms: event.verification_time_ms,
  };

  return NextResponse.json(response);
}
