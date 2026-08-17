import { describe, expect, test } from "vitest";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  flattenTree,
  isInside,
  rangeBetween,
  topmost,
  visibleSelection,
} from "./sidebarTree";

/**
 * The tree's invariants, which the sidebar cannot be trusted to show without
 * them: every folder appears exactly once, at its own depth, and closing one
 * only ever removes rows — it never moves another.
 */

const folder = (
  id: string,
  order: number,
  parentId?: string,
): Doc<"folders"> =>
  ({
    _id: id as Id<"folders">,
    _creationTime: order,
    ownerId: "u",
    projectId: "p" as Id<"projects">,
    title: id,
    parentId: parentId as Id<"folders"> | undefined,
    order,
    createdAt: order,
  }) as Doc<"folders">;

const page = (id: string, order: number, folderId?: string): Doc<"pages"> =>
  ({
    _id: id as Id<"pages">,
    _creationTime: order,
    ownerId: "u",
    projectId: "p" as Id<"projects">,
    title: id,
    folderId: folderId as Id<"folders"> | undefined,
    order,
    docId: id,
    createdAt: order,
  }) as Doc<"pages">;

const shown = (rows: ReturnType<typeof flattenTree>) =>
  rows.map((r) => [
    r.kind === "folder" ? r.folder._id : r.page._id,
    r.depth,
  ]);

const none: ReadonlySet<string> = new Set();

/** Test ids are plain strings; the branding is the database's business. */
const pageAt = (id: string) => ({ kind: "page" as const, id: id as Id<"pages"> });
const folderAt = (id: string) => ({
  kind: "folder" as const,
  id: id as Id<"folders">,
});

