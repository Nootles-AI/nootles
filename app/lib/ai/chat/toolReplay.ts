import { getToolName, isToolUIPart } from "ai";
import { TOOLS } from "./tools";
import type { AbMessage } from "./types";

type ToolCallLike = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

/** Stable JSON identity for one tool mutation, independent of object key order. */
function fingerprint(toolName: string, input: unknown): string {
  return `${toolName}:${JSON.stringify(stable(input))}`;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
}

/**
 * Whether this exact mutation already completed after the current user's message.
 *
 * The transcript is the ledger rather than an in-memory set: it survives the
 * client-tool request/resume cycle and a browser reload. Failed calls remain
 * retryable, as does edit_page's explicit transient "same content" recovery.
 */
export function isRepeatedMutation(
  messages: AbMessage[],
  call: ToolCallLike,
): boolean {
  const spec = (TOOLS as Record<string, { mutates?: boolean }>)[call.toolName];
  if (!spec?.mutates) return false;

  let turnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      turnStart = i;
      break;
    }
  }
  if (turnStart < 0) return false;

  const wanted = fingerprint(call.toolName, call.input);
  for (const message of messages.slice(turnStart + 1)) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isToolUIPart(part) || part.toolCallId === call.toolCallId) continue;
      if (part.state !== "output-available") continue;
      if (getToolName(part) !== call.toolName) continue;
      if (allowsExactRetry(part.output)) continue;
      if (fingerprint(call.toolName, part.input) === wanted) return true;
    }
  }
  return false;
}

function allowsExactRetry(output: unknown): boolean {
  return (
    typeof output === "string" &&
    // A refusal wrote nothing, so the same call later is not a repeat — a
    // comment refused under a review is fair to retry once the review is kept.
    (/call edit_page once more with the\s+same content/i.test(output) ||
      output.startsWith("Nothing was written."))
  );
}

/** The model sees why the second call did not change the document. */
export function duplicateMutationResult(toolName: string): string {
  return (
    `Skipped duplicate ${toolName}: this exact change already ran in this user turn. ` +
    "The document was not changed again; continue from the earlier result."
  );
}
