import type { ModelMessage } from "ai";
import { AI } from "../aiConfig";
import { isPageId, nowOpenNote } from "./prompt";
import type { AbMessage, TurnContext } from "./types";

/**
 * What a question is asked beside: the page it was asked from, the pages
 * around that one, and — when the comments gate lets them in — that page's
 * comments. Fixed for the whole turn.
 *
 * A turn is several requests, and each step of each re-sends the conversation
 * so far, which a provider bills at a tenth when its prefix matches what it
 * read the step before. This context used to be rendered afresh on every
 * request, and the note and page pack sat above the whole conversation as a
 * system message, so anything that moved them — an `open_page`, a write to
 * another page, a collaborator typing, which reorders "edited lately" — made
 * every message after them a miss (NT-97). The comments sat ahead of the latest
 * question, and moved as the agent's own comment tools changed them.
 *
 * So the route renders it once, on the request that opens the turn, and writes
 * it on the answer's metadata; the browser sends it back on every request that
 * resumes the turn, and the route places those same bytes in the same place.
 * Nothing after the question moves for it. Where the agent has gone since rides
 * last instead ({@link nowOpen}), where a change costs only itself.
 *
 * It is not kept past its turn. The browser does not persist it or send it for
 * an earlier turn, and an earlier question is sent without one: what surrounded
 * a page last week is not context, and the snapshot reads the turn took are
 * shortened from the next question on anyway (`shortenStaleReads`), which moves
 * the prefix there. Not persisting it also keeps a purged page's title and
 * brief out of the thread.
 */

/**
 * The most a context read back from the browser may hold. It is rendered by
 * the route, so a longer one is not one it wrote, and is rendered again.
 */
const MAX_CHARS =
  (AI.chat.context.pageTokens + AI.chat.context.commentsTokens) * 4 + 1_000;

/**
 * The turn's context, when the request resumes a turn that has one: the
 * answer being continued carries it.
 */
export function frozenContext(messages: AbMessage[]): TurnContext | null {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return null;
  const context: unknown = last.metadata?.turnContext;
  if (typeof context !== "object" || context === null) return null;
  const { pageId, text } = context as Record<string, unknown>;
  if (typeof text !== "string" || text.length > MAX_CHARS) return null;
  if (pageId !== undefined && !isPageId(pageId)) return null;
  return pageId === undefined ? { text } : { pageId, text };
}

/** `context` as a user message just ahead of the user's latest one. */
export function besideQuestion(history: ModelMessage[], context: string): ModelMessage[] {
  if (!context) return history;
  const at = history.findLastIndex((message) => message.role === "user");
  const attached: ModelMessage = { role: "user", content: context };
  return at < 0 ? [...history, attached] : [...history.slice(0, at), attached, ...history.slice(at)];
}

/**
 * Says which page is on screen, when the turn has moved off the one it was
 * asked from; null while it has not.
 */
export function nowOpen(context: TurnContext, pageId: unknown): ModelMessage | null {
  if (!isPageId(pageId) || pageId === context.pageId) return null;
  return { role: "user", content: nowOpenNote(pageId, context.pageId) };
}

/**
 * `messages` without `tail`, for a step to put back last. A step's messages are
 * the request's with the steps taken since appended, which would leave what was
 * last on the request in the middle — and the next request, with more behind
 * it, would differ from there on. Matched by content, since the SDK need not
 * hand back the objects it was given.
 */
export function withoutTail(messages: ModelMessage[], tail: ModelMessage[]): ModelMessage[] {
  if (!tail.length) return messages;
  const moved = new Set(tail.map((message) => message.content));
  return messages.filter(
    (message) => !(message.role === "user" && typeof message.content === "string" && moved.has(message.content)),
  );
}
