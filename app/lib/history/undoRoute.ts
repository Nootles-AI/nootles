/**
 * Where ⌘Z goes — decided once, from where the keyboard focus sits, so the
 * workspace spine and the comments history can never both answer one press.
 *
 * - **Comments** — focus inside an element marked `data-nt-comments="<pageId>"`
 *   (a thread card, the panel, a composer's frame). The press undoes that
 *   page's newest comment action and nothing else: the comments document has
 *   its own history (docs/commenting-plan.md §6), which the spine never walks,
 *   so ⌘Z in the document cannot reach a comment and ⌘Z on a comment cannot
 *   reach the document.
 * - **Native** — focus in a text field (an input, a textarea, a
 *   contenteditable, a maths field) that no spine-tracked surface owns, and
 *   every text field inside a comment surface. The browser's own text undo
 *   takes back what was typed there: a half-written reply is a draft, and
 *   ⌘Z inside it means "my last keystrokes", never "my last comment".
 * - **Spine** — everywhere else: the document, a diagram, the panels, the
 *   title, and a focus that has fallen to the page's body.
 *
 * A comment surface therefore makes whatever holds focus when it is not
 * typing — its card or panel root — focusable (`tabIndex={-1}`), so a click on
 * it puts focus there and a following ⌘Z undoes the comment action it just
 * took.
 */

/** Marks a subtree whose text entries are on the spine (see `useWorkspaceHistory`). */
export const UNDO_SCOPE_ATTR = "data-nt-undo";

/** Marks a comment surface; its value is the page whose comments it shows. */
export const COMMENTS_SCOPE_ATTR = "data-nt-comments";

/** Spread onto the root of a comment surface for `pageId`. */
export function commentsScope(pageId: string): { [COMMENTS_SCOPE_ATTR]: string } {
  return { [COMMENTS_SCOPE_ATTR]: pageId };
}

export type UndoKey = "undo" | "redo";

/** ⌘Z / Ctrl+Z undoes; ⌘⇧Z, Ctrl+⇧Z and Ctrl+Y redo. ⌥ opts out. */
export function undoKeyOf(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "key">): UndoKey | null {
  if (!event.metaKey && !event.ctrlKey) return null;
  if (event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y") return "redo";
  return null;
}

/** The slice of an element routing reads, so the rule is testable without a DOM. */
export type FocusTarget = {
  readonly tagName: string;
  readonly isContentEditable: boolean;
  closest(selector: string): { getAttribute(name: string): string | null } | null;
};

export type UndoRoute =
  | { to: "native" }
  | { to: "spine" }
  | { to: "comments"; pageId: string };

export function isTextEntry(el: FocusTarget): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "MATH-FIELD";
}

export function undoRoute(active: FocusTarget | null): UndoRoute {
  if (!active) return { to: "spine" };
  const typing = isTextEntry(active);
  const surface = active.closest(`[${COMMENTS_SCOPE_ATTR}]`);
  if (surface) {
    const pageId = surface.getAttribute(COMMENTS_SCOPE_ATTR);
    return typing || !pageId ? { to: "native" } : { to: "comments", pageId };
  }
  if (typing && !active.closest(`[${UNDO_SCOPE_ATTR}]`)) return { to: "native" };
  return { to: "spine" };
}

/** The route for the element that has focus right now. */
export function currentUndoRoute(): UndoRoute {
  const active = document.activeElement;
  return undoRoute(active instanceof HTMLElement ? active : null);
}
