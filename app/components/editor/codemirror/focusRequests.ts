/**
 * The way into a code block's editor from outside it.
 *
 * The caret of a code block lives in CodeMirror, which ProseMirror cannot put
 * a selection into, and which may not exist yet: a block that has just become
 * code mounts its node view after the transaction that made it, and the
 * editor class itself is fetched on first use (see `CodeSurface`). So a
 * request is delivered to the block's editor if it is mounted, and otherwise
 * held until it mounts — briefly, so a request nobody claimed cannot steal
 * the caret from someone who has moved on.
 *
 * Requests carry the element of the page they came from, because the same
 * block can be on screen twice (two panes on one page) and only the editor
 * inside the asking page should answer.
 */

export type CodeCaret = "start" | "end";

/** An element that can say whether another is inside it — the page's root. */
export type FocusScope = { contains(other: unknown): boolean };

type Host = { host: unknown; focus: (at: CodeCaret) => void };
type Pending = { scope: FocusScope; at: CodeCaret; until: number };

/** Long enough for a first visit to fetch the editor on a slow connection. */
const HOLD_MS = 5000;

const mounted = new Map<string, Set<Host>>();
const pending = new Map<string, Pending>();

/** Put the caret into block `id`'s code editor, within `scope`. */
export function focusCodeBlock(scope: FocusScope, id: string, at: CodeCaret): void {
  for (const entry of mounted.get(id) ?? []) {
    if (scope.contains(entry.host)) {
      pending.delete(id);
      entry.focus(at);
      return;
    }
  }
  pending.set(id, { scope, at, until: Date.now() + HOLD_MS });
}

/**
 * Called by a code editor as it mounts. Takes a request waiting for it, and
 * answers later ones until the returned function is called.
 */
export function registerCodeBlock(
  id: string,
  host: unknown,
  focus: (at: CodeCaret) => void,
): () => void {
  const entry: Host = { host, focus };
  let hosts = mounted.get(id);
  if (!hosts) mounted.set(id, (hosts = new Set()));
  hosts.add(entry);

  const waiting = pending.get(id);
  if (waiting && waiting.scope.contains(host)) {
    pending.delete(id);
    if (waiting.until >= Date.now()) focus(waiting.at);
  }

  return () => {
    hosts.delete(entry);
    if (!hosts.size && mounted.get(id) === hosts) mounted.delete(id);
  };
}
