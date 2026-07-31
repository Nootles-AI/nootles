import { streamDiagram } from "@/app/lib/ai/diagram";

/**
 * Expands one `<ab-build-diagram>` into canvas HTML.
 *
 * The second half of the completion lane: stage one decides, in the grammar,
 * that a diagram comes next and says in a phrase what it is for; this turns
 * that phrase into shapes. Streamed as plain text so the caller can draw the
 * diagram as it arrives.
 */
export const maxDuration = 60;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { brief, page, title } = (body ?? {}) as {
    brief?: unknown;
    page?: unknown;
    title?: unknown;
  };
  if (typeof brief !== "string" || !brief.trim()) {
    return new Response("`brief` must be a non-empty string", { status: 400 });
  }

  try {
    return streamDiagram(
      brief,
      typeof page === "string" ? page : "",
      typeof title === "string" ? title : "",
      req.signal,
    );
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
}
