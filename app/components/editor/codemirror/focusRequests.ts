/**
 * The way into a code block's editor from outside it.
 *
 * The caret of a code block lives in CodeMirror, which ProseMirror cannot put
 * a selection into, and which may not exist yet: a block that has just become
 * code mounts its node view after the transaction that made it, and the
 * editor class itself is fetched on first use (see `CodeSurface`). So a
 * request is delivered to the block's editor if it is mounted, and otherwise
 * held until it mounts — along with whatever was typed in the meantime, which
 * would otherwise land in the page around the block (see `holdKey`).
 *
 * A held request lapses once nobody types into it for a while, or at once
 * when the person does something else, so it cannot steal the caret from
 * someone who has moved on.
 *
 * Requests carry the element of the page they came from, because the same
 * block can be on screen twice (two panes on one page) and only the editor
 * inside the asking page should answer.
 */

export type CodeCaret = "start" | "end";

/** An element that can say whether another is inside it — the page's root. */
export type FocusScope = { contains(other: unknown): boolean };

type Focus = (at: CodeCaret, typed: string) => void;
type Host = { host: unknown; focus: Focus };
type Pending = { scope: FocusScope; at: CodeCaret; typed: string; until: number };

/** Long enough for a first visit to fetch the editor on a slow connection. */
const HOLD_MS = 5000;

const mounted = new Map<string, Set<Host>>();
const pending = new Map<string, Pending>();

/** Put the caret into block `id`'s code editor, within `scope`. */
export function focusCodeBlock(scope: FocusScope, id: string, at: CodeCaret): void {
  for (const entry of mounted.get(id) ?? []) {
    if (scope.contains(entry.host)) {
      pending.delete(id);
      entry.focus(at, "");
      return;
    }
  }
  pending.set(id, { scope, at, typed: "", until: Date.now() + HOLD_MS });
}

/** The live request `scope` made, if one is still waiting. */
function waitingIn(scope: FocusScope): Pending | null {
  const now = Date.now();
  for (const [id, request] of pending) {
    if (request.until < now) pending.delete(id);
    else if (request.scope === scope) return request;
  }
  return null;
}

/** Drop what `scope` is waiting for: the person has gone somewhere else. */
export function cancelWaiting(scope: FocusScope): void {
  for (const [id, request] of pending) {
    if (request.scope === scope) pending.delete(id);
  }
}

/** A key, as far as `holdKey` needs to read one. */
export type HeldKey = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "isComposing">;

/**
 * A key pressed in the page while `scope` waits for a code block: text is
 * kept for the block, and true says the page should not see the key. Any
 * other key is the person moving on, and ends the wait.
 */
export function holdKey(scope: FocusScope, event: HeldKey): boolean {
  const request = waitingIn(scope);
  if (!request) return false;
  const { key } = event;
  if (key === "Shift" || key === "Alt" || key === "Meta" || key === "Control") {
    return false;
  }
  const plain = !event.metaKey && !event.ctrlKey && !event.isComposing;
  if (plain && (key.length === 1 || key === "Enter" || key === "Backspace")) {
    request.typed =
      key === "Backspace"
        ? request.typed.slice(0, -1)
        : request.typed + (key === "Enter" ? "\n" : key);
    request.until = Date.now() + HOLD_MS;
    return true;
  }
  cancelWaiting(scope);
  return false;
}

/**
 * Called by a code editor as it mounts. Takes a request waiting for it, and
 * answers later ones until the returned function is called. `focus` is handed
 * what was typed while the request waited, to put in at the caret.
 */
export function registerCodeBlock(id: string, host: unknown, focus: Focus): () => void {
  const entry: Host = { host, focus };
  let hosts = mounted.get(id);
  if (!hosts) mounted.set(id, (hosts = new Set()));
  hosts.add(entry);

  const waiting = pending.get(id);
  if (waiting && waiting.scope.contains(host)) {
    pending.delete(id);
    if (waiting.until >= Date.now()) focus(waiting.at, waiting.typed);
  }

  return () => {
    hosts.delete(entry);
    if (!hosts.size && mounted.get(id) === hosts) mounted.delete(id);
  };
}
