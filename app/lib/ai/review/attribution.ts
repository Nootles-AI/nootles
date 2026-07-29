/**
 * Who changed the document.
 *
 * A review does not lock the page — the user keeps typing while they read it —
 * so "did the user touch this block" has to be answerable, and BlockNote reports
 * every change as `local` whether a person made it or the applier did. The
 * pipeline's own writes run synchronously inside these calls, so the depth is
 * enough to tell them apart. Same reason `ghostText` keeps a suppress depth: a
 * listener that cannot tell whose edit it is fires on its own side effects.
 */

let depth = 0;

export function asReview<T>(run: () => T): T {
  depth++;
  try {
    return run();
  } finally {
    depth--;
  }
}

export function isReviewWriting(): boolean {
  return depth > 0;
}
