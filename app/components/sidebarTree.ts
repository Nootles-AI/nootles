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

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

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
 * The visible rows in render order: each level's folders above its pages, both
 * by their own `order`, depth-first through the folders that are open.
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

  const subfolders = new Map<Id<"folders"> | null, Doc<"folders">[]>();
  for (const folder of folders) {
    const home = parentOf.get(folder._id) ?? null;
    const level = subfolders.get(home);
    if (level) level.push(folder);
    else subfolders.set(home, [folder]);
  }
  for (const level of subfolders.values()) level.sort(byOrder);

  const known = new Set<string>(folders.map((f) => f._id));
  const inLevel = new Map<Id<"folders"> | null, Doc<"pages">[]>();
  for (const page of pages) {
    // A page whose folder is gone comes home to the top level, same as a
    // folder whose parent is gone.
    const home =
      page.folderId && known.has(page.folderId) ? page.folderId : null;
    const level = inLevel.get(home);
    if (level) level.push(page);
    else inLevel.set(home, [page]);
  }
  for (const level of inLevel.values()) level.sort(byOrder);

  const out: TreeRowData[] = [];
  const walk = (parentId: Id<"folders"> | null, depth: number) => {
    for (const folder of subfolders.get(parentId) ?? []) {
      const expanded = !collapsed.has(folder._id);
      out.push({ kind: "folder", folder, parentId, depth, expanded });
      if (expanded) walk(folder._id, depth + 1);
    }
    for (const page of inLevel.get(parentId) ?? []) {
      out.push({ kind: "page", page, parentId, depth });
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
