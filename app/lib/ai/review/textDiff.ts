/**
 * Word-level diff between the checkpoint's text and the text on screen.
 *
 * Tokens, not characters: a character diff of a rewritten sentence is confetti,
 * and what a reader wants to see is which WORDS moved. Whitespace is its own
 * token so the offsets it reports land exactly on the live text — they become
 * ProseMirror positions, and being off by a space puts a strikethrough inside a
 * word.
 */

export type DiffPart =
  | { kind: "same" | "add"; text: string; at: number; end: number }
  /** Text the checkpoint had, gone from the document; `at` is where it stood. */
  | { kind: "del"; text: string; at: number; end: number };

const TOKEN = /\s+|\S+/g;

function tokenise(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

/**
 * `null` when the two are too far apart to diff usefully — the table is
 * quadratic, and past a few hundred tokens a word-level answer is noise anyway.
 * The caller falls back to marking the whole block.
 */
export function tokenDiff(
  before: string,
  after: string,
  limit = 400,
): DiffPart[] | null {
  if (before === after) return [];

  const a = tokenise(before);
  const b = tokenise(after);

  // Common ends first. A one-word change in a long paragraph is then a diff of
  // one token against one, and the table never gets built.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  if (midA.length > limit || midB.length > limit) return null;

  const parts: DiffPart[] = [];
  // Offsets into `after`, which is the text the positions are read against. A
  // deletion has no width there, so it reports the point it sat at.
  let at = 0;
  const emit = (kind: DiffPart["kind"], text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.kind === kind) {
      last.text += text;
      if (kind !== "del") last.end = at + text.length;
    } else {
      parts.push({ kind, text, at, end: kind === "del" ? at : at + text.length });
    }
    if (kind !== "del") at += text.length;
  };

  emit("same", b.slice(0, head).join(""));
  for (const step of lcsWalk(midA, midB)) emit(step.kind, step.text);
  emit("same", tail ? b.slice(b.length - tail).join("") : "");

  return parts;
}

type Step = { kind: "same" | "add" | "del"; text: string };

/** Longest common subsequence, walked back into same/add/del runs. */
function* lcsWalk(a: string[], b: string[]): Generator<Step> {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      yield { kind: "same", text: b[j] };
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      yield { kind: "del", text: a[i] };
      i++;
    } else {
      yield { kind: "add", text: b[j] };
      j++;
    }
  }
  while (i < n) yield { kind: "del", text: a[i++] };
  while (j < m) yield { kind: "add", text: b[j++] };
}
