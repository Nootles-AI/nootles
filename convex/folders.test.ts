/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The sidebar tree's mutations: folders, folder-aware page moves, and the
 * deep copies behind copy/paste. Structure and cascade properties — document
 * sync itself is ydoc.test.ts's subject.
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

describe("folders.move", () => {
  test("reorders after a sibling and reparents", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, { projectId });
    const c = await as(t).mutation(api.folders.create, { projectId });

    await as(t).mutation(api.folders.move, { folderId: a, after: b });
    let rows = await as(t).query(api.folders.listByProject, { projectId });
    let byId = new Map(rows.map((f) => [f._id, f]));
    expect(byId.get(b)!.order).toBeLessThan(byId.get(a)!.order);
    expect(byId.get(a)!.order).toBeLessThan(byId.get(c)!.order);

    await as(t).mutation(api.folders.move, { folderId: c, parentId: a });
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
      as(t).mutation(api.folders.move, { folderId: a, parentId: b }),
    ).rejects.toThrow("into itself");
    await expect(
      as(t).mutation(api.folders.move, { folderId: a, parentId: a }),
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

describe("pages.move", () => {
  test("crosses folders and lands after its anchor", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const a = await as(t).mutation(api.pages.create, { projectId, folderId: folder });
    const b = await as(t).mutation(api.pages.create, { projectId, folderId: folder });
    const loose = await as(t).mutation(api.pages.create, { projectId });

    await as(t).mutation(api.pages.move, {
      pageId: loose,
      folderId: folder,
      after: a,
    });
    let pages = await as(t).query(api.pages.listByProject, { projectId });
    let byId = new Map(pages.map((p) => [p._id, p]));
    expect(byId.get(loose)!.folderId).toBe(folder);
    expect(byId.get(a)!.order).toBeLessThan(byId.get(loose)!.order);
    expect(byId.get(loose)!.order).toBeLessThan(byId.get(b)!.order);

    // Back to the top level: the folder field clears rather than lingering.
    await as(t).mutation(api.pages.move, { pageId: loose });
    pages = await as(t).query(api.pages.listByProject, { projectId });
    byId = new Map(pages.map((p) => [p._id, p]));
    expect(byId.get(loose)!.folderId).toBeUndefined();
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
