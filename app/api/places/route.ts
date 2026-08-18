import { configured, details, drive, resolve, search, type Answer } from "@/app/lib/places";

/**
 * Asking Google about places, for the block's search box.
 *
 * Behind the session, because every mode here spends the deployment's Places
 * quota. The photographs are the one exception and live next door at
 * `photo/route.ts`, which has to be public so a shared page can draw them.
 *
 * The engine itself is `app/lib/places.ts`, shared with the agent's
 * `find_places` tool — which calls it directly rather than coming back through
 * this door, since a server fetching its own protected route arrives with no
 * session and is sent to the sign-in page.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get("mode") ?? "search";

  // Following a short link is the one thing here Google does not charge for,
  // so it works whether or not this deployment has a key.
  if (mode === "resolve") {
    const url = params.get("url");
    if (!url) return Response.json({ error: "no url" } satisfies Answer, { status: 400 });
    try {
      return Response.json(await resolve(url));
    } catch {
      return Response.json({ error: "did not resolve" } satisfies Answer, { status: 502 });
    }
  }

  if (!configured()) return Response.json({ configured: false } satisfies Answer);

  try {
    if (mode === "details") {
      const id = params.get("place");
      return Response.json(id ? await details(id) : ({ error: "no place" } satisfies Answer));
    }
    if (mode === "drive") {
      const from = params.get("from");
      const to = params.get("to");
      return Response.json(
        from && to ? await drive(from, to) : ({ error: "no route asked" } satisfies Answer),
      );
    }
    const query = (params.get("q") ?? "").trim();
    if (!query) return Response.json({ places: [] } satisfies Answer);
    return Response.json(await search(query, params.get("near")));
  } catch {
    return Response.json({ error: "no answer from Google" } satisfies Answer, {
      status: 502,
    });
  }
}
