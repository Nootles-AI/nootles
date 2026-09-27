let applePlatform: boolean | null = null;

/**
 * Whether `Mod` means ⌘. Resolved once, lazily — reading `navigator` at module
 * scope would run on the server.
 */
export function isApplePlatform(): boolean {
  applePlatform ??=
    typeof navigator !== "undefined" &&
    /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
  return applePlatform;
}

/**
 * Whether this pointer or key event carries the platform's command modifier:
 * ⌘ on Apple, Ctrl elsewhere. On a Mac, Ctrl+click is the OS's right-click
 * and must never read as deep select.
 */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isApplePlatform() ? e.metaKey : e.ctrlKey;
}
