/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The sidebar tree's mutations: folders, the one move verb both kinds share,
 * and the deep copies behind copy/paste. Structure and cascade properties —
 * document sync itself is ydoc.test.ts's subject.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

async function world(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
    });
  });
}

function as(t: TestConvex<typeof schema>) {
  return t.withIdentity(OWNER);
}

describe("folders.create", () => {
  test("appends at its level and nests under a parent", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, { projectId });
    const child = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: a,
    });
    const rows = await as(t).query(api.folders.listByProject, { projectId });
    const byId = new Map(rows.map((f) => [f._id, f]));
    expect(byId.get(a)!.order).toBeLessThan(byId.get(b)!.order);
    expect(byId.get(child)!.parentId).toBe(a);
  });

  test("appends past the level's pages too — the order line is shared", async () => {
    const t = harness();
    const projectId = await world(t);
    const p = await as(t).mutation(api.pages.create, { projectId });
    const f = await as(t).mutation(api.folders.create, { projectId });
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const folders = await as(t).query(api.folders.listByProject, { projectId });
    expect(pages.find((r) => r._id === p)!.order).toBeLessThan(
      folders.find((r) => r._id === f)!.order,
    );
  });

  test("refuses a parent from another project", async () => {
    const t = harness();
    const projectId = await world(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("projects", { ownerId: OWNER.subject, title: "Q", createdAt: 1 }),
    );
    const foreign = await as(t).mutation(api.folders.create, {
      projectId: other,
    });
    await expect(
      as(t).mutation(api.folders.create, { projectId, parentId: foreign }),
    ).rejects.toThrow("Not found");
  });
});

describe("tree.move with folders", () => {
  test("reorders after a sibling and reparents", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, { projectId });
    const c = await as(t).mutation(api.folders.create, { projectId });

    await as(t).mutation(api.tree.move, {
      items: [{ kind: "folder", id: a }],
      after: b,
    });
    let rows = await as(t).query(api.folders.listByProject, { projectId });
    let byId = new Map(rows.map((f) => [f._id, f]));
    expect(byId.get(b)!.order).toBeLessThan(byId.get(a)!.order);
    expect(byId.get(a)!.order).toBeLessThan(byId.get(c)!.order);

    await as(t).mutation(api.tree.move, {
      items: [{ kind: "folder", id: c }],
      parentId: a,
    });
    rows = await as(t).query(api.folders.listByProject, { projectId });
    byId = new Map(rows.map((f) => [f._id, f]));
    expect(byId.get(c)!.parentId).toBe(a);
  });

  test("refuses its own subtree", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: a,
    });
    await expect(
      as(t).mutation(api.tree.move, {
        items: [{ kind: "folder", id: a }],
        parentId: b,
      }),
    ).rejects.toThrow("into itself");
    await expect(
      as(t).mutation(api.tree.move, {
        items: [{ kind: "folder", id: a }],
        parentId: a,
      }),
    ).rejects.toThrow("into itself");
  });
});

describe("folders.remove", () => {
  test("takes subfolders and their pages with it", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: a,
    });
    const inner = await as(t).mutation(api.pages.create, {
      projectId,
      folderId: b,
    });
    const outer = await as(t).mutation(api.pages.create, { projectId });

    await as(t).mutation(api.folders.remove, { folderId: a });

    const folders = await as(t).query(api.folders.listByProject, { projectId });
    expect(folders).toHaveLength(0);
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(pages.map((p) => p._id)).toEqual([outer]);
    expect(pages.map((p) => p._id)).not.toContain(inner);
  });
});

