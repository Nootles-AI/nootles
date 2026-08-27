import { useSyncExternalStore } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { Target } from "./sidebarTree";

/**
 * The sidebar clipboard, shared across every tab of this browser.
 *
 * Each browser tab is one project (`/p/[projectId]`), so ⌘C in one tab and ⌘V
 * in another is how rows cross projects — a clipboard held in one tab's state
 * could never reach the project it is pasted into. localStorage is the
 * transport: a write lands in every other tab as its `storage` event, and a
 * tab opened after the copy still finds it waiting. The payload is row
 * identities, not rows — what a paste does with them is decided where it
 * lands, against that tab's own tree.
 *
 * Deliberately not the system clipboard, for the same reason the sidebar
 * handles ⌘C on keydown: the payload is rows, not text, and holding it must
 * not shadow whatever the user has genuinely copied as text.
 */

export type Clip = {
  items: readonly Target[];
  op: "copy" | "cut";
  /** The project the rows came from — a paste anywhere else is a crossing. */
  projectId: Id<"projects">;
};

const KEY = "nt-clip";

/* The tab's own copy is the truth and storage the mirror, so private mode —
   where every localStorage call throws — still has a working clipboard; other
   tabs just never hear about it. */
let cached: Clip | null = null;
let cachedRaw: string | null = null;

/** A stranger's write read back with suspicion: anything malformed is no clip. */
function parse(raw: string | null): Clip | null {
  if (!raw) return null;
  try {
    const held = JSON.parse(raw) as Clip;
    if (held.op !== "copy" && held.op !== "cut") return null;
    if (typeof held.projectId !== "string") return null;
    const items = Array.isArray(held.items)
      ? held.items.filter(
          (t) =>
            (t?.kind === "page" || t?.kind === "folder") &&
            typeof t.id === "string",
        )
      : [];
    return items.length ? { items, op: held.op, projectId: held.projectId } : null;
  } catch {
    return null;
  }
}

function snapshot(): Clip | null {
  let raw = cachedRaw;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    // Unreadable storage: this tab's own copy is all there is.
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parse(raw);
  }
  return cached;
}

const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  // `storage` fires only in the OTHER tabs; the loop in `writeClip` is for
  // this one's subscribers.
  const heard = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) onChange();
  };
  listeners.add(onChange);
  window.addEventListener("storage", heard);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", heard);
  };
}

export function writeClip(next: Clip | null) {
  cached = next;
  cachedRaw = next ? JSON.stringify(next) : null;
  try {
    if (cachedRaw === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, cachedRaw);
  } catch {
    // Private mode: kept here, invisible elsewhere.
  }
  for (const listener of listeners) listener();
}

/** The clipboard and its one write — `useState`'s shape, minus the one tab. */
export function useSharedClip(): [Clip | null, typeof writeClip] {
  const clip = useSyncExternalStore(subscribe, snapshot, () => null);
  return [clip, writeClip];
}
