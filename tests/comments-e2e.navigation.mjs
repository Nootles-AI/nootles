/**
 * Next's App Router, reduced to what the app asks of it: the address is the
 * state, and every history write — the router's, or the app's own
 * `replaceState` — tells each reader, as Next's history integration does.
 */
export const NAVIGATION = `
  import { useMemo, useSyncExternalStore } from "react";
  const listeners = new Set();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method].bind(history);
    history[method] = (...args) => { original(...args); queueMicrotask(notify); };
  }
  window.addEventListener("popstate", notify);
  const subscribe = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
  const go = (href, replace) => {
    (window.__navigations ??= []).push({ href, replace });
    history[replace ? "replaceState" : "pushState"](null, "", href);
  };
  const router = { push: (href) => go(href, false), replace: (href) => go(href, true), prefetch() {}, back: () => history.back(), forward: () => history.forward(), refresh() {} };
  export function useRouter() { return router; }
  export function usePathname() { return useSyncExternalStore(subscribe, () => location.pathname); }
  export function useSearchParams() {
    const search = useSyncExternalStore(subscribe, () => location.search);
    return useMemo(() => new URLSearchParams(search), [search]);
  }
  export function useParams() { return {}; }
  export function redirect(href) { go(href, true); }
  export function notFound() { throw new Error("notFound"); }
`;
