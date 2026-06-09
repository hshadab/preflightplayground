import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

const BASE_URL = process.env.ICME_BASE_URL ?? "https://api.icme.io/v1";

/**
 * Proxies GET /v1/proof/:id so the browser can poll readiness without holding
 * the API key. Returns 404 while the proof is still generating, 200 when ready.
 *
 * We don't return the proof body itself -- only a {ready: boolean} so the UI
 * can decide when to enable the (independent, no-auth) verifyProof button.
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.ICME_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "server misconfigured" }, { status: 500 });
  }

  const proofId = req.nextUrl.searchParams.get("proof_id");
  if (!proofId || !/^[a-f0-9-]{36}$/i.test(proofId)) {
    return NextResponse.json({ error: "invalid proof_id" }, { status: 400 });
  }

  const upstream = await fetch(`${BASE_URL}/proof/${proofId}`, {
    headers: { "X-API-Key": apiKey },
  });

  if (upstream.status === 404) {
    return NextResponse.json({ ready: false }, { status: 200 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ ready: false, error: `upstream ${upstream.status}` }, { status: 200 });
  }
  return NextResponse.json({ ready: true });
}
