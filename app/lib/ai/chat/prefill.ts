/**
 * A question put in the box for someone else to send.
 *
 * The first-run guide writes the composer's text but never presses Send: the
 * whole point of that beat is that the user asks, watches the agent work, and
 * then answers for the change — pressing it for them would demonstrate the
 * agent while teaching nothing about who is in charge of it.
 *
 * A module-level store rather than a prop, so the path from guide to composer
 * does not have to be threaded through the workspace and the chat panel, both
 * of which would otherwise re-render on a value neither of them uses.
 */

let pending: string | null = null;
const listeners = new Set<(text: string) => void>();

export function prefillComposer(text: string) {
  pending = text;
  for (const listener of listeners) listener(text);
}

/**
 * Subscribe, and receive anything already waiting.
 *
 * The replay matters: the guide asks for the chat rail and writes the question
 * in the same breath, and a collapsed rail has no composer mounted yet to hear
 * it. Without this the question would be written to nobody.
 */
export function onPrefill(listener: (text: string) => void): () => void {
  listeners.add(listener);
  if (pending !== null) listener(pending);
  return () => {
    listeners.delete(listener);
  };
}

export function clearPrefill() {
  pending = null;
}
