/**
 * Code snippet generators for the "Integrate" tab.
 *
 * Each generator takes the *current scenario's* policy_id, action, and (when
 * available) proof_id so the snippet a buyer copies is the exact request that
 * produced the receipt they just watched in the UI.
 *
 * All snippets are end-to-end (check + poll + verify) and intentionally
 * library-free so the buyer's engineering team can paste them anywhere.
 */

const escapeShell = (s: string) => s.replace(/'/g, "'\\''");
const escapeJs = (s: string) => s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$");

export function curlSnippet(policyId: string, action: string, proofId?: string): string {
  const a = escapeShell(action);
  const p = escapeShell(policyId);
  return [
    `# 1) Run a check. Server-side only — your X-API-Key never leaves your backend.`,
    `curl -sN -X POST https://api.icme.io/v1/checkIt \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-API-Key: $ICME_API_KEY" \\`,
    `  -d '{"policy_id":"${p}","action":"${a}"}'`,
    ``,
    `# Response includes "result" (SAT|UNSAT) and "zk_proof_id" (UUID).`,
    `# Wait a few seconds while the SNARK is sealed on the backend, then:`,
    ``,
    `# 2) Verify the receipt INDEPENDENTLY. No API key, anyone can run this.`,
    `curl -sX POST https://api.icme.io/v1/verifyProof \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"proof_id":"${proofId ?? "<paste zk_proof_id from step 1>"}"}'`,
    ``,
    `# Response: {"valid": true, "verify_ms": ...,  "policy_hash": "...", "claimed_result": "..."}`,
  ].join("\n");
}

export function tsSnippet(policyId: string, action: string, proofId?: string): string {
  const a = escapeJs(action);
  return `// Drop-in TypeScript / Node 18+. No dependencies.
// Server-side: holds your ICME_API_KEY. Verification is keyless.

const POLICY_ID = "${policyId}";
const ACTION = \`${a}\`;

async function checkIt() {
  const r = await fetch("https://api.icme.io/v1/checkIt", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.ICME_API_KEY!,
    },
    body: JSON.stringify({ policy_id: POLICY_ID, action: ACTION }),
  });
  if (!r.ok) throw new Error(\`checkIt \${r.status}: \${await r.text()}\`);
  // checkIt may return JSON or an SSE stream depending on deployment.
  // For brevity here we assume JSON; see the Preflight docs for the
  // SSE fallback parser if you need it.
  return r.json() as Promise<{ result: "SAT" | "UNSAT"; zk_proof_id: string; detail?: string }>;
}

async function waitUntilReady(proofId: string, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const r = await fetch(\`https://api.icme.io/v1/proof/\${proofId}\`, {
      headers: { "X-API-Key": process.env.ICME_API_KEY! },
    });
    if (r.ok) return;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error("SNARK generation timed out");
}

async function verifyProof(proofId: string) {
  // No API key. Anyone on the public internet can run this.
  const r = await fetch("https://api.icme.io/v1/verifyProof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proof_id: proofId }),
  });
  if (!r.ok) throw new Error(\`verifyProof \${r.status}: \${await r.text()}\`);
  return r.json() as Promise<{ valid: boolean; verify_ms: number; policy_hash: string; claimed_result: string }>;
}

(async () => {
  const decision = await checkIt();
  console.log("decision:", decision.result, decision.detail ?? "");
  if (decision.zk_proof_id) {
    await waitUntilReady(decision.zk_proof_id);
    const receipt = await verifyProof(${proofId ? `"${proofId}"` : "decision.zk_proof_id"});
    console.log("receipt:", receipt);
  }
})();`;
}

export function pythonSnippet(policyId: string, action: string, proofId?: string): string {
  // Python uses single-quoted strings here; escape both quote kinds.
  const a = action.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `# Drop-in Python 3.9+. Uses 'requests' (pip install requests).
# Server-side script holds ICME_API_KEY; verification is keyless.
import os, time, requests

POLICY_ID = "${policyId}"
ACTION = "${a}"
API = "https://api.icme.io/v1"
KEY = os.environ["ICME_API_KEY"]

def check_it():
    r = requests.post(
        f"{API}/checkIt",
        headers={"Content-Type": "application/json", "X-API-Key": KEY},
        json={"policy_id": POLICY_ID, "action": ACTION},
        timeout=60,
    )
    r.raise_for_status()
    # Some deployments return SSE; for brevity assume JSON. See docs for the
    # SSE fallback parser if your deployment streams.
    return r.json()

def wait_until_ready(proof_id: str, timeout_s: int = 45):
    started = time.time()
    while time.time() - started < timeout_s:
        r = requests.get(f"{API}/proof/{proof_id}", headers={"X-API-Key": KEY}, timeout=10)
        if r.status_code == 200:
            return
        time.sleep(2)
    raise TimeoutError("SNARK generation timed out")

def verify_proof(proof_id: str):
    # No API key. Public endpoint.
    r = requests.post(
        f"{API}/verifyProof",
        headers={"Content-Type": "application/json"},
        json={"proof_id": proof_id},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()

if __name__ == "__main__":
    decision = check_it()
    print("decision:", decision.get("result"), decision.get("detail", ""))
    proof_id = ${proofId ? `"${proofId}"` : 'decision.get("zk_proof_id")'}
    if proof_id:
        wait_until_ready(proof_id)
        receipt = verify_proof(proof_id)
        print("receipt:", receipt)
`;
}
