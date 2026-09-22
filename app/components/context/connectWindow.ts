/**
 * Opens a provider's consent screen in a window of its own, centred on this
 * one. A popup rather than a redirect because the doors to context sit inside
 * forms — the new-project dialog above all — where leaving the page loses
 * everything typed. The window lands on `/connected`, which closes itself; the
 * account status is a live query, so whatever opened it simply updates.
 */
export function openConnectWindow(path: string) {
  const w = 640;
  const h = 760;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  window.open(
    `${path}?returnTo=/connected`,
    "nootles-connect",
    `popup,width=${w},height=${h},left=${left},top=${top}`,
  );
}
