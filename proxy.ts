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
  // Link preview demo page.
  "/link(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublic(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Everything but Next internals and files with an extension.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
