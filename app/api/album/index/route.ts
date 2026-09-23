import { AI } from "@/app/lib/ai/aiConfig";
import { describeSheet } from "@/app/lib/ai/albumIndex";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { asUser } from "@/app/lib/convexServer";
import { refuseIfLimited } from "@/app/lib/requestLimitGate";
import { session } from "@/app/lib/session";

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
  const caller = await session();
  if (!caller) return new Response("Unauthorized", { status: 401 });
  const { token } = caller;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { dataUri, handles, projectId: named } = (body ?? {}) as {
    dataUri?: unknown;
    handles?: unknown;
    projectId?: unknown;
  };
  const projectId = typeof named === "string" ? named : undefined;
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

  // One sheet is one `agentGeneration` — the same bucket chat and diagram spend,
  // because the same key pays for it. Refused, `albumRead` keeps the colour tier
  // and simply goes without captions, the same as any other failed describe.
  const convex = asUser(token);
  const limited = await refuseIfLimited(convex, "agentGeneration");
  if (limited) return limited;

  const started = Date.now();
  try {
    const { described, usage } = await describeSheet(
      { dataUri, handles: handles as string[] },
      req.signal,
    );
    recordAiCall(convex, {
      ownerId: caller.userId,
      feature: "album",
      model: AI.album.model,
      projectId,
      ...usage,
      latencyMs: Date.now() - started,
      status: "ok",
    });
    return Response.json({ described });
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    recordAiCall(convex, {
      ownerId: caller.userId,
      feature: "album",
      model: AI.album.model,
      projectId,
      latencyMs: Date.now() - started,
      status: "error",
      errorCode: (e as Error).message.slice(0, 200),
    });
    // The agent has the colour tier either way, and an album with no captions
    // is a poorer answer rather than a failed one.
    return Response.json({ described: [] });
  }
}
