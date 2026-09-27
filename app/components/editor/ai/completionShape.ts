import { INLINE_TAGS } from "@/app/lib/ai/html/grammar";

/**
 * What a caret can accept, which is what `/api/complete` sizes the token
 * budget and the stop sequences by (`AI.fim.maxTokens`).
 *
 * - `complete`: the Complete end of the dial, which never takes blocks.
 * - `prose`: a clause, ending at a line break. A table cell holds inline
 *   content only, and a caret with words after it in its block is finishing a
 *   sentence, not starting a block: a block opened there would split the
 *   person's paragraph around it.
 * - `structure`: an empty block, or the end of one, where the next thing the
 *   page needs may well be a list, a table or a diagram.
 *
 * Every create-mode caret outside a cell used to ask for `structure` (NT-102),
 * so a mid-sentence continuation got 420 tokens and no stop sequence, and ran
 * on through `</p><p>` into a paragraph of its own.
 */
export type CompletionShape = "complete" | "prose" | "structure";

export function completionShape(opts: {
  allowBlocks: boolean;
  cell: boolean;
  /** The projection after the caret, as `toDocHtmlSplit` returns it. */
  suffix: string;
}): CompletionShape {
  if (!opts.allowBlocks) return "complete";
  if (opts.cell) return "prose";
  return wordsAfterCaret(opts.suffix) ? "prose" : "structure";
}

/**
 * Whether the caret's block carries on after it: any text before the first
 * block-level tag (the one closing the caret's own block) or line break.
 * Inline marks are part of the sentence, so `<strong>` does not end it.
 */
export function wordsAfterCaret(suffix: string): boolean {
  const re = /<\/?([a-zA-Z][\w-]*)[^>]*>|\n/g;
  let end = suffix.length;
  let m: RegExpExecArray | null;
  while ((m = re.exec(suffix))) {
    if (m[0] === "\n" || !INLINE_TAGS.has(m[1].toLowerCase())) {
      end = m.index;
      break;
    }
  }
  const text = suffix
    .slice(0, end)
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/g, " ");
  return text.trim().length > 0;
}
