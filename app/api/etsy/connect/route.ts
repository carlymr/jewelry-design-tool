import { NextRequest, NextResponse } from "next/server";
import { authorizedUser } from "@/lib/api-token";
import {
  AUTHORIZE_URL,
  ETSY_SCOPES,
  etsyConfig,
  etsyErrorResponse,
  pkcePair,
  seal,
} from "@/lib/etsy-server";

// Starts the Etsy OAuth (PKCE) flow (GRA-37). Etsy's redirect back is a bare
// browser navigation with no Supabase session attached, so nothing is stored
// here: the PKCE verifier, the caller's id and the redirect URI travel inside
// `state`, sealed with the server key. /etsy/callback (a signed-in page)
// posts code + state to /api/etsy/callback, which unseals it and checks the
// caller is the same user.

const STATE_TTL_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  try {
    const { keystring } = etsyConfig();
    const { verifier, challenge } = pkcePair();
    // Must match a callback URL registered on the Etsy app exactly.
    const redirectUri = `${request.nextUrl.origin}/etsy/callback`;
    const state = seal({
      uid: user.id,
      verifier,
      redirectUri,
      exp: Date.now() + STATE_TTL_MS,
    });
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: keystring,
      redirect_uri: redirectUri,
      scope: ETSY_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    return NextResponse.json({ url: url.toString() });
  } catch (error) {
    return etsyErrorResponse(error);
  }
}
