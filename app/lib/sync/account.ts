/**
 * Says when the account this tab speaks for changes — signed out, or another
 * signed in. Its own module, so the root provider can say it without pulling
 * the sync layer into every route's bundle; whatever holds data read as the
 * last account listens.
 */

const listeners = new Set<() => void>();

export function onAccountChange(listener: () => void) {
  listeners.add(listener);
}

export function accountChanged() {
  for (const listener of listeners) listener();
}
