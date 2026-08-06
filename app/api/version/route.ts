/**
 * Which build is serving right now. Clients compare this against the sha
 * baked into their bundle; a mismatch means the tab predates the deploy.
 */
export function GET() {
  return Response.json(
    { sha: process.env.NEXT_PUBLIC_COMMIT_SHA ?? "dev" },
    { headers: { "cache-control": "no-store" } },
  );
}
