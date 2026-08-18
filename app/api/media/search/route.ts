import { apple, spotify, type Answer } from "@/app/lib/songs";

/**
 * The block's search box.
 *
 * Behind the session, because Apple's rate limits and Spotify's token are both
 * this deployment's to spend. The engine is `app/lib/songs.ts`, shared with the
 * agent's `find_songs` tool.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const provider = params.get("provider");
  const query = (params.get("q") ?? "").trim();

  if (!query) return Response.json({ results: [] } satisfies Answer);
  if (provider !== "apple" && provider !== "spotify") {
    return Response.json({ results: [] } satisfies Answer, { status: 400 });
  }

  try {
    return Response.json(provider === "apple" ? await apple(query) : await spotify(query));
  } catch {
    return Response.json({ results: [] } satisfies Answer, { status: 503 });
  }
}
