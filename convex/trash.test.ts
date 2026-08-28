/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * Soft delete and the way back: a delete returns exactly what it marked,
 * `trash.restore` brings that back whole, `trash.remove` re-marks it — the
 * three verbs the sidebar's undo entries are made of.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const STRANGER = { subject: "user_stranger" };

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

describe("soft delete and restore", () => {
  test("a removed page returns whole, in its old place", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const pageId = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Kept",
      folderId: folder,
    });

    const marked = await as(t).mutation(api.pages.remove, { pageId });
    expect(marked).toEqual({ pages: [pageId], folders: [] });
    expect(
      await as(t).query(api.pages.listByProject, { projectId }),
    ).toHaveLength(0);

    await as(t).mutation(api.trash.restore, marked);
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(pages.map((p) => [p.title, p.folderId])).toEqual([["Kept", folder]]);
  });

  test("a folder delete's undo restores its subtree — and only what IT took", async () => {
    const t = harness();
    const projectId = await world(t);
    const a = await as(t).mutation(api.folders.create, { projectId });
    const b = await as(t).mutation(api.folders.create, { projectId, parentId: a });
    const inner = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Inner",
      folderId: b,
    });
    const earlier = await as(t).mutation(api.pages.create, {
      projectId,
      title: "Gone first",
      folderId: a,
    });

    // A page deleted on its own, before the folder came down…
    await as(t).mutation(api.pages.remove, { pageId: earlier });
    const marked = await as(t).mutation(api.folders.remove, { folderId: a });
    expect(new Set(marked.folders)).toEqual(new Set([a, b]));
    expect(marked.pages).toEqual([inner]);

    // …stays deleted when the folder delete is undone.
    await as(t).mutation(api.trash.restore, marked);
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(pages.map((p) => p.title)).toEqual(["Inner"]);
    expect(
      await as(t).query(api.folders.listByProject, { projectId }),
    ).toHaveLength(2);
  });

  test("trash.remove re-marks exactly the restored rows — a delete's redo", async () => {
    const t = harness();
    const projectId = await world(t);
    const pageId = await as(t).mutation(api.pages.create, { projectId });
    const marked = await as(t).mutation(api.pages.remove, { pageId });
    await as(t).mutation(api.trash.restore, marked);
    await as(t).mutation(api.trash.remove, marked);
    expect(
      await as(t).query(api.pages.listByProject, { projectId }),
    ).toHaveLength(0);
  });

  test("a stranger cannot restore what is not theirs", async () => {
    const t = harness();
    const projectId = await world(t);
    const pageId = await as(t).mutation(api.pages.create, { projectId });
    const marked = await as(t).mutation(api.pages.remove, { pageId });
    await expect(
      t.withIdentity(STRANGER).mutation(api.trash.restore, marked),
    ).rejects.toThrow("Not found");
  });

  test("a soft-deleted project hides everything and comes back whole", async () => {
    const t = harness();
    const projectId = await world(t);
    await as(t).mutation(api.pages.create, { projectId, title: "Inside" });

    await as(t).mutation(api.projects.remove, { projectId });
    expect(await as(t).query(api.projects.list, {})).toHaveLength(0);
    expect(await as(t).query(api.projects.get, { projectId })).toBeNull();
    expect(
      await as(t).query(api.pages.listByProject, { projectId }),
    ).toHaveLength(0);

    await as(t).mutation(api.trash.restore, { projects: [projectId] });
    expect(await as(t).query(api.projects.list, {})).toHaveLength(1);
    const pages = await as(t).query(api.pages.listByProject, { projectId });
    expect(pages.map((p) => p.title)).toEqual(["Inside"]);
  });
});

describe("tree.move returns the way back", () => {
  test("place puts rows exactly where move found them", async () => {
    const t = harness();
    const projectId = await world(t);
    const folder = await as(t).mutation(api.folders.create, { projectId });
    const pageId = await as(t).mutation(api.pages.create, { projectId });
    const before = await as(t).query(api.pages.listByProject, { projectId });
    const stood = before.find((p) => p._id === pageId)!;

    const prior = await as(t).mutation(api.tree.move, {
      items: [{ kind: "page", id: pageId }],
      parentId: folder,
      atEnd: true,
    });
    expect(prior).toEqual([
      {
        kind: "page",
        id: pageId,
        parentId: stood.folderId,
        order: stood.order,
      },
    ]);

    await as(t).mutation(api.tree.place, { items: prior! });
    const after = await as(t).query(api.pages.listByProject, { projectId });
    const back = after.find((p) => p._id === pageId)!;
    expect([back.folderId, back.order]).toEqual([stood.folderId, stood.order]);
  });
});
