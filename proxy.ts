import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next 16 renamed the `middleware` convention to `proxy` — Clerk's own docs
 * still say `middleware.ts`, which this version no longer picks up.
 *
 * Everything is private except the two pages the sign-in round trip needs. The
 * API routes are in scope deliberately: they spend the model key, so they are
 * protected here as well as re-checking identity themselves.
 */
const isPublic = createRouteMatcher([
  // PostHog's proxied ingestion — beacons carry no Clerk session.
  "/ingest(.*)",
  "/sign-in(.*)",
  "/sso-callback(.*)",
  // Share links are capability URLs: the token in the path is the whole
  // admission, and demanding a session first would defeat their point.
  "/share/(.*)",
  // A place card's photographs, which a shared page has to be able to draw.
  // Bytes only, and only ever from Google Places — see the route's own note.
  "/api/places/photo(.*)",
  // Where an operator's stand-in token is caught. Public because it has to run
  // BEFORE any redirect: the token rides in the fragment, and a fragment does
  // not survive a bounce through Clerk and back. It reaches the cookie first,
  // and the redirect to `/` is then protected like everything else — so an
  // operator who was signed out signs in and lands in the session intact.
  // The page itself discloses nothing; the token is only worth what Convex
  // decides it is worth.
  "/impersonate",
]);

/**
 * The AI lanes, which are what an operator stand-in must not reach.
 *
 * Everything else about impersonation is enforced in Convex, but these routes
 * answer to the Clerk cookie — the operator's own — rather than to the stand-in
 * token, so Convex never sees them. Left open they would spend the model key
 * and write against the wrong account entirely. The cookie's presence is the
 * whole signal; nothing here needs to trust its contents.
 */
const isModelSpend = createRouteMatcher(["/api/(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (
    isModelSpend(request) &&
    request.cookies.has("nt_imp") &&
    !isPublic(request)
  ) {
    return new Response("Unavailable while standing in for another account", {
      status: 403,
    });
  }
  if (!isPublic(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Everything but Next internals and files with an extension.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
