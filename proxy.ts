import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next 16 renamed the `middleware` convention to `proxy` — Clerk's own docs
 * still say `middleware.ts`, which this version no longer picks up.
 *
 * Everything is private except the two pages the sign-in round trip needs. The
 * API routes are in scope deliberately: they spend the model key, so they are
 * protected here as well as re-checking identity themselves.
 */
const isPublic = createRouteMatcher(["/sign-in(.*)", "/sso-callback(.*)"]);

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
