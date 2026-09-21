/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { encodePreview, PREVIEW_BLOCKS, PREVIEW_MAX_CHARS } from "./previewShape";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * Stored previews ride the document's own access: whoever may read the page
 * reads its preview, only a writer leaves one, and a reader's offer to leave
 * one is declined quietly rather than thrown.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const VIEWER = { subject: "user_viewer" };
const STRANGER = { subject: "user_stranger" };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

async function world(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      shareToken: "view-token",
      createdAt: 1,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "",
      order: 0,
      docId,
      createdAt: 1,
    });
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId: VIEWER.subject,
      role: "viewer",
      createdAt: 1,
    });
    return { projectId, pageId, docId };
  });
}

const blocks = (text: string) => JSON.stringify([{ id: "b1", type: "paragraph", text }]);

describe("previews", () => {
  test("a writer leaves one and every reader of the page sees it", async () => {
    const t = harness();
    const { docId } = await world(t);
    const owner = t.withIdentity(OWNER);
    expect(await owner.query(api.previews.get, { docId })).toBeNull();

    await owner.mutation(api.previews.set, { docId, blocks: blocks("one"), seq: 3 });
    expect(await owner.query(api.previews.get, { docId })).toEqual({
      blocks: blocks("one"),
      seq: 3,
    });
    expect(await t.withIdentity(VIEWER).query(api.previews.get, { docId })).toEqual({
      blocks: blocks("one"),
      seq: 3,
    });
  });

  test("a viewer's offer is declined quietly; a stranger cannot even read", async () => {
    const t = harness();
    const { docId, projectId } = await world(t);
    await t
      .withIdentity(VIEWER)
      .mutation(api.previews.set, { docId, blocks: blocks("mine"), seq: 9 });
    expect(await t.withIdentity(OWNER).query(api.previews.get, { docId })).toBeNull();

    await t.run(async (ctx) => await ctx.db.patch(projectId, { shareToken: undefined }));
    await expect(
      t.withIdentity(STRANGER).query(api.previews.get, { docId }),
    ).rejects.toThrow();
  });

  test("an older read never replaces a newer one", async () => {
    const t = harness();
    const { docId } = await world(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.previews.set, { docId, blocks: blocks("new"), seq: 10 });
    await owner.mutation(api.previews.set, { docId, blocks: blocks("old"), seq: 4 });
    expect((await owner.query(api.previews.get, { docId }))!.blocks).toBe(blocks("new"));
  });

  test("a top grown too heavy takes the stored preview away", async () => {
    const t = harness();
    const { docId } = await world(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.previews.set, { docId, blocks: blocks("kept"), seq: 1 });
    await owner.mutation(api.previews.set, { docId, blocks: null, seq: 2 });
    expect(await owner.query(api.previews.get, { docId })).toBeNull();
  });

  test("an oversized preview is refused outright", async () => {
    const t = harness();
    const { docId } = await world(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.previews.set, {
        docId,
        blocks: "x".repeat(PREVIEW_MAX_CHARS + 1),
        seq: 1,
      }),
    ).rejects.toThrow();
  });

  test("a duplicated page takes its preview with it", async () => {
    const t = harness();
    const { docId, pageId } = await world(t);
    const owner = t.withIdentity(OWNER);
    await t.run(async (ctx) => {
      await ctx.db.insert("ydocs", {
        docId,
        seq: 0,
        snapshotSeq: 0,
        snapshotParts: 0,
        updatedAt: 1,
      });
    });
    await owner.mutation(api.previews.set, { docId, blocks: blocks("pic"), seq: 0 });
    const copyId = await owner.mutation(api.pages.duplicate, { pageId });
    const copy = await owner.query(api.pages.get, { pageId: copyId });
    expect((await owner.query(api.previews.get, { docId: copy!.docId }))!.blocks).toBe(
      blocks("pic"),
    );
  });
});

describe("encodePreview", () => {
  test("keeps the top of the page and nothing under it", () => {
    const many = Array.from({ length: PREVIEW_BLOCKS + 5 }, (_, i) => ({ id: `b${i}` }));
    expect(JSON.parse(encodePreview(many)!)).toHaveLength(PREVIEW_BLOCKS);
  });

  test("answers null for a top too heavy to keep", () => {
    expect(encodePreview([{ data: "x".repeat(PREVIEW_MAX_CHARS) }])).toBeNull();
  });
});
