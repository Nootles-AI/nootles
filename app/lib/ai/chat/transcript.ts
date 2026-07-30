import type { ModelMessage, ToolResultPart } from "ai";
import { AI } from "../aiConfig";

// Derived from what `ai` re-exports rather than imported from
// `@ai-sdk/provider-utils`, which is only here as one of its dependencies.
type ProviderOptions = NonNullable<ModelMessage["providerOptions"]>;
type ToolResultOutput = ToolResultPart["output"];

/**
 * The conversation as the model reads it, which is not the conversation the
 * thread holds.
 *
 * Both passes here are server-side and neither touches what is stored or shown:
 * the transcript is the record, this is the request. Nothing is dropped from the
 * store, so the panel still shows what happened and a rewind still has something
 * to wind back to.
 *
 * Not the SDK's `pruneMessages`, on two counts. It removes a tool call whole,
 * where what is worth losing here is the page copy and not the record of having
 * edited the page — a model that cannot see itself having done something may do
 * it again. And its window is counted in messages, which lands mid-turn: this
 * one is bounded by the last thing the user said, which is where the turn began.
 */

/**
 * Tools whose result is a whole page, and is therefore only true for as long as
 * nothing touches that page.
 *
 * `search_web` is deliberately not one of them: a search result stays true, and
 * the model cannot get it back without spending another call. A page it can
 * simply read again.
 */
const PAGE_SNAPSHOTS: ReadonlySet<string> = new Set([
  "read_page",
  "read_open_page",
  "edit_page",
]);

/**
 * Shortens the page copies that earlier turns left behind.
 *
 * Between two questions everything invalidates a page read: the user types in
 * their own tab, the agent's own edits mint ids, and discarding a review writes
 * the checkpoint back. So the model is told to read a page before it answers
 * about one or edits it, and it does — which is what makes the copy from an
 * earlier turn dead weight rather than context. It is not merely unused, it
 * disagrees with the page, and `edit_page` refuses ids the page no longer has.
 *
 * Measured on a real thread: 72% of what was re-sent each turn was superseded
 * tool output.
 *
 * The head of each result is kept, because the first line is the part that was
 * never about the page's contents — `edit_page` opens with what it did, a read
 * opens with the title — and a turn the model cannot see itself having taken is
 * a turn it may take again.
 */
export function shortenStaleReads(messages: ModelMessage[]): ModelMessage[] {
  // The turn in flight begins at the last thing the user said, and is left
  // whole: a step routinely acts on what the step before it read, and shortening
  // that mid-turn would send the model back for what it already had — or, worse,
  // round the same read twice.
  const turn = lastIndexOf(messages, (message) => message.role === "user");

  return messages.map((message, i) => {
    if (i > turn || message.role !== "tool") return message;
    let shortened = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result" || !PAGE_SNAPSHOTS.has(part.toolName)) return part;
      const output = clip(part.output);
      if (output === part.output) return part;
      shortened = true;
      return { ...part, output };
    });
    return shortened ? { ...message, content } : message;
  });
}

/**
 * Where the provider may cache what it has already read.
 *
 * Anthropic caches by prefix, so a breakpoint stands for everything before it as
 * well, and two are enough to cover how this loop actually grows:
 *
 *  - the last thing the USER said, which is the whole conversation up to the
 *    question in flight and does not change for the rest of the turn. Every tool
 *    the browser owns ends its request and the turn resumes in a new one, so a
 *    turn spends this same prefix once per step — up to `maxSteps` times.
 *  - the end of the transcript, so the step just taken is cached for the step
 *    after it, which will re-send it verbatim.
 *
 * Merged into any provider options the message already carries rather than
 * replacing them: an assistant message holds its `reasoning_details` there, and
 * a reasoning block that loses its signature is dropped from the request.
 */
export function markCachePoints(messages: ModelMessage[]): ModelMessage[] {
  if (!messages.length) return messages;
  const question = lastIndexOf(messages, (message) => message.role === "user");
  const at = new Set([messages.length - 1, ...(question < 0 ? [] : [question])]);

  return messages.map((message, i) =>
    at.has(i) ? { ...message, providerOptions: cached(message.providerOptions) } : message,
  );
}

/** A cache breakpoint, kept as its own export so the route can mark the system prompt. */
export function cached(existing?: ProviderOptions): ProviderOptions {
  return {
    ...existing,
    openrouter: { ...existing?.openrouter, cacheControl: { type: "ephemeral" } },
  };
}

/**
 * Written in the dialect, because that is what the model is reading here, and it
 * has to say the page moved on rather than that the page is short — a result
 * that merely stops reads as a page that ends there.
 */
const MOVED_ON =
  "<!-- The rest of this result is not shown: it is from an earlier turn, and the page has changed since. Read the page again for what it says now. -->";

function clip(output: ToolResultOutput): ToolResultOutput {
  if (output.type !== "text") return output;
  const { value } = output;
  if (value.length <= AI.chat.staleReadChars) return output;
  // At a line break, because a page is serialised one block per line: cutting
  // mid-element would leave a half-written tag for the model to make sense of.
  const cut = value.lastIndexOf("\n", AI.chat.staleReadChars);
  const head = value.slice(0, cut > 0 ? cut : AI.chat.staleReadChars).trimEnd();
  return { ...output, value: `${head}\n${MOVED_ON}` };
}

function lastIndexOf<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (match(items[i])) return i;
  }
  return -1;
}
