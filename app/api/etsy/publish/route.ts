import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizedUser, isOwnDesignPhoto } from "@/lib/api-token";
import { EtsyError, etsyAccess, etsyErrorResponse, etsyFetch } from "@/lib/etsy-server";
import { getSupabaseConfig } from "@/lib/supabase-config";
import { MAX_DESIGN_PHOTOS } from "@/lib/types";
import type { EtsyPublishResult } from "@/lib/etsy";

// Publishes a design's listing to Etsy as a DRAFT (GRA-37): createDraftListing
// with the listing text, then the design's photos uploaded in order (rank 1 is
// the primary). Drafts aren't visible to buyers; the seller reviews and
// activates it on Etsy. Photos are read from design-photos with the caller's
// token, as generate-listing does.

export const maxDuration = 60;

const PHOTO_BUCKET = "design-photos";

const BodySchema = z.object({
  title: z.string().min(1).max(1000),
  description: z.string().min(1).max(20000),
  tags: z.array(z.string().max(200)).max(50),
  materials: z.array(z.string().max(200)).max(50).optional(),
  price: z.number().positive(),
  taxonomy_id: z.number().int().positive(),
  shipping_profile_id: z.number().int().positive(),
  readiness_state_id: z.number().int().positive().optional(),
  return_policy_id: z.number().int().positive().optional(),
  who_made: z.literal("i_did"),
  when_made: z.string().regex(/^[a-z0-9_]+$/),
  photo_paths: z.array(z.string().max(300)).max(MAX_DESIGN_PHOTOS),
});

// Etsy's character rules (from the createDraftListing reference). Cleaning
// here beats a 400 for a stray emoji or slash in generated text.
function cleanTitle(title: string): string {
  let t = title.replace(/[^\p{L}\p{Nd}\p{P}\p{Sm}\p{Zs}™©®]/gu, " ");
  // %, :, & and + may each appear only once; later ampersands become "and".
  for (const ch of ["%", ":", "&", "+"]) {
    const first = t.indexOf(ch);
    if (first === -1) continue;
    const tail = t.slice(first + 1).split(ch).join(ch === "&" ? "and" : "");
    t = t.slice(0, first + 1) + tail;
  }
  return t.replace(/\s+/g, " ").trim().slice(0, 140);
}

function cleanList(items: string[], invalid: RegExp, maxLen: number, maxCount: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    // Stripped characters become spaces so "boho/gift" stays two words.
    let item = raw.replace(invalid, " ").replace(/\s+/g, " ").trim();
    if (item.length > maxLen) {
      // Cut at a word boundary rather than mid-word when there is one.
      const cut = item.slice(0, maxLen + 1).lastIndexOf(" ");
      item = (cut > 0 ? item.slice(0, cut) : item.slice(0, maxLen)).trim();
    }
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length === maxCount) break;
  }
  return out;
}

export async function POST(request: NextRequest) {
  const user = await authorizedUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid publish request." }, { status: 400 });
  }
  if (!body.photo_paths.every((p) => isOwnDesignPhoto(p, user.id))) {
    return NextResponse.json({ error: "Invalid photo path." }, { status: 400 });
  }
  const authHeader = request.headers.get("authorization")!;

  try {
    const access = await etsyAccess(authHeader, user.id);
    if (!access) throw new EtsyError(400, "Connect your Etsy shop first (or reconnect).");
    const { accessToken, shopId } = access;

    const form = new URLSearchParams({
      quantity: "1",
      title: cleanTitle(body.title),
      description: body.description,
      price: body.price.toFixed(2),
      who_made: body.who_made,
      when_made: body.when_made,
      taxonomy_id: String(body.taxonomy_id),
      is_supply: "false",
      type: "physical",
      shipping_profile_id: String(body.shipping_profile_id),
    });
    const tags = cleanList(body.tags, /[^\p{L}\p{Nd}\p{Zs}\-'™©®]/gu, 20, 13);
    if (tags.length) form.set("tags", tags.join(","));
    const materials = cleanList(body.materials ?? [], /[^\p{L}\p{Nd}\p{Zs}]/gu, 45, 13);
    if (materials.length) form.set("materials", materials.join(","));
    if (body.readiness_state_id) form.set("readiness_state_id", String(body.readiness_state_id));
    if (body.return_policy_id) form.set("return_policy_id", String(body.return_policy_id));

    const listing = await etsyFetch<{ listing_id: number }>(
      `/application/shops/${shopId}/listings`,
      {
        method: "POST",
        accessToken,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
      }
    );

    // The draft exists now; a photo failure is reported, not fatal. Uploads
    // run in parallel so six photos can't push the function past its time
    // limit after the draft is created (a timeout then would hide the draft
    // from the client and invite a duplicate). Each sets its own rank, so
    // order is kept; six calls fit Etsy's 10-per-second limit.
    const config = getSupabaseConfig();
    const uploads = await Promise.allSettled(
      body.photo_paths.map(async (path, i) => {
        if (!config) throw new Error("Supabase is not configured on the server.");
        const res = await fetch(`${config.url}/storage/v1/object/${PHOTO_BUCKET}/${path}`, {
          headers: { Authorization: authHeader, apikey: config.key },
        });
        if (!res.ok) throw new Error(`couldn't read it (${res.status})`);
        const image = new FormData();
        image.set("image", await res.blob(), path.split("/").pop()!);
        image.set("rank", String(i + 1));
        await etsyFetch(`/application/shops/${shopId}/listings/${listing.listing_id}/images`, {
          method: "POST",
          accessToken,
          body: image,
        });
      })
    );
    const photoErrors = uploads.flatMap((u, i) =>
      u.status === "rejected"
        ? [`Photo ${i + 1}: ${u.reason instanceof Error ? u.reason.message : "upload failed"}`]
        : []
    );

    const result: EtsyPublishResult = {
      listing_id: listing.listing_id,
      listing_url: `https://www.etsy.com/listing/${listing.listing_id}`,
      edit_url: `https://www.etsy.com/your/shops/me/listing-editor/edit/${listing.listing_id}`,
      photo_errors: photoErrors,
    };
    return NextResponse.json(result);
  } catch (error) {
    return etsyErrorResponse(error);
  }
}
