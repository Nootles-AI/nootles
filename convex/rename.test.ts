/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * A rename typed against a name that has since changed elsewhere is rebased
 * onto the current name rather than replacing it (NT-138). `base` is the name
 * the typing started from; without it the title is written as given.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

async function world() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  const me = t.withIdentity({ subject: "user_owner" });
  const projectId = await me.mutation(api.projects.create, { title: "Draft" });
  const [page] = await me.query(api.pages.listByProject, { projectId });
  const folderId = await me.mutation(api.folders.create, { projectId });
  await me.mutation(api.folders.rename, { folderId, title: "Draft" });
  await me.mutation(api.pages.rename, { pageId: page._id, title: "Draft" });
  return { t, me, projectId, pageId: page._id, folderId };
}

describe("rename with a base", () => {
  test("pages: a stale base is rebased onto the row's title", async () => {
    const { t, me, pageId } = await world();
    await me.mutation(api.pages.rename, { pageId, title: "Launch plan" });
    await me.mutation(api.pages.rename, { pageId, title: "Draft v2", base: "Draft" });
    expect((await me.query(api.pages.get, { pageId }))!.title).toBe("Launch plan v2");
    // The page's context node follows the merged title, not the one sent.
    const node = await t.run((ctx) =>
      ctx.db.query("contextNodes").filter((q) => q.eq(q.field("externalId"), pageId)).first(),
    );
    if (node) expect(node.title).toBe("Launch plan v2");
  });

  test("pages: a current base, or none, writes the title as given", async () => {
    const { me, pageId } = await world();
    await me.mutation(api.pages.rename, { pageId, title: "Draft v2", base: "Draft" });
    expect((await me.query(api.pages.get, { pageId }))!.title).toBe("Draft v2");
    await me.mutation(api.pages.rename, { pageId, title: "Undone" });
    expect((await me.query(api.pages.get, { pageId }))!.title).toBe("Undone");
  });

  test("folders and projects rebase the same way", async () => {
    const { me, projectId, folderId } = await world();
    await me.mutation(api.folders.rename, { folderId, title: "Archive" });
    await me.mutation(api.folders.rename, { folderId, title: "Draft 2024", base: "Draft" });
    const folders = await me.query(api.folders.listByProject, { projectId });
    expect(folders.find((f) => f._id === folderId)!.title).toBe("Archive 2024");

    await me.mutation(api.projects.rename, { projectId, title: "Launch" });
    await me.mutation(api.projects.rename, { projectId, title: "Draft team", base: "Draft" });
    expect((await me.query(api.projects.get, { projectId }))!.title).toBe("Launch team");
  });
});
