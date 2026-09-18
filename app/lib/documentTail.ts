/**
 * The editor's one structural affordance: every writable document ends in a
 * real, top-level, empty paragraph. The helper is deliberately structural so
 * it works for both BlockNote's denormalized blocks and canonical NML blocks.
 */
export function isEmptyParagraphBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const candidate = block as {
    type?: unknown;
    content?: unknown;
    children?: unknown;
  };
  const noChildren =
    candidate.children === undefined ||
    (Array.isArray(candidate.children) && candidate.children.length === 0);
  return (
    candidate.type === "paragraph" &&
    Array.isArray(candidate.content) &&
    candidate.content.length === 0 &&
    noChildren
  );
}

/** The last authored block, excluding the document's trailing writing row. */
export function lastContentBlock<T>(blocks: readonly T[]): T | undefined {
  const last = blocks.at(-1);
  return last !== undefined && isEmptyParagraphBlock(last)
    ? blocks.at(-2)
    : last;
}
