/**
 * A keystroke that means "I am writing", as opposed to navigating — the test
 * every guest surface applies before answering with the sign-in modal. Tab,
 * arrows and shortcuts pass through; a character, Enter or a deletion is a
 * reach for the pen.
 */
export function writingKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  return (
    e.key.length === 1 ||
    e.key === "Enter" ||
    e.key === "Backspace" ||
    e.key === "Delete"
  );
}

/**
 * The other intent a press can have: following. A mention chip or a link
 * inside the document navigates for a guest exactly as it would for an owner —
 * intercepting it would answer a navigation with the sign-in modal while the
 * navigation happened anyway underneath.
 */
export function following(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('a, button, [role="link"], [role="button"]') !== null
  );
}
