import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { Correspondence } from "../app/components/share/AccessRequests";
import { useLinkedPage } from "../app/components/comments/useLinkedPage";
import type { InboxNotice } from "../app/lib/comments/link";

/**
 * The comment inbox as the recipient meets it: the real `Correspondence`
 * corner (access requests and comment notices in one stack) and the real
 * `useLinkedPage`, over a memory stand-in for the three Convex functions they
 * read and the one they write. The router is Next's own context carrying a
 * stand-in that moves the address bar the way the app router does, so a
 * followed notice goes through the same `?page=` the workspace consumes.
 */

type Row = InboxNotice & { seenAt?: number };
type Call = { kind: "watch" | "mutation"; name: string; args: Record<string, unknown> };

function memoryConvex() {
  const rows: Row[] = [];
  const requests: Record<string, unknown>[] = [];
  const watchers = new Map<string, Set<() => void>>();
  const calls: Call[] = [];
  const notify = (name: string) => {
    for (const watcher of watchers.get(name) ?? []) watcher();
  };
  const read = (name: string) => {
    switch (name) {
      case "commentNotices:inbox":
        return rows
          .filter((row) => row.seenAt === undefined)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(({ seenAt: _seen, ...notice }) => notice);
      case "share:incomingRequests":
        return requests;
      case "share:grantedForMe":
        return [];
      default:
        throw new Error(`memory convex has no query ${name}`);
    }
  };
  // One answer object per watched function, so React sees a stable result
  // between changes the way the real client's cache hands one back.
  const cache = new Map<string, unknown>();
  const result = (name: string) => {
    if (!cache.has(name)) cache.set(name, read(name));
    return cache.get(name);
  };
  const changed = (name: string) => {
    cache.delete(name);
    notify(name);
  };
  const client = {
    watchQuery: (reference: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(reference as never);
      calls.push({ kind: "watch", name, args });
      return {
        onUpdate: (callback: () => void) => {
          const set = watchers.get(name) ?? new Set();
          set.add(callback);
          watchers.set(name, set);
          return () => set.delete(callback);
        },
        localQueryResult: () => result(name),
        journal: () => undefined,
      };
    },
    mutation: async (reference: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(reference as never);
      calls.push({ kind: "mutation", name, args });
      if (name === "commentNotices:markSeen") {
        const ids = new Set(args.ids as string[]);
        for (const row of rows) if (ids.has(row.noticeId)) row.seenAt ??= Date.now();
        // After a beat, as a round trip would: the card must not wait for it.
        setTimeout(() => changed("commentNotices:inbox"), 150);
        return null;
      }
      throw new Error(`memory convex has no mutation ${name}`);
    },
  } as unknown as ConvexReactClient;
  return {
    client,
    calls,
    rows,
    deliver(notice: InboxNotice) {
      rows.push({ ...notice });
      changed("commentNotices:inbox");
    },
    ask(request: Record<string, unknown>) {
      requests.push(request);
      changed("share:incomingRequests");
    },
  };
}

const convex = memoryConvex();
const pushes: string[] = [];
const opened: string[] = [];

/** Keeps the harness's search params in step with the address bar, as the app router does. */
const locationListeners = new Set<() => void>();
const syncSearch = () => {
  for (const listener of locationListeners) listener();
};
const subscribeLocation = (listener: () => void) => {
  locationListeners.add(listener);
  return () => {
    locationListeners.delete(listener);
  };
};
const replaceState = window.history.replaceState.bind(window.history);
window.history.replaceState = (...args: Parameters<History["replaceState"]>) => {
  replaceState(...args);
  syncSearch();
};

const router: AppRouterInstance = {
  back: () => window.history.back(),
  forward: () => window.history.forward(),
  refresh: () => {},
  push: (href) => {
    pushes.push(href);
    window.history.pushState(null, "", href);
    syncSearch();
  },
  replace: (href) => {
    window.history.replaceState(null, "", href);
  },
  prefetch: () => {},
};

/** What `Workspace` does with a link, and the corner it mounts. */
function Surface({ projectId }: { projectId: string }) {
  const [page, setPage] = useState<string | null>(null);
  useLinkedPage((pageId) => {
    opened.push(pageId);
    setPage(pageId);
  });
  return (
    <main>
      <p>
        Open page: <output id="opened">{page ?? "none"}</output>
      </p>
      <Correspondence projectId={projectId as never} />
    </main>
  );
}

function App() {
  const search = useSyncExternalStore(subscribeLocation, () => window.location.search);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  return (
    <AppRouterContext.Provider value={router}>
      <SearchParamsContext.Provider value={params}>
        <ConvexProvider client={convex.client}>
          <Surface projectId="proj_a" />
        </ConvexProvider>
      </SearchParamsContext.Provider>
    </AppRouterContext.Provider>
  );
}

declare global {
  interface Window {
    ntInbox: {
      mount(): void;
      deliver(notice: InboxNotice): void;
      ask(request: Record<string, unknown>): void;
      calls(): Call[];
      pushes(): string[];
      opened(): string[];
      unseen(): string[];
    };
  }
}

window.ntInbox = {
  mount: () => createRoot(document.getElementById("root")!).render(<App />),
  deliver: (notice) => convex.deliver(notice),
  ask: (request) => convex.ask(request),
  calls: () => convex.calls,
  pushes: () => pushes,
  opened: () => opened,
  unseen: () => convex.rows.filter((row) => row.seenAt === undefined).map((row) => row.noticeId),
};
