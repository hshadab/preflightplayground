import { ImageResponse } from "next/og";

// Auto-detected by Next.js: served at /opengraph-image and injected into <head>
// of every page. 1200×630 is the universal OG / Twitter summary_large_image size.

export const runtime = "edge";
export const alt = "Verifiable Floe — cryptographic receipts for every Floe agent action";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#F5F5F4",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: "#346DDB",
          }}
        >
          Verifiable Floe · Preflight by ICME
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 600,
              color: "#1c1917",
              lineHeight: 1.05,
              letterSpacing: "-0.02em",
              maxWidth: 1040,
            }}
          >
            Cryptographic receipts for every Floe agent action.
          </div>
          <div
            style={{
              fontSize: 32,
              color: "#57534e",
              lineHeight: 1.3,
              maxWidth: 980,
            }}
          >
            Borrow, x402 spend, liquidation. Run a real check, verify the SNARK in your browser.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 18px",
              borderRadius: 10,
              background: "#dcfce7",
              color: "#166534",
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                borderRadius: 999,
                background: "#16a34a",
                display: "block",
              }}
            />
            live demo
          </span>
          <span style={{ fontSize: 22, color: "#78716c" }}>
            3 policies · real proofs · verify in milliseconds
          </span>
        </div>
      </div>
    ),
    { ...size },
  );
}
