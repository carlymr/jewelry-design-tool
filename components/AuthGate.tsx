"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSession, onAuthChange, signInWithGoogle } from "@/lib/auth";

// Everything behind the gate can assume a signed-in user. `undefined` means
// the initial session check hasn't resolved yet (avoid flashing the sign-in
// screen at users who are already logged in).

const SessionContext = createContext<Session | null>(null);
export const useSession = () => useContext(SessionContext);

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [signingIn, setSigningIn] = useState(false);

  useEffect(() => {
    // On the OAuth-callback landing, the auth-change event can fire before a
    // concurrently in-flight getSession() resolves null — don't let the
    // stale result flash the sign-in screen back.
    let sawAuthEvent = false;
    const unsubscribe = onAuthChange((s) => {
      sawAuthEvent = true;
      setSession(s);
    });
    getSession()
      .then((s) => {
        if (!sawAuthEvent) setSession(s);
      })
      .catch(() => {
        if (!sawAuthEvent) setSession(null);
      });
    return unsubscribe;
  }, []);

  if (session === undefined) {
    return (
      <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">
        Loading…
      </div>
    );
  }

  if (!session) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-gray-50 px-6">
        <div className="bg-white border border-gray-200 rounded-xl p-8 shadow-sm w-full max-w-sm text-center">
          <h1 className="text-2xl font-bold text-purple-700 mb-2">
            Jewelry Design Tool
          </h1>
          <p className="text-gray-600 text-sm mb-6">
            Sign in to open your beading board, inventory, and listings.
          </p>
          <button
            onClick={() => {
              setError("");
              setSigningIn(true);
              signInWithGoogle().catch((e) => {
                console.error("Sign-in failed:", e);
                setSigningIn(false);
                setError("Something went wrong signing in — please try again.");
              });
            }}
            disabled={signingIn}
            className="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-60 disabled:cursor-wait"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            {signingIn ? "Redirecting to Google…" : "Continue with Google"}
          </button>
          {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
        </div>
      </main>
    );
  }

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
