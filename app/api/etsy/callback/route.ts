import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizedUser } from "@/lib/api-token";
import {
  EtsyError,
  etsyErrorResponse,
  etsyFetch,
  exchangeCode,
  saveConnection,
  unseal,
} from "@/lib/etsy-server";

// Finishes the Etsy OAuth flow (see ../connect/route.ts): unseals `state`,
// checks it was issued to this caller and hasn't expired, exchanges the code,
// looks up the shop, and stores the encrypted tokens.

const BodySchema = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().min(1).max(4000),
});

interface State {
  uid: string;
  verifier: string;
  redirectUri: string;
  exp: number;
}

export async function POST(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Body must include code and state." }, { status: 400 });
  }

  try {
    let state: State;
    try {
      state = unseal<State>(body.state);
    } catch {
      throw new EtsyError(400, "This Etsy sign-in link is invalid. Start again from Connect.");
    }
    if (state.uid !== user.id) {
      throw new EtsyError(400, "This Etsy sign-in was started by a different account.");
    }
    if (state.exp < Date.now()) {
      throw new EtsyError(400, "This Etsy sign-in expired. Start again from Connect.");
    }

    const tokens = await exchangeCode(body.code, state.verifier, state.redirectUri);
    const me = await etsyFetch<{ user_id: number; shop_id: number | null }>(
      "/application/users/me",
      { accessToken: tokens.access_token }
    );
    if (!me.shop_id) {
      throw new EtsyError(400, "That Etsy account doesn't have a shop.");
    }
    await saveConnection(request.headers.get("authorization")!, user.id, me.shop_id, tokens);
    return NextResponse.json({ shop_id: me.shop_id });
  } catch (error) {
    return etsyErrorResponse(error);
  }
}
