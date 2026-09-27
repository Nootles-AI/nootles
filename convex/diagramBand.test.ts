/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import schema from "./schema";
import { appendYUpdate } from "./ydoc";
import { canvasMapName, materializeCanvas, populateCanvas } from "@/app/components/editor/canvas/collab/ymap";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { parseHTML } from "linkedom";

/**
 * The one-time diagram migration's server halves: the seq guard that keeps a
 * rewrite off a document somebody wrote to since it was read, the quiet append
 * that leaves nobody's edited stamp moved, and the Node runner end to end.
 * What the rewrite does to a document is `app/lib/sync/diagramBand.test.ts`.
 */

const modules = import.meta.glob("./**/*.ts");

const OLD = `<nt-diagram w="960" h="540"><nt-rect id="a" x="40" y="40" w="160" h="90"></nt-rect><nt-rect id="b" x="820" y="40" w="120" h="90"></nt-rect></nt-diagram>`;

/** By name: a module reaches the typed `internal` only once codegen has seen it. */
const migrate = makeFunctionReference<
  "action",
  { cursor?: string; dryRun: boolean; numItems?: number },
  {
    seen: number;
    changed: { docId: string; maps: number; props: number; moved: number; samples: { after: string }[] }[];
    skipped: { docId: string; reason: string; message?: string }[];
    done: boolean;
    cursor: string | null;
  }
>("diagramBand:migrate");

function bytes(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** A page Y.Doc holding one diagram in the old format, with its maps — or maps no reader can make out. */
function oldPage(broken = false): ArrayBuffer {
  const doc = new Y.Doc();
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", "c1");
  const canvas = new Y.XmlElement("canvas");
  canvas.setAttribute("data", OLD);
  container.insert(0, [canvas]);
  const group = new Y.XmlElement("blockGroup");
  group.insert(0, [container]);
  doc.getXmlFragment("prosemirror").insert(0, [group]);
  populateCanvas(
    doc.getMap(canvasMapName("c1")),
    parseScene(OLD, (html) => parseHTML(html).document as unknown as Document),
  );
  if (broken) doc.getMap(canvasMapName("c1")).set("meta", "not a map");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes(update);
}

/** Any other append — somebody's edit landing on the doc. */
function edit(): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getMap("other").set("k", 1);
  return bytes(Y.encodeStateAsUpdate(doc));
}

async function world(t: TestConvex<typeof schema>, initial: ArrayBuffer = edit()) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: "user_owner",
      title: "P",
      createdAt: 1,
      updatedAt: 1,
      pageCount: 1,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: "user_owner",
      projectId,
      title: "",
      order: 0,
      docId,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("ydocs", { docId, seq: 1, snapshotSeq: 0, snapshotParts: 0, updatedAt: 1 });
    await ctx.db.insert("yUpdates", { docId, seq: 1, update: initial });
    return { projectId, pageId, docId };
  });
}

async function stored(t: TestConvex<typeof schema>, docId: string) {
  const material = await t.query(internal.migrations.diagramBandMaterial, { docId });
  if (material.status !== "ok") throw new Error(material.status);
  const doc = new Y.Doc();
  for (const update of material.updates) Y.applyUpdate(doc, new Uint8Array(update));
  return { seq: material.seq, doc };
}

describe("diagramBandWrite", () => {
  test("refuses a document that moved since it was read, and writes nothing", async () => {
    const t = convexTest(schema, modules);
    const { docId } = await world(t);
    await t.run((ctx) => appendYUpdate(ctx, docId, [edit()]));
    expect(await t.mutation(internal.migrations.diagramBandWrite, { docId, baseSeq: 1, chunks: [edit()] })).toEqual({
      status: "moved",
    });
    expect((await stored(t, docId)).seq).toBe(2);
  });

  test("appends quietly: seq and the Yjs flag move, the edited stamps do not", async () => {
    const t = convexTest(schema, modules);
    const { projectId, pageId, docId } = await world(t);
    expect(await t.mutation(internal.migrations.diagramBandWrite, { docId, baseSeq: 1, chunks: [edit()] })).toEqual({
      status: "written",
      seq: 2,
    });
    const quiet = await t.run(async (ctx) => ({ page: await ctx.db.get(pageId), project: await ctx.db.get(projectId) }));
    expect(quiet.page).toMatchObject({ updatedAt: 1, yjs: true });
    expect(quiet.project?.updatedAt).toBe(1);

    // The same append, not quiet, is an edit.
    await t.run((ctx) => appendYUpdate(ctx, docId, [edit()]));
    const loud = await t.run(async (ctx) => ({ page: await ctx.db.get(pageId), project: await ctx.db.get(projectId) }));
    expect(loud.page?.updatedAt).toBeGreaterThan(1);
    expect(loud.project?.updatedAt).toBeGreaterThan(1);
  });
});