describe("flattenTree", () => {
  test("nests folders and their pages depth-first", () => {
    const rows = flattenTree(
      [folder("A", 0), folder("B", 0, "A")],
      [page("P", 0, "B"), page("loose", 0)],
      none,
    );
    expect(shown(rows)).toEqual([
      ["A", 0],
      ["B", 1],
      ["P", 2],
      ["loose", 0],
    ]);
  });

  test("closing a folder hides its whole subtree and moves nothing", () => {
    // The reported bug: a page inside a folder inside a folder. Closing the
    // outer one used to re-home the inner folder to the bottom at depth 0.
    const folders = [folder("A", 0), folder("B", 0, "A")];
    const pages = [page("P", 0, "B"), page("loose", 1)];
    const open = flattenTree(folders, pages, none);
    const closed = flattenTree(folders, pages, new Set(["A"]));

    expect(shown(closed)).toEqual([
      ["A", 0],
      ["loose", 0],
    ]);
    // Everything still shown kept the exact place it had while open.
    const before = new Map(shown(open).map(([id, depth]) => [id, depth]));
    for (const [id, depth] of shown(closed)) {
      expect(depth).toBe(before.get(id));
    }
  });

  test("closing an inner folder leaves the outer one alone", () => {
    const rows = flattenTree(
      [folder("A", 0), folder("B", 0, "A")],
      [page("P", 0, "B")],
      new Set(["B"]),
    );
    expect(shown(rows)).toEqual([
      ["A", 0],
      ["B", 1],
    ]);
  });

  test("folders sort above pages at every level, each by its own order", () => {
    const rows = flattenTree(
      [folder("late", 9), folder("early", 1)],
      [page("p2", 2), page("p1", 1)],
      none,
    );
    expect(shown(rows)).toEqual([
      ["early", 0],
      ["late", 0],
      ["p1", 0],
      ["p2", 0],
    ]);
  });

  test("every folder appears exactly once, however deep", () => {
    const folders = [
      folder("A", 0),
      folder("B", 0, "A"),
      folder("C", 0, "B"),
      folder("D", 1, "A"),
    ];
    for (const collapsed of [
      none,
      new Set(["A"]),
      new Set(["B"]),
      new Set(["A", "C"]),
    ]) {
      const ids = flattenTree(folders, [], collapsed).map((r) =>
        r.kind === "folder" ? r.folder._id : r.page._id,
      );
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("a folder whose parent is gone comes home rather than vanishing", () => {
    const rows = flattenTree(
      [folder("orphan", 0, "deleted")],
      [page("stray", 0, "deleted")],
      none,
    );
    expect(shown(rows)).toEqual([
      ["orphan", 0],
      ["stray", 0],
    ]);
  });

  test("a parent cycle surfaces both folders instead of hanging", () => {
    // Two concurrent moves can leave A under B and B under A.
    const rows = flattenTree(
      [folder("A", 0, "B"), folder("B", 1, "A")],
      [page("P", 0, "A")],
      none,
    );
    expect(shown(rows)).toEqual([
      ["A", 0],
      ["P", 1],
      ["B", 0],
    ]);
  });

  test("a folder hanging off a cycle still surfaces", () => {
    const rows = flattenTree(
      [folder("A", 0, "B"), folder("B", 1, "A"), folder("under", 2, "A")],
      [],
      none,
    );
    const ids = rows.map((r) => (r.kind === "folder" ? r.folder._id : ""));
    expect(new Set(ids)).toEqual(new Set(["A", "B", "under"]));
    expect(ids.length).toBe(3);
  });

  test("empty project renders nothing", () => {
    expect(flattenTree([], [], none)).toEqual([]);
  });
});

describe("isInside", () => {
  const folders = [folder("A", 0), folder("B", 0, "A"), folder("C", 0, "B")];
  const id = (s: string) => s as Id<"folders">;

  test("a folder is inside itself and its ancestors", () => {
    expect(isInside(folders, id("A"), id("A"))).toBe(true);
    expect(isInside(folders, id("C"), id("A"))).toBe(true);
    expect(isInside(folders, id("B"), id("A"))).toBe(true);
  });

  test("an ancestor is not inside its descendant", () => {
    expect(isInside(folders, id("A"), id("C"))).toBe(false);
  });

  test("a cycle answers rather than hanging", () => {
    const looped = [folder("X", 0, "Y"), folder("Y", 0, "X")];
    expect(isInside(looped, id("X"), id("Y"))).toBe(true);
    expect(isInside(looped, id("X"), id("Z"))).toBe(false);
  });
});

describe("rangeBetween", () => {
  const rows = flattenTree(
    [folder("A", 0), folder("B", 0, "A")],
    [page("P", 0, "B"), page("x", 0), page("y", 1)],
    none,
  );
  // A, B, P, x, y

  test("covers every visible row between two, either way round", () => {
    expect(rangeBetween(rows, "B", "x").map((t) => t.id)).toEqual([
      "B",
      "P",
      "x",
    ]);
    expect(rangeBetween(rows, "x", "B").map((t) => t.id)).toEqual([
      "B",
      "P",
      "x",
    ]);
  });

  test("a range of one is that one", () => {
    expect(rangeBetween(rows, "x", "x").map((t) => t.id)).toEqual(["x"]);
  });

  test("stops at what is on screen, not what is in the tree", () => {
    const closed = flattenTree(
      [folder("A", 0), folder("B", 0, "A")],
      [page("P", 0, "B"), page("x", 0), page("y", 1)],
      new Set(["A"]),
    );
    // P is inside the closed A, so a range across the list cannot include it.
    expect(rangeBetween(closed, "A", "y").map((t) => t.id)).toEqual([
      "A",
      "x",
      "y",
    ]);
  });

  test("a row that is gone yields nothing rather than a wrong range", () => {
    expect(rangeBetween(rows, "A", "vanished")).toEqual([]);
  });
});

describe("visibleSelection", () => {
  const folders = [folder("A", 0)];
  const pages = [page("inside", 0, "A"), page("out", 1)];

  test("puts the selection in the order the rows are drawn", () => {
    const rows = flattenTree(folders, pages, none);
    const picked = visibleSelection(rows, [
      pageAt("out"),
      folderAt("A"),
    ]);
    expect(picked.map((t) => t.id)).toEqual(["A", "out"]);
  });

  test("drops what closing a folder took off the screen", () => {
    const rows = flattenTree(folders, pages, new Set(["A"]));
    const picked = visibleSelection(rows, [
      pageAt("inside"),
      pageAt("out"),
    ]);
    expect(picked.map((t) => t.id)).toEqual(["out"]);
  });
});

describe("topmost", () => {
  const folders = [folder("A", 0), folder("B", 0, "A")];
  const pages = [page("deep", 0, "B"), page("loose", 0)];
  const rows = flattenTree(folders, pages, none);

  test("a folder swallows its own descendants", () => {
    const acting = topmost(rows, [
      folderAt("A"),
      folderAt("B"),
      pageAt("deep"),
      pageAt("loose"),
    ]);
    expect(acting.map((t) => t.id)).toEqual(["A", "loose"]);
  });

  test("an unselected folder in between does not shield anything", () => {
    const acting = topmost(rows, [pageAt("deep")]);
    expect(acting.map((t) => t.id)).toEqual(["deep"]);
  });

  test("siblings all act", () => {
    const acting = topmost(rows, [
      folderAt("B"),
      pageAt("loose"),
    ]);
    expect(acting.map((t) => t.id)).toEqual(["B", "loose"]);
  });
});
