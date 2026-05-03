import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Preflight Proofs Playground",
  description:
    "Run a real Preflight verification against an AI agent's spending action and independently verify the resulting cryptographic proof in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
