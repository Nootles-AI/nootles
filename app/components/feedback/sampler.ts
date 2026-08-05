/**
 * Bridge between the suggestion pipeline (which counts dismissals) and the
 * one-line "why'd you skip it?" chip row (which shows every Nth). A module
 * pub/sub rather than context, because the counter lives in an editor hook and
 * the chip row lives in the workspace shell.
 */

const EVERY = 15;

let count = 0;
let listener: (() => void) | null = null;

export function onSampleDue(fn: (() => void) | null) {
  listener = fn;
}

export function noteDismissal() {
  count += 1;
  if (count % EVERY === 0) listener?.();
}
