/**
 * The completion lane, switched off.
 *
 * First run does not call a model at all. It used to script one at the network
 * layer, on the theory that a fake response travelling the real pipeline could
 * not drift from it — but the pipeline has a dozen honest reasons to withdraw a
 * suggestion (superseded, unparsed, ungrounded, nothing left after the block
 * gate), and a guide cannot promise "press Tab" on top of machinery that is
 * allowed to change its mind. It kept changing its mind.
 *
 * So the guide now paints the suggestion itself, through the same plugin the
 * lane paints through, and this turns the lane off while it does. Tab still
 * works exactly as it always did: `acceptSuggestion` inserts ghost text and
 * calls `onAccept` for an action, and neither of those knows who wrote it.
 */

let suspended = false;

export function suspendCompletions(on: boolean) {
  suspended = on;
}

export function completionsSuspended(): boolean {
  return suspended;
}

/**
 * Feeds `text` out a piece at a time, the way a model's stream arrives.
 *
 * The jitter is not decoration: a perfectly even reveal reads as a progress
 * bar, and it is the unevenness that makes this look like something being
 * written. Returns a stop function — a beat that ends early must not go on
 * typing into a document nobody is looking at any more.
 */
export function reveal(
  text: string,
  onStep: (sofar: string, done: boolean) => void,
  opts: { startMs?: number; stepMs?: number; chunk?: (rest: string) => number } = {},
): () => void {
  const { startMs = 520, stepMs = 28, chunk = wordish } = opts;
  let at = 0;
  let timer: ReturnType<typeof setTimeout>;

  const step = () => {
    at = Math.min(text.length, at + chunk(text.slice(at)));
    const done = at >= text.length;
    onStep(text.slice(0, at), done);
    if (!done) timer = setTimeout(step, stepMs * (0.6 + Math.random() * 0.9));
  };

  timer = setTimeout(step, startMs);
  return () => clearTimeout(timer);
}

/** A word and the space in front of it, which is roughly what a token is. */
function wordish(rest: string): number {
  const found = /^\s*\S+/.exec(rest);
  return found ? found[0].length : 1;
}
