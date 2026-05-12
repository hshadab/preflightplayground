"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log error to console in development
    console.error("Demo error:", error);
  }, [error]);

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-6 text-center">
        <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-rose-700">
          Something went wrong
        </div>
        <h1 className="mb-3 text-xl font-semibold text-stone-900">
          The demo encountered an error
        </h1>
        <p className="mb-4 text-sm text-stone-600">
          This is likely a temporary issue. Try refreshing the page or resetting the demo state.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <button
            onClick={reset}
            className="rounded bg-[#346DDB] px-4 py-2 text-sm font-medium text-white hover:bg-[#2756b8]"
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:border-stone-400"
          >
            Reload page
          </button>
        </div>
        {process.env.NODE_ENV === "development" && (
          <pre className="mt-4 max-h-40 overflow-auto rounded bg-stone-900 p-3 text-left font-mono text-xs text-stone-100">
            {error.message}
            {error.stack && `\n\n${error.stack}`}
          </pre>
        )}
      </div>
    </main>
  );
}