describe("tree.move with pages", () => {
  test("crosses folders and lands after its anchor", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const a = await as(t).mutation(api.pages.create, { projectId, folderId: folder });
    const b = await as(t).mutation(api.pages.create, { projectId, folderId: folder });
    const loose = await as(t).mutation(api.pages.create, { projectId });

    await as(t).mutation(api.tree.move, {
      items: [{ kind: "page", id: loose }],
      parentId: folder,
      after: a,
    });
    let pages = await as(t).query(api.pages.listByProject, { projectId });
    let byId = new Map(pages.map((p) => [p._id, p]));
    expect(byId.get(loose)!.folderId).toBe(folder);
    expect(byId.get(a)!.order).toBeLessThan(byId.get(loose)!.order);
    expect(byId.get(loose)!.order).toBeLessThan(byId.get(b)!.order);

    // Back to the top level: the folder field clears rather than lingering.
    await as(t).mutation(api.tree.move, {
      items: [{ kind: "page", id: loose }],
    });
    pages = await as(t).query(api.pages.listByProject, { projectId });
    byId = new Map(pages.map((p) => [p._id, p]));
    expect(byId.get(loose)!.folderId).toBeUndefined();
  });

  test("a page can take a place before a folder — one order line per level", async () => {
    const t = harness();
    const projectId = await world(t);
    const f = await as(t).mutation(api.folders.create, { projectId });
    const g = await as(t).mutation(api.folders.create, { projectId });
    const p = await as(t).mutation(api.pages.create, { projectId });

    // p lands between the two folders, anchored on a folder row.
    await as(t).mutation(api.tree.move, {
      items: [{ kind: "page", id: p }],
      after: f,
    });

    const folders = await as(t).query(api.folders.listByProject, { projectId });
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const orderOf = new Map<string, number>([
      ...folders.map((r) => [r._id as string, r.order] as const),
      ...pages.map((r) => [r._id as string, r.order] as const),
    ]);
    expect(orderOf.get(f)!).toBeLessThan(orderOf.get(p)!);
    expect(orderOf.get(p)!).toBeLessThan(orderOf.get(g)!);
  });
});

describe("moving a group", () => {
  test("pages land together, in the order they were handed over", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const a = await as(t).mutation(api.pages.create, { projectId, title: "a" });
    const b = await as(t).mutation(api.pages.create, { projectId, title: "b" });
    const c = await as(t).mutation(api.pages.create, { projectId, title: "c" });
    const keep = await as(t).mutation(api.pages.create, {
      projectId,
      folderId: folder,
      title: "keep",
    });

    await as(t).mutation(api.tree.move, {
      items: [
        { kind: "page", id: c },
        { kind: "page", id: a },
      ],
      parentId: folder,
      after: keep,
    });

    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const inFolder = pages
      .filter((p) => p.folderId === folder)
      .sort((x, y) => x.order - y.order)
      .map((p) => p.title);
    expect(inFolder).toEqual(["keep", "c", "a"]);
    // The one left behind stays where it was.
    expect(pages.find((p) => p._id === b)!.folderId).toBeUndefined();
  });

  test("an anchor inside the group sends it to the end instead", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.pages.create, { projectId, title: "a" });
    const b = await as(t).mutation(api.pages.create, { projectId, title: "b" });
    const c = await as(t).mutation(api.pages.create, { projectId, title: "c" });

    // Dropping a and b onto a, which is itself travelling.
    await as(t).mutation(api.tree.move, {
      items: [
        { kind: "page", id: a },
        { kind: "page", id: b },
      ],
      after: a,
    });

    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const order = pages.sort((x, y) => x.order - y.order).map((p) => p.title);
    expect(order).toEqual(["c", "a", "b"]);
    expect(pages.find((p) => p._id === c)).toBeTruthy();
  });

  test("a folder group refuses a destination inside any of its members", async () => {
    const t = harness();
    const projectId = await world(t);
    const outer = await as(t).mutation(api.folders.create, { projectId });
    const inner = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: outer,
    });
    const other = await as(t).mutation(api.folders.create, { projectId });

    await expect(
      as(t).mutation(api.tree.move, {
        items: [
          { kind: "folder", id: other },
          { kind: "folder", id: outer },
        ],
        parentId: inner,
      }),
    ).rejects.toThrow("into itself");
    // Nothing moved: the whole group is refused, not the legal part of it.
    const rows = await as(t).query(api.folders.listByProject, { projectId });
    expect(rows.find((f) => f._id === other)!.parentId).toBeUndefined();
  });

  test("a mixed selection lands together, interleaved as handed over", async () => {
    const t = harness();
    const projectId = await world(t);
    const dest = await as(t).mutation(api.folders.create, { projectId, title: "dest" });
    const p = await as(t).mutation(api.pages.create, { projectId, title: "p" });
    const f = await as(t).mutation(api.folders.create, { projectId, title: "f" });
    const q = await as(t).mutation(api.pages.create, { projectId, title: "q" });

    // Page above folder above page — the one gap takes all three, in order.
    await as(t).mutation(api.tree.move, {
      items: [
        { kind: "page", id: p },
        { kind: "folder", id: f },
        { kind: "page", id: q },
      ],
      parentId: dest,
    });

    const folders = await as(t).query(api.folders.listByProject, { projectId });
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const inside = [
      ...folders
        .filter((r) => r.parentId === dest)
        .map((r) => ({ title: r.title, order: r.order })),
      ...pages
        .filter((r) => r.folderId === dest)
        .map((r) => ({ title: r.title, order: r.order })),
    ]
      .sort((x, y) => x.order - y.order)
      .map((r) => r.title);
    expect(inside).toEqual(["p", "f", "q"]);
  });

  test("an empty group is a no-op", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.pages.create, { projectId, title: "a" });
    await as(t).mutation(api.tree.move, { items: [] });
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(pages.map((p) => p._id)).toEqual([a]);
  });
});

