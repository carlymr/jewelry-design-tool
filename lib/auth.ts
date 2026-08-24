import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

// Thin wrappers around supabase-js auth so components don't touch the client
// directly. Sessions persist in localStorage and refresh automatically;
// signInWithOAuth round-trips through Supabase's /auth/v1/callback and lands
// back on the app, where detectSessionInUrl picks the session up.

export async function getSession(): Promise<Session | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session;
}

export function onAuthChange(
  callback: (session: Session | null) => void
): () => void {
  const { data } = getSupabase().auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

export async function signInWithGoogle(): Promise<void> {
  const { error } = await getSupabase().auth.signInWithOAuth({
    provider: "google",
    // Full href so sign-in returns to the page the user started on.
    options: { redirectTo: window.location.href },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await getSupabase().auth.signOut();
}

/** Current user's id, for stamping new rows until the DB default takes over. */
export async function getUserId(): Promise<string | null> {
  return (await getSession())?.user.id ?? null;
}

/** Access token for calling the app's API routes. */
export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null;
}

/** Headers for the app's API routes: the session JWT. */
export async function apiHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
