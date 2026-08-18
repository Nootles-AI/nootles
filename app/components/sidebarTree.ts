import type { Doc, Id } from "@/convex/_generated/dataModel";

/**
 * The sidebar's folder tree, flattened to the rows that are actually on screen.
 *
 * Pure and its own module because it is the one piece of this feature with
 * real invariants — every folder appears exactly once, at its own depth, or
 * the list starts telling lies about where things live.
 *
 * Structure is resolved BEFORE visibility, and the two never mix. Where a
 * folder lives is decided by its parent link alone; whether it is on screen is
 * decided afterwards, by the walk simply not descending into a closed folder.
 * Collapsing a folder therefore cannot move anything — it can only stop rows
 * being emitted.
 */

/** A row's identity, the way selection, the clipboard and the menus hold it. */
export type Target =
  | { kind: "page"; id: Id<"pages"> }
  | { kind: "folder"; id: Id<"folders"> };

export type TreeRowData =
  | {
      kind: "folder";
      folder: Doc<"folders">;
      parentId: Id<"folders"> | null;
      depth: number;
      expanded: boolean;
    }
  | {
      kind: "page";
      page: Doc<"pages">;
      parentId: Id<"folders"> | null;
      depth: number;
    };

/** One level's row before sorting: either kind, on the level's one order line. */
type LevelEntry =
  | { kind: "folder"; folder: Doc<"folders"> }
  | { kind: "page"; page: Doc<"pages"> };

const orderOf = (e: LevelEntry): number =>
  e.kind === "folder" ? e.folder.order : e.page.order;

/**
 * Where each folder actually hangs, which is not always what its row says: a
 * parent that no longer exists, or an ancestor chain that loops back on itself
 * (two concurrent moves can leave one), resolves to the top level. A broken
 * link costs a folder its place, never its existence — a folder that vanished
 * would take its pages with it.
 */
function homes(
  folders: readonly Doc<"folders">[],
): Map<Id<"folders">, Id<"folders"> | null> {
  const byId = new Map(folders.map((f) => [f._id, f]));

  // Memoized "does following parents from here reach the top level?". The
  // provisional `false` is what a cycle meets when it comes back around, so
  // every folder on the loop answers false instead of recurring forever.
  const rooted = new Map<Id<"folders">, boolean>();
  const isRooted = (folder: Doc<"folders">): boolean => {
    const known = rooted.get(folder._id);
    if (known !== undefined) return known;
    rooted.set(folder._id, false);
    const parent = folder.parentId ? byId.get(folder.parentId) : undefined;
    const answer = parent ? isRooted(parent) : true;
    rooted.set(folder._id, answer);
    return answer;
  };

  return new Map(
    folders.map((f) => [
      f._id,
      isRooted(f) && f.parentId && byId.has(f.parentId) ? f.parentId : null,
    ]),
  );
}

/**
 * The visible rows in render order: each level's folders and pages together on
 * the level's one order line, depth-first through the folders that are open.
 * The sort is stable over folders-then-pages, so an order tie — two clients
 * appending at once — resolves folders first rather than flickering.
 *
 * `collapsed` holds folder ids the user has closed; anything absent is open,
 * so a folder that arrives while you are looking at it arrives open.
 */