describe("diagramBandMaterial", () => {
  test("a snapshot too heavy to read is refused without reading it", async () => {
    const t = convexTest(schema, modules);
    const { docId } = await world(t);
    await t.run(async (ctx) => {
      const row = await ctx.db.query("ydocs").withIndex("by_doc", (q) => q.eq("docId", docId)).unique();
      await ctx.db.patch(row!._id, { snapshotSeq: 1, snapshotParts: 9, snapshotBytes: 7 * 1024 * 1024 });
    });
    expect(await t.query(internal.migrations.diagramBandMaterial, { docId })).toEqual({ status: "too-large" });
    expect(await t.query(internal.migrations.diagramBandMaterial, { docId: "nope" })).toEqual({ status: "no-doc" });
  });
});

describe("diagramBand.migrate", () => {
  test("previews, rewrites once, then finds nothing — skipping what is not a page", async () => {
    const t = convexTest(schema, modules);
    const { pageId, docId } = await world(t, oldPage());
    await t.run(async (ctx) => {
      // A comments document, and a page document nobody has written yet.
      await ctx.db.insert("ydocs", { docId: "comments-doc", seq: 1, snapshotSeq: 0, snapshotParts: 0, updatedAt: 1 });
      await ctx.db.insert("yUpdates", { docId: "comments-doc", seq: 1, update: oldPage() });
      await ctx.db.insert("ydocs", { docId: "unborn", seq: 0, snapshotSeq: 0, snapshotParts: 0, updatedAt: 1 });
    });

    const preview = await t.action(migrate, { dryRun: true });
    expect(preview).toMatchObject({ seen: 1, skipped: [], done: true, cursor: null });
    expect(preview.changed).toMatchObject([{ docId, maps: 1, props: 1, moved: 0 }]);
    expect(preview.changed[0].samples[0].after).toBe(`<nt-diagram h="260" wide>`);
    expect((await stored(t, docId)).seq).toBe(1);

    const run = await t.action(migrate, { dryRun: false });
    expect(run.changed).toMatchObject([{ docId, maps: 1, props: 1 }]);
    const { seq, doc } = await stored(t, docId);
    expect(seq).toBe(2);
    expect(materializeCanvas(doc.getMap(canvasMapName("c1")))).toMatchObject({ w: 0, h: 260, wide: true });
    const page = await t.run((ctx) => ctx.db.get(pageId));
    expect(page?.updatedAt).toBe(1);

    const again = await t.action(migrate, { dryRun: true });
    expect(again).toMatchObject({ seen: 1, changed: [], skipped: [] });
  });

  test("a document the rewrite fails on is reported, and the batch goes on past it", async () => {
    const t = convexTest(schema, modules);
    const broken = await world(t, oldPage(true));
    const healthy = await world(t, oldPage());

    const run = await t.action(migrate, { dryRun: false });
    expect(run).toMatchObject({ seen: 2, done: true, cursor: null });
    expect(run.skipped).toEqual([{ docId: broken.docId, reason: "failed", message: expect.any(String) }]);
    expect(run.changed).toMatchObject([{ docId: healthy.docId, maps: 1, props: 1 }]);
    expect((await stored(t, broken.docId)).seq).toBe(1);
  });

  test("a document whose read throws is reported, and the batch keeps its cursor", async () => {
    const t = convexTest(schema, modules);
    const broken = await world(t, oldPage());
    const healthy = await world(t, oldPage());
    // Two rows for one document: its read throws, as a function limit would.
    await t.run((ctx) =>
      ctx.db.insert("ydocs", { docId: broken.docId, seq: 1, snapshotSeq: 0, snapshotParts: 0, updatedAt: 1 }),
    );

    const run = await t.action(migrate, { dryRun: false });
    expect(run).toMatchObject({ done: true, cursor: null });
    expect(run.skipped.length).toBeGreaterThan(0);
    expect(run.skipped.every((s) => s.docId === broken.docId && s.reason === "failed" && !!s.message)).toBe(true);
    expect(run.changed).toMatchObject([{ docId: healthy.docId, maps: 1, props: 1 }]);
  });
});
