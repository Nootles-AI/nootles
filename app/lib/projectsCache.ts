"use client";

import type { Project, SharedProject } from "@/app/components/projectParts";
import { impersonationToken } from "./impersonation";

/**
 * The projects screen as this browser last saw it, so a return visit draws at
 * once instead of after Clerk's token, Convex's handshake and two round trips —
 * measured at about half of the time to the first card.
 *
 * Stale by design and never trusted: the live answer replaces it the moment it
 * arrives, and nothing here is ever written back to the server. It only decides
 * what is on screen for the few hundred milliseconds before that.
 *
 * One account at a time, under that account's id. A cache belonging to anyone
 * else is dropped unread, so two people sharing a browser never see each
 * other's projects. An operator standing in neither reads nor writes it: the
 * Clerk id is theirs while the projects are somebody else's.
 */

const KEY = "nt:projectsScreen";
const VERSION = 1;

/** Past these a preview is left to the live read rather than kept here. */
const MAX_PREVIEWS = 60;
const MAX_PREVIEW_CHARS = 24_000;
const MAX_TOTAL_CHARS = 1_000_000;

export type Preview = { blocks: string; seq: number };

type Stored = {
  v: number;
  user: string;
  projects: Project[];
  shared: SharedProject[];
  previews: Record<string, Preview>;
};

/**
 * Only what the screen draws. The live rows are whole project documents, share
 * tokens included, and those have no business outliving the tab.
 */
const mine = (p: Project) =>
  ({
    _id: p._id,
    title: p.title,
    description: p.description,
    pageCount: p.pageCount,
    firstPageDocId: p.firstPageDocId,
    updatedAt: p.updatedAt,
  }) as Project;

let user: string | null = null;
let screen: { projects: Project[]; shared: SharedProject[] } | null = null;
const previews = new Map<string, Preview>();

function adopt(id: string) {
  if (user === id) return;
  user = id;
  screen = null;
  previews.clear();
  if (impersonationToken()) return;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const stored = JSON.parse(raw) as Stored;
    if (stored.v !== VERSION || stored.user !== id) {
      localStorage.removeItem(KEY);
      return;
    }
    screen = { projects: stored.projects, shared: stored.shared };
    for (const [docId, preview] of Object.entries(stored.previews)) previews.set(docId, preview);
  } catch {
    // Unreadable or refused: the screen loads the way it always did.
  }
}

/** What this account's screen last held, or null on a first visit. */
export function seenScreen(id: string) {
  adopt(id);
  return screen;
}

/**
 * The last preview drawn for a page. Asked by `docId` alone because a `docId`
 * only reaches a card through a project list that was this account's.
 */
export const seenPreview = (docId: string) => previews.get(docId);

export function rememberScreen(id: string, projects: Project[], shared: SharedProject[]) {
  if (impersonationToken()) return;
  adopt(id);
  screen = { projects: projects.map(mine), shared };
  persistSoon();
}

export function rememberPreview(docId: string, preview: Preview | null) {
  const held = previews.get(docId);
  if (preview === null ? !held : held?.seq === preview.seq && held.blocks === preview.blocks) return;
  if (preview) previews.set(docId, preview);
  else previews.delete(docId);
  persistSoon();
}

let timer: ReturnType<typeof setTimeout> | undefined;

function forgetScreen() {
  user = null;
  screen = null;
  previews.clear();
  clearTimeout(timer);
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to remove from a store that cannot be reached.
  }
}

let watching = false;

/**
 * Signed out: nothing of the account stays behind. Listened for on Clerk
 * itself, once and for the life of the tab, rather than from a component —
 * signing out navigates away, and whatever was mounted is gone before it could
 * hear about it. `null` is signed out; `undefined` is Clerk still loading.
 */
export function forgetOnSignOut(clerk: {
  addListener: (listener: (now: { user?: unknown }) => void) => unknown;
}) {
  if (watching) return;
  watching = true;
  clerk.addListener(({ user: signedIn }) => {
    if (signedIn === null) forgetScreen();
  });
}

// One write for a screenful of previews arriving together, off the path of the
// render that brought them.
function persistSoon() {
  clearTimeout(timer);
  timer = setTimeout(persist, 1000);
}

function persist() {
  if (!user || !screen || impersonationToken()) return;
  try {
    if (!screen.projects.length && !screen.shared.length) {
      localStorage.removeItem(KEY);
      return;
    }
    // Kept in the order the screen shows them, so what falls off the end of
    // the budget is what is furthest down the page.
    const kept: Record<string, Preview> = {};
    let total = 0;
    for (const { firstPageDocId } of [...screen.projects, ...screen.shared].slice(0, MAX_PREVIEWS)) {
      const preview = firstPageDocId ? previews.get(firstPageDocId) : undefined;
      if (!firstPageDocId || !preview || preview.blocks.length > MAX_PREVIEW_CHARS) continue;
      if (total + preview.blocks.length > MAX_TOTAL_CHARS) break;
      total += preview.blocks.length;
      kept[firstPageDocId] = preview;
    }
    const stored: Stored = { v: VERSION, user, ...screen, previews: kept };
    localStorage.setItem(KEY, JSON.stringify(stored));
  } catch {
    // Over quota or refused. The cache is a convenience; losing it costs a
    // slower next visit and nothing else.
  }
}