export function flattenTree(
  folders: readonly Doc<"folders">[],
  pages: readonly Doc<"pages">[],
  collapsed: ReadonlySet<string>,
): TreeRowData[] {
  const parentOf = homes(folders);
  const known = new Set<string>(folders.map((f) => f._id));

  const levels = new Map<Id<"folders"> | null, LevelEntry[]>();
  const put = (home: Id<"folders"> | null, entry: LevelEntry) => {
    const level = levels.get(home);
    if (level) level.push(entry);
    else levels.set(home, [entry]);
  };
  for (const folder of folders) {
    put(parentOf.get(folder._id) ?? null, { kind: "folder", folder });
  }
  for (const page of pages) {
    // A page whose folder is gone comes home to the top level, same as a
    // folder whose parent is gone.
    put(page.folderId && known.has(page.folderId) ? page.folderId : null, {
      kind: "page",
      page,
    });
  }
  for (const level of levels.values()) {
    level.sort((a, b) => orderOf(a) - orderOf(b));
  }

  const out: TreeRowData[] = [];
  const walk = (parentId: Id<"folders"> | null, depth: number) => {
    for (const entry of levels.get(parentId) ?? []) {
      if (entry.kind === "folder") {
        const expanded = !collapsed.has(entry.folder._id);
        out.push({ kind: "folder", folder: entry.folder, parentId, depth, expanded });
        if (expanded) walk(entry.folder._id, depth + 1);
      } else {
        out.push({ kind: "page", page: entry.page, parentId, depth });
      }
    }
  };
  walk(null, 0);
  return out;
}

/** True when `candidate` is `root` or sits somewhere beneath it. */
export function isInside(
  folders: readonly Doc<"folders">[],
  candidate: Id<"folders">,
  root: Id<"folders">,
): boolean {
  const byId = new Map(folders.map((f) => [f._id, f]));
  const seen = new Set<string>();
  for (
    let node = byId.get(candidate);
    node && !seen.has(node._id);
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    if (node._id === root) return true;
    seen.add(node._id);
  }
  return false;
}

/** What a row is, as selection and the clipboard hold it. */
export function targetOf(row: TreeRowData): Target {
  return row.kind === "folder"
    ? { kind: "folder", id: row.folder._id }
    : { kind: "page", id: row.page._id };
}

export const rowId = (row: TreeRowData): string =>
  row.kind === "folder" ? row.folder._id : row.page._id;

/**
 * Every visible row between two, inclusive — what shift-click extends over.
 *
 * Over the rows ON SCREEN rather than the tree, because that is the range the
 * user drew: a closed folder's contents are not in it, however far down the
 * screen the range appears to reach.
 */
export function rangeBetween(
  rows: readonly TreeRowData[],
  from: string,
  to: string,
): Target[] {
  const a = rows.findIndex((r) => rowId(r) === from);
  const b = rows.findIndex((r) => rowId(r) === to);
  if (a < 0 || b < 0) return [];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return rows.slice(lo, hi + 1).map(targetOf);
}

/**
 * The selection, restricted to what is on screen and put in the order the rows
 * are drawn — so every action applies top-down, and a row that went away with
 * its folder stops being acted on the moment it stops being visible.
 */
export function visibleSelection(
  rows: readonly TreeRowData[],
  selection: readonly Target[],
): Target[] {
  const chosen = new Set<string>(selection.map((t) => t.id));
  return rows.filter((r) => chosen.has(rowId(r))).map(targetOf);
}

/**
 * The selection with anything a selected folder already carries removed.
 *
 * Selecting a folder selects its contents implicitly — it moves, copies and
 * deletes as one thing — so acting on both would move a page twice, or delete
 * one whose folder took it a moment before. Only the topmost of each branch
 * acts; the rest travel inside it.
 *
 * Ancestry is read off the rows because a visible row's ancestors are always
 * visible too: the walk only descends through folders that are open.
 */
export function topmost(
  rows: readonly TreeRowData[],
  selection: readonly Target[],
): Target[] {
  const parentOf = new Map<string, string | null>(
    rows.map((r) => [rowId(r), r.parentId as string | null]),
  );
  const chosen = new Set(
    selection.filter((t) => t.kind === "folder").map((t) => t.id as string),
  );
  const heldByAnother = (id: string): boolean => {
    const seen = new Set<string>();
    for (
      let parent = parentOf.get(id) ?? null;
      parent && !seen.has(parent);
      parent = parentOf.get(parent) ?? null
    ) {
      if (chosen.has(parent)) return true;
      seen.add(parent);
    }
    return false;
  };
  return selection.filter((t) => !heldByAnother(t.id as string));
}
