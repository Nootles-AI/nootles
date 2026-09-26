import { getToolName, isToolUIPart } from "ai";
import type { LookAtResult } from "./lookAt";
import type { AbMessage } from "./types";

/**
 * A message as the thread keeps it: its tool calls with anything oversized cut
 * down, and everything else exactly as it streamed.
 *
 * Convex refuses a document past 1 MiB, and an assistant message holds every
 * tool call of its turn — whole files, whole page reads, whole edits. A turn
 * that researched a codebase passed the limit, and every save after that
 * failed: reloaded, the thread lost the turn. The live turn never reads from
 * here — the browser holds it — and what a later turn replays of this one, the
 * route shortens anyway (`shortenStaleReads`), so the cut costs nothing the
 * model would have read. Reasoning is never touched: it carries the provider's
 * signature, and a replayed block that lost it is dropped.
 */
export function forStorage(parts: AbMessage["parts"]): AbMessage["parts"] {
  parts = parts.map(withoutPictureData);
  let out = parts;
  for (const cap of CAPS) {
    out = parts.map((part) =>
      isToolUIPart(part)
        ? ({ ...part, input: clipDeep(part.input, cap), output: clipDeep(part.output, cap) } as typeof part)
        : part,
    );
    if (JSON.stringify(out).length <= BUDGET) return out;
  }
  return out;
}

/**
 * A `look_at` result with its pictures' bytes taken out, handles kept.
 *
 * The bytes were for the turn that looked (see `lookAt.ts`), and kept they are
 * most of a message: four photographs are megabytes of base64, and cut to fit
 * below they became broken data URIs that a reloaded turn sent as pictures.
 */
function withoutPictureData(part: AbMessage["parts"][number]): AbMessage["parts"][number] {
  if (!isToolUIPart(part) || getToolName(part) !== "look_at" || part.state !== "output-available") {
    return part;
  }
  const { images } = (part.output ?? {}) as Partial<LookAtResult>;
  if (!Array.isArray(images)) return part;
  return {
    ...part,
    output: {
      ...(part.output as LookAtResult),
      images: images.map(({ handle, mediaType }) => ({ handle, mediaType })),
    },
  } as typeof part;
}

/** Tightened in turn until the message fits. */
const CAPS = [6_000, 1_500, 300];

/** Characters, well inside Convex's 1 MiB: its encoding is not JSON's, and text is not all ASCII. */
const BUDGET = 700_000;

function clipDeep(value: unknown, cap: number): unknown {
  if (typeof value === "string") return clip(value, cap);
  if (Array.isArray(value)) return value.map((item) => clipDeep(item, cap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipDeep(v, cap)]));
  }
  return value;
}

function clip(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const cut = text.lastIndexOf("\n", cap);
  return `${text.slice(0, cut > 0 ? cut : cap)}\n<!-- cut when the thread was saved: ${text.length} characters -->`;
}
