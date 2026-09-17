import type { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { ModelCall } from "@/app/lib/ai/chat/provider";
import { SCRIPTS } from "./scripts";
import { resolveStep, stagedModel } from "./model";
import type { StageContext, StagedScript } from "./types";

/**
 * Whether this request is a staged one, and if so what to answer with.
 *
 * One `if` in the chat route. `null` is the fallthrough and the only failure
 * mode worth designing for: no flag, no allowlist, no match, no match we are
 * confident about, or a resolver that found nothing — all of them end with the
 * real model running, which is always an acceptable answer.
 */

/**
 * Off unless switched on, and then only for named people.
 *
 * An allowlist of Clerk subjects rather than of projects: a project id can be
 * shared, guessed or inherited, where the subject is who is actually signed in.
 * Empty or unset means nobody — never everybody. A demo account is the only
 * thing this is for, and the failure we care about is a stranger being handed a
 * canned answer about a rover they have never heard of.
 */
export function stagingOn(userId: string | null | undefined): boolean {
  if (process.env.STAGED_DEMO !== "1") return false;
  if (!userId) return false;
  const allowed = (process.env.STAGED_DEMO_USERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(userId);
}

/**
 * The script this wording asks for, or null.
 *
 * Exported for the test, which is where the real work of this module is: the
 * corpus on every script asserts that a presenter can vary the words, and the
 * cross-check asserts they cannot vary them into somebody else's call.
 *
 * Two matches is treated as no match. A demo that answers the wrong canned
 * question is worse than one that answers honestly, and the test makes sure
 * this branch is unreachable for every phrase we have thought of.
 */
export function matchScript(said: string): StagedScript | null {
  const hits = SCRIPTS.filter(
    (script) => script.match.test(said) && !script.not?.test(said),
  );
  return hits.length === 1 ? hits[0] : null;
}

/** Every script whose regex fires, used by the separation test. */
export function allMatches(said: string): StagedScript[] {
  return SCRIPTS.filter((script) => script.match.test(said) && !script.not?.test(said));
}

/** The last thing the user actually typed, which is what a turn is keyed on. */
function lastAsked(messages: AbMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    return message.parts
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
  }
  return "";
}

/**
 * Which step of the script this request is for.
 *
 * A client tool ends the request that carried it and the browser resumes the
 * turn with a new one, where `streamText` starts counting steps at zero again.
 * So the cursor is read off the turn itself — one `step-start` per step it has
 * taken — exactly as `route.ts:stepsTaken` already reads it.
 */
export function cursor(messages: AbMessage[]): number {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return 0;
  return last.parts.filter((part) => part.type === "step-start").length;
}

/** Tool results already in this turn, oldest first, for the resolvers. */
function resultsSoFar(messages: AbMessage[]): StageContext["results"] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];
  const out: StageContext["results"] = [];
  for (const part of last.parts) {
    if (typeof part.type !== "string" || !part.type.startsWith("tool-")) continue;
    const it = part as { type: string; state?: string; output?: unknown };
    if (it.state !== "output-available") continue;
    out.push({ toolName: it.type.slice("tool-".length), output: it.output });
  }
  return out;
}

export async function stageTurn(args: {
  messages: AbMessage[];
  projectId: Id<"projects">;
  pageId?: Id<"pages">;
  convex: ConvexHttpClient;
  /** The Clerk subject of whoever is asking. The allowlist is of people. */
  userId: string | null;
}): Promise<(ModelCall & { stagedId: string }) | null> {
  const { messages, projectId, pageId, convex, userId } = args;
  if (!stagingOn(userId)) return null;

  const said = lastAsked(messages);
  if (!said) return null;

  const script = matchScript(said);
  if (!script) return null;

  // Only now, because these are round trips and every unstaged turn in a staged
  // project would otherwise pay for them.
  const [pages, repos] = await Promise.all([
    convex
      .query(api.pages.listByProject, { projectId })
      .then((rows) =>
        rows
          .sort((a, b) => a.order - b.order)
          .map((p) => ({ pageId: String(p._id), title: p.title })),
      )
      .catch(() => [] as { pageId: string; title: string }[]),
    convex
      .query(api.ai.context.forPrompt, { projectId })
      .then((it) => (it?.repos ?? []).map((r) => r.fullName))
      .catch(() => [] as string[]),
  ]);

  const ctx: StageContext = {
    projectId,
    pageId,
    said,
    results: resultsSoFar(messages),
    pages,
    repos,
  };

  // A script that has run out of steps still answers — with a bare stop, which
  // ends the turn. Falling through to the real model here would spend a call and
  // append a second answer to a turn that already said everything it meant to.
  const step = resolveStep(script.steps[cursor(messages)], ctx, script.bail);
  return { model: stagedModel(script.id, step), stagedId: script.id };
}
