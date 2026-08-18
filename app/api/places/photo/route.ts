import { configured, photo } from "@/app/lib/places";

/**
 * A place's photograph, with our key kept on this side of it.
 *
 * Public, and it has to be: a shared page has no session, and a card whose
 * pictures only appear for their author is a card that looks broken to
 * everyone it was shared with. What that opens is narrow — this fetches
 * nothing but Google Places photo media, named by a reference the caller must
 * already have been given, and returns bytes rather than JSON.
 *
 * Proxied rather than stored. A Places photo URL carries the key in its query
 * string, so linking one would publish the key on every page showing a café;
 * and copying the bytes into our own storage would keep a copy of Google's
 * photographs for longer than their terms allow. Passing them through is the
 * arrangement that is honest on both counts.
 */
export async function GET(request: Request) {
  const ref = new URL(request.url).searchParams.get("ref");
  // A reference is Google's own `places/<id>/photos/<id>` path and nothing
  // else; anything shaped differently is not a photograph we know about.
  if (!ref || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(ref)) {
    return new Response(null, { status: 400 });
  }
  if (!configured()) return new Response(null, { status: 404 });
  try {
    return await photo(ref);
  } catch {
    return new Response(null, { status: 502 });
  }
}
