const MISSING_CONVEX_URL =
  "NEXT_PUBLIC_CONVEX_URL is required at build time. " +
  "On Vercel, configure CONVEX_DEPLOY_KEY for this environment and build with " +
  "`npx convex deploy --cmd 'npm run build'`.";

/**
 * Return the public URL baked into this frontend build.
 *
 * Next.js freezes NEXT_PUBLIC_* values while building, so accepting an absent
 * value would only produce a deployed client that can never connect. Fail with
 * the configuration name and repair instead of Convex's opaque URL-parser
 * error.
 */
export function requireConvexDeploymentUrl(value: string | undefined): string {
  const url = value?.trim();
  if (!url) throw new Error(MISSING_CONVEX_URL);
  return url;
}
