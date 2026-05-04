import type { Metadata } from "next";
import "./globals.css";

const SITE_TITLE = "Preflight — cryptographic receipts for AI agent actions";
const SITE_DESCRIPTION =
  "Run a real Preflight check against an AI agent action and verify the resulting SNARK in your browser. No API key, no trust required.";

// Used to resolve relative OG / Twitter image URLs to absolute ones.
// Override per environment via NEXT_PUBLIC_SITE_URL when the canonical
// domain changes (e.g. if a custom domain like demo.icme.io is wired up).
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://preflight-demo.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    type: "website",
    siteName: "Preflight (ICME)",
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
