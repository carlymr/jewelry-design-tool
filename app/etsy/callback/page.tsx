"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { finishEtsyConnect } from "@/lib/etsy";

// Where Etsy sends the browser after the seller approves the app (GRA-37).
// This page is behind AuthGate, so it has the session the bare redirect
// lacks; it hands code + state to the server and returns to Pricing.
// Register `${origin}/etsy/callback` as a callback URL on the Etsy app.

export default function EtsyCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  // Codes are single-use; StrictMode's double effect must not spend it twice.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    if (params.get("error") || !code || !state) {
      setError(
        params.get("error_description") ||
          (params.get("error") === "access_denied"
            ? "Etsy access wasn't granted."
            : "Etsy didn't send back a sign-in code.")
      );
      return;
    }
    finishEtsyConnect(code, state)
      .then(() => router.replace("/pricing"))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't connect Etsy."));
  }, [router]);

  return (
    <main className="max-w-xl mx-auto p-6 text-center">
      {error ? (
        <>
          <p className="text-red-700 mb-4">{error}</p>
          <Link href="/pricing" className="text-purple-700 underline">
            Back to Pricing &amp; Listing
          </Link>
        </>
      ) : (
        <p className="text-gray-500">Connecting your Etsy shop…</p>
      )}
    </main>
  );
}
