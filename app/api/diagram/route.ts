import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { streamDiagram } from "@/app/lib/ai/diagram";
import { recordAiCall } from "@/app/lib/ai/recordCall";
import { stagedDiagram } from "@/app/lib/ai/staged/diagram";
import { asUser } from "@/app/lib/convexServer";
import { refuseIfLimited } from "@/app/lib/requestLimitGate";
import { sessionToken } from "@/app/lib/session";

/**
 * Expands one `<nt-build-diagram>` into canvas HTML.
 *
 * The second half of the completion lane: stage one decides, in the grammar,
 * that a diagram comes next and says in a phrase what it is for; this turns
 * that phrase into shapes. Streamed as plain text so the caller can draw the
 * diagram as it arrives.
 */
export const maxDuration = 60;

/** A repository's styling facts, capped — the brief and the page still come first. */
const LOOK_CHARS = 2400;

export async function POST(req: Request) {
  const token = await sessionToken();
  if (!token) return new Response("Unauthorized", { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { brief, page, title, projectId } = (body ?? {}) as {
    brief?: unknown;
    page?: unknown;
    title?: unknown;
    projectId?: unknown;
  };
  if (typeof brief !== "string" || !brief.trim()) {
    return new Response("`brief` must be a non-empty string", { status: 400 });
  }

  // Ahead of the limiter and the model both: a staged expansion calls neither,
  // and a demo must not throttle. Null unless the flag is on and the brief is
  // the one T-10 writes, so every other diagram takes the ordinary path.
  const canned = stagedDiagram(brief);
  if (canned) return canned;

  // Before the model, after the body is known to be worth sending: a diagram is
  // one `agentGeneration`, and a burst of them spends the key as fast as chat.
  const convex = asUser(token);
  const limited = await refuseIfLimited(convex, "agentGeneration");
  if (limited) return limited;

  // How the project's product looks, read here with the caller's own access
  // rather than taken from the request: it becomes instruction, and a body is
  // anything anyone sends.
  const look =
    typeof projectId === "string"
      ? await convex
          .query(api.context.read.packInputs, { projectId: projectId as Id<"projects"> })
          .then((inputs) =>
            (inputs?.code ?? [])
              .flatMap((repo) =>
                repo.styling ? [`${repo.fullName}:\n${repo.styling.slice(0, LOOK_CHARS)}`] : [],
              )
              .join("\n\n"),
          )
          .catch(() => "")
      : "";

  try {
    return streamDiagram(
      brief,
      typeof page === "string" ? page : "",
      typeof title === "string" ? title : "",
      look,
      req.signal,
      ({ usage, latencyMs }) =>
        recordAiCall(convex, {
          feature: "diagram",
          model: AI.diagram.model,
          projectId: typeof projectId === "string" ? projectId : undefined,
          promptTokens: usage.inputTokens,
          completionTokens: usage.outputTokens,
          cacheReadTokens: usage.inputTokenDetails.cacheReadTokens,
          cacheWriteTokens: usage.inputTokenDetails.cacheWriteTokens,
          latencyMs,
          status: req.signal.aborted ? "aborted" : "ok",
        }),
    );
  } catch (e) {
    if ((e as Error).name === "AbortError") return new Response(null, { status: 204 });
    return new Response("Upstream request failed", { status: 502 });
  }
}