describe("pages.duplicate", () => {
  test("copies a Yjs doc verbatim and renames only beside its source", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const pageId = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Notes",
    });
    const docId = (await t.run(async (ctx) => ctx.db.get(pageId)))!.docId;
    await t.run(async (ctx) => {
      await ctx.db.insert("ydocs", {
        docId,
        seq: 2,
        snapshotSeq: 0,
        snapshotParts: 0,
        updatedAt: 1,
      });
      await ctx.db.insert("yUpdates", { docId, seq: 1, update: new ArrayBuffer(4) });
      await ctx.db.insert("yUpdates", { docId, seq: 2, update: new ArrayBuffer(4) });
    });

    const beside = await as(t).mutation(api.pages.duplicate, { pageId });
    const away = await as(t).mutation(api.pages.duplicate, {
      pageId,
      folderId: folder,
    });

    const pages = await as(t).query(api.pages.listByProject, { projectId });
    const byId = new Map(pages.map((p) => [p._id, p]));
    expect(byId.get(beside)!.title).toBe("Notes copy");
    expect(byId.get(away)!.title).toBe("Notes");
    expect(byId.get(away)!.folderId).toBe(folder);
    expect(byId.get(beside)!.docId).not.toBe(docId);

    await t.run(async (ctx) => {
      const copy = await ctx.db
        .query("ydocs")
        .withIndex("by_doc", (q) => q.eq("docId", byId.get(beside)!.docId))
        .unique();
      expect(copy?.seq).toBe(2);
      const updates = await ctx.db
        .query("yUpdates")
        .withIndex("by_doc_and_seq", (q) =>
          q.eq("docId", byId.get(beside)!.docId),
        )
        .collect();
      expect(updates.map((u) => u.seq)).toEqual([1, 2]);
    });
  });

  test("copies a legacy doc through its snapshot and trailing steps", async () => {
    const t = harness();
    const projectId = await world(t);
    const pageId = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Legacy",
    });
    const docId = (await t.run(async (ctx) => ctx.db.get(pageId)))!.docId;
    const content = JSON.stringify({ type: "doc", content: [] });
    await as(t).mutation(api.prosemirror.submitSnapshot, {
      id: docId,
      version: 1,
      content,
    });

    const copy = await as(t).mutation(api.pages.duplicate, { pageId });
    const copyDocId = (await t.run(async (ctx) => ctx.db.get(copy)))!.docId;
    const snap = await as(t).query(api.prosemirror.getSnapshot, {
      id: copyDocId,
    });
    expect(snap.content).toBe(content);
  });

  test("carries the steps written after the last snapshot", async () => {
    const t = harness();
    const projectId = await world(t);
    const pageId = await as(t).mutation(api.pages.create, { projectId });
    const docId = (await t.run(async (ctx) => ctx.db.get(pageId)))!.docId;
    const content = JSON.stringify({ type: "doc", content: [] });
    await as(t).mutation(api.prosemirror.submitSnapshot, {
      id: docId,
      version: 1,
      content,
    });
    // A page edited since its last snapshot: the snapshot alone would lose this.
    const steps = [JSON.stringify({ stepType: "replace", from: 1, to: 1 })];
    await as(t).mutation(api.prosemirror.submitSteps, {
      id: docId,
      version: 1,
      clientId: "tester",
      steps,
    });

    const copy = await as(t).mutation(api.pages.duplicate, { pageId });
    const copyDocId = (await t.run(async (ctx) => ctx.db.get(copy)))!.docId;
    const carried = await as(t).query(api.prosemirror.getSteps, {
      id: copyDocId,
      version: 1,
    });
    expect(carried.steps).toEqual(steps);
  });
});

