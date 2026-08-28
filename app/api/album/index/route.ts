import { AI } from "@/app/lib/ai/aiConfig";
import { describeSheet } from "@/app/lib/ai/albumIndex";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { sessionToken } from "@/app/lib/session";

/**
 * Describes one contact sheet of an album's pictures.
 *
 * The sheet is composed in the browser, where the pictures already are and
 * where there is a canvas to compose it on; this route exists because the key
 * is here. It arrives as a data URI rather than as a stored file so that a
 * describe that fails leaves nothing behind to sweep up.
 *
 * Called at most once per album, by `read_page` when the agent expands one, and
 * never on upload — see the note on `AI.album`.
 */

/** A generous ceiling for a 24-tile WebP sheet; anything past it is not one. */
const MAX_SHEET_CHARS = 8_000_000;

export async function POST(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { dataUri, handles } = (body ?? {}) as { dataUri?: unknown; handles?: unknown };
  if (
    typeof dataUri !== "string" ||
    !dataUri.startsWith("data:image/") ||
    dataUri.length > MAX_SHEET_CHARS
  ) {
    return new Response("`dataUri` must be an inline image", { status: 400 });
  }
  if (
    !Array.isArray(handles) ||
    !handles.length ||
    !handles.every((h) => typeof h === "string")
  ) {
    return new Response("`handles` must be a non-empty array of strings", { status: 400 });
  }

  const started = Date.now();
  try {
    const { described, usage } = await describeSheet(
      { dataUri, handles: handles as string[] },
      req.signal,
    );
    recordAiCall(asUser(token), {
      feature: "album",
      model: AI.album.model,
      ...usage,
      latencyMs: Date.now() - started,
      status: "ok",
    });
    return Response.json({ described });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    recordAiCall(asUser(token), {
      feature: "album",
      model: AI.album.model,
      latencyMs: Date.now() - started,
      status: "error",
      errorCode: (e as Error).message.slice(0, 200),
    });
    // The agent has the colour tier either way, and an album with no captions
    // is a poorer answer rather than a failed one.
    return Response.json({ described: [] });
  }
}