describe("tree.copyTo", () => {
  const OTHER = { subject: "user_other" };

  /** A second project — the destination, or a stranger's — under `owner`. */
  async function land(
    t: TestConvex<typeof schema>,
    owner: string,
    share?: { link: "read" | "edit"; grantee: string; role: "viewer" | "editor" },
  ) {
    return await t.run(async (ctx) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: owner,
        title: "Q",
        createdAt: 1,
        ...(share?.link === "read" ? { shareToken: "tok" } : {}),
        ...(share?.link === "edit" ? { editShareToken: "tok" } : {}),
      });
      if (share) {
        await ctx.db.insert("shareClaims", {
          projectId,
          granteeId: share.grantee,
          role: share.role,
          createdAt: 1,
        });
      }
      return projectId;
    });
  }

  test("copies a page into another project, content and all, keeping its title", async () => {
    const t = harness();
    const projectId = await world(t);
    const other = await land(t, OWNER.subject);
    const pageId = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Notes",
    });
    const docId = (await t.run(async (ctx) => ctx.db.get(pageId)))!.docId;
    await t.run(async (ctx) => {
      await ctx.db.insert("ydocs", {
        docId,
        seq: 2,
        snapshotSeq: 0,
        snapshotParts: 0,
        updatedAt: 1,
      });
      await ctx.db.insert("yUpdates", { docId, seq: 1, update: new ArrayBuffer(4) });
      await ctx.db.insert("yUpdates", { docId, seq: 2, update: new ArrayBuffer(4) });
    });

    await as(t).mutation(api.tree.copyTo, {
      items: [{ kind: "page", id: pageId }],
      projectId: other,
    });

    // The source stays: a copy is not a carry.
    const kept = await as(t).query(api.pages.listByProject, { projectId });
    expect(kept.map((p) => p._id)).toEqual([pageId]);

    const landed = await as(t).query(api.pages.listByProject, {
      projectId: other,
    });
    expect(landed).toHaveLength(1);
    // No " copy" suffix — in another project it is never beside its source.
    expect(landed[0].title).toBe("Notes");
    expect(landed[0].projectId).toBe(other);
    expect(landed[0].docId).not.toBe(docId);
    await t.run(async (ctx) => {
      const copy = await ctx.db
        .query("ydocs")
        .withIndex("by_doc", (q) => q.eq("docId", landed[0].docId))
        .unique();
      expect(copy?.seq).toBe(2);
    });
    // The destination's denormalized summary heard about its new page.
    const project = await t.run(async (ctx) => ctx.db.get(other));
    expect(project!.pageCount).toBe(1);
  });

  test("deep-copies a folder subtree across, every row owned by the destination", async () => {
    const t = harness();
    const projectId = await world(t);
    // The destination belongs to someone else; the caller holds its pen.
    const other = await land(t, OTHER.subject, {
      link: "edit",
      grantee: OWNER.subject,
      role: "editor",
    });
    const a = await as(t).mutation(api.folders.create, { projectId, title: "A" });
    const b = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: a,
      title: "B",
    });
    await as(t).mutation(api.pages.create, { projectId, folderId: b, title: "Deep" });
    const into = await t
      .withIdentity(OTHER)
      .mutation(api.folders.create, { projectId: other, title: "Dest" });

    await as(t).mutation(api.tree.copyTo, {
      items: [{ kind: "folder", id: a }],
      projectId: other,
      folderId: into,
    });

    const folders = await as(t).query(api.folders.listByProject, {
      projectId: other,
    });
    const aCopy = folders.find((f) => f.title === "A");
    const bCopy = folders.find((f) => f.title === "B");
    expect(aCopy?.parentId).toBe(into);
    expect(bCopy?.parentId).toBe(aCopy?._id);
    const pages = await as(t).query(api.pages.listByProject, { projectId: other });
    expect(pages.map((p) => [p.title, p.folderId])).toEqual([["Deep", bCopy?._id]]);
    // Copies belong to the project they land in, not to who pasted them.
    for (const row of [aCopy!, bCopy!, pages[0]]) {
      expect(row.ownerId).toBe(OTHER.subject);
      expect(row.projectId).toBe(other);
    }
  });

  test("a group lands together at the end, in the order it was handed over", async () => {
    const t = harness();
    const projectId = await world(t);
    const other = await land(t, OWNER.subject);
    await t.withIdentity(OWNER).mutation(api.pages.create, {
      projectId: other,
      title: "already",
    });
    const p = await as(t).mutation(api.pages.create, { projectId, title: "p" });
    const f = await as(t).mutation(api.folders.create, { projectId, title: "f" });
    const q = await as(t).mutation(api.pages.create, { projectId, title: "q" });

    await as(t).mutation(api.tree.copyTo, {
      items: [
        { kind: "page", id: p },
        { kind: "folder", id: f },
        { kind: "page", id: q },
      ],
      projectId: other,
    });

    const folders = await as(t).query(api.folders.listByProject, {
      projectId: other,
    });
    const pages = await as(t).query(api.pages.listByProject, { projectId: other });
    const level = [...folders, ...pages]
      .sort((x, y) => x.order - y.order)
      .map((r) => r.title);
    expect(level).toEqual(["already", "p", "f", "q"]);
  });

  test("move deletes the sources and refreshes both summaries", async () => {
    const t = harness();
    const projectId = await world(t);
    const other = await land(t, OWNER.subject);
    const pageId = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Roaming",
    });

    await as(t).mutation(api.tree.copyTo, {
      items: [{ kind: "page", id: pageId }],
      projectId: other,
      move: true,
    });

    const kept = await as(t).query(api.pages.listByProject, { projectId });
    expect(kept).toHaveLength(0);
    const landed = await as(t).query(api.pages.listByProject, { projectId: other });
    expect(landed.map((p) => p.title)).toEqual(["Roaming"]);
    const [from, to] = await t.run(async (ctx) => [
      await ctx.db.get(projectId),
      await ctx.db.get(other),
    ]);
    expect(from!.pageCount).toBe(0);
    expect(to!.pageCount).toBe(1);
  });

  test("a viewer of the source may copy out of it, but not cut", async () => {
    const t = harness();
    // OTHER's project, shared read-only with the caller.
    const theirs = await land(t, OTHER.subject, {
      link: "read",
      grantee: OWNER.subject,
      role: "viewer",
    });
    const theirPage = await t.withIdentity(OTHER).mutation(api.pages.create, {
      projectId: theirs,
      title: "Shared",
    });
    const mine = await world(t);

    await as(t).mutation(api.tree.copyTo, {
      items: [{ kind: "page", id: theirPage }],
      projectId: mine,
    });
    const landed = await as(t).query(api.pages.listByProject, { projectId: mine });
    expect(landed.map((p) => [p.title, p.ownerId])).toEqual([
      ["Shared", OWNER.subject],
    ]);

    // Cutting deletes the source, and a viewer holds no pen there.
    await expect(
      as(t).mutation(api.tree.copyTo, {
        items: [{ kind: "page", id: theirPage }],
        projectId: mine,
        move: true,
      }),
    ).rejects.toThrow("Not found");
  });

  test("skips sources the caller cannot see, without conceding they exist", async () => {
    const t = harness();
    const theirs = await land(t, OTHER.subject);
    const hidden = await t.withIdentity(OTHER).mutation(api.pages.create, {
      projectId: theirs,
      title: "Private",
    });
    const mine = await world(t);

    await as(t).mutation(api.tree.copyTo, {
      items: [{ kind: "page", id: hidden }],
      projectId: mine,
    });
    const landed = await as(t).query(api.pages.listByProject, { projectId: mine });
    expect(landed).toHaveLength(0);
  });

  test("refuses a destination the caller cannot edit, and a folder from elsewhere", async () => {
    const t = harness();
    const projectId = await world(t);
    const pageId = await as(t).mutation(api.pages.create, { projectId });
    const theirs = await land(t, OTHER.subject);
    await expect(
      as(t).mutation(api.tree.copyTo, {
        items: [{ kind: "page", id: pageId }],
        projectId: theirs,
      }),
    ).rejects.toThrow("Not found");

    const other = await land(t, OWNER.subject);
    const foreign = await as(t).mutation(api.folders.create, { projectId });
    await expect(
      as(t).mutation(api.tree.copyTo, {
        items: [{ kind: "page", id: pageId }],
        projectId: other,
        folderId: foreign,
      }),
    ).rejects.toThrow("Not found");
  });
});

describe("folders.duplicate", () => {
  test("deep-copies the subtree, pages included", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId, title: "A" });
    const b = await as(t).mutation(api.folders.create, {
      projectId,
      parentId: a,
      title: "B",
    });
    await as(t).mutation(api.pages.create, {
      projectId,
      folderId: b,
      title: "Deep",
    });

    const copy = await as(t).mutation(api.folders.duplicate, { folderId: a });

    const folders = await as(t).query(api.folders.listByProject, { projectId });
    const byId = new Map(folders.map((f) => [f._id, f]));
    expect(byId.get(copy)!.title).toBe("A copy");
    const bCopy = folders.find((f) => f.parentId === copy);
    expect(bCopy?.title).toBe("B");
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(
      pages.filter((p) => p.folderId === bCopy?._id).map((p) => p.title),
    ).toEqual(["Deep"]);
  });
});
