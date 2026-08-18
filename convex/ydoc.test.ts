/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { joinUpdateRows, splitUpdate, UPDATE_CHUNK_BYTES } from "./yshape";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The Yjs sync protocol under its real auth. Each test builds the same tiny
 * world: an owner's project with one page, share tokens optional — because
 * every interesting property here is about who may do what, and about the
 * seq/compaction bookkeeping staying honest under interleaving.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const GUEST = { subject: "user_guest" };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

async function world(
  t: TestConvex<typeof schema>,
  opts: { shareToken?: string; editShareToken?: string } = {},
) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
      ...opts,
    });
    const docId = crypto.randomUUID();
    await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "",
      order: 0,
      docId,
      createdAt: 1,
    });
    return { projectId, docId };
  });
}

function encodedInsert(text: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  const u = Y.encodeStateAsUpdate(doc);
  return u.buffer.slice(
    u.byteOffset,
    u.byteOffset + u.byteLength,
  ) as ArrayBuffer;
}

/**
 * A log like the one that took the storyboard page down: one oversized value
 * rewritten `count` times, so the LOG is far heavier than any single read may
 * be while the document it adds up to stays small. Returns the ending seq.
 */
async function fatLog(
  t: TestConvex<typeof schema>,
  docId: string,
  count: number,
): Promise<number> {
  const as = t.withIdentity(OWNER);
  const local = new Y.Doc();
  const pending: Uint8Array[] = [];
  local.on("update", (u: Uint8Array) => pending.push(u));
  const text = local.getText("t");
  let seq = 0;
  for (let i = 0; i < count; i++) {
    text.delete(0, text.length);
    text.insert(0, `m${i} ` + "x".repeat(UPDATE_CHUNK_BYTES * 2));
    const merged = Y.mergeUpdates(pending.splice(0));
    seq = await as.mutation(api.ydoc.append, {
      docId,
      chunks: splitUpdate(merged),
    });
  }
  local.destroy();
  return seq;
}

/** The document as a reader rebuilds it: every snapshot chunk, in order. */
async function rebuild(
  as: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  docId: string,
): Promise<Y.Doc> {
  const meta = await as.query(api.ydoc.meta, { docId });
  const parts: ArrayBuffer[] = [];
  for (let part = 0; part < meta!.snapshotParts; part++) {
    const chunk = await as.query(api.ydoc.snapshot, {
      docId,
      gen: meta!.snapshotSeq,
      part,
    });
    parts.push(chunk!);
  }
  const whole = new Uint8Array(parts.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of parts) {
    whole.set(new Uint8Array(c), at);
    at += c.byteLength;
  }
  const doc = new Y.Doc();
  Y.applyUpdate(doc, whole);
  return doc;
}

async function claim(
  t: TestConvex<typeof schema>,
  projectId: Id<"projects">,
  role: "viewer" | "editor",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId: GUEST.subject,
      role,
      createdAt: 1,
    });
  });
}

describe("init", () => {
  test("first writer wins; loser is told, not failed", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    const first = await as.mutation(api.ydoc.init, {
      docId,
      update: encodedInsert("a"),
    });
    expect(first).toEqual({ migrated: true });
    const second = await as.mutation(api.ydoc.init, {
      docId,
      update: encodedInsert("b"),
    });
    expect(second).toEqual({ migrated: false });
    const meta = await as.query(api.ydoc.meta, { docId });
    expect(meta).toEqual({ seq: 1, snapshotSeq: 0, snapshotParts: 0 });
  });

  test("state reads empty → yjs across init", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    expect(await as.query(api.ydoc.state, { docId })).toBe("empty");
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("a") });
    expect(await as.query(api.ydoc.state, { docId })).toBe("yjs");
  });
});

describe("append", () => {
  test("seqs are dense and updatesSince pages from a cursor", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("a") });
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      seqs.push(
        await as.mutation(api.ydoc.append, {
          docId,
          update: encodedInsert(`x${i}`),
        }),
      );
    }
    expect(seqs).toEqual([2, 3, 4]);
    const tail = await as.query(api.ydoc.updatesSince, { docId, afterSeq: 2 });
    expect(tail.map((u) => u.seq)).toEqual([3, 4]);
  });

  test("a chunked append lands as one seq and reads back as one update", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("a") });

    // One oversized update — a drawn storyboard's accept — split for travel.
    const big = encodedInsert("x".repeat(UPDATE_CHUNK_BYTES * 2));
    const chunks = splitUpdate(new Uint8Array(big));
    expect(chunks.length).toBeGreaterThan(1);
    const seq = await as.mutation(api.ydoc.append, { docId, chunks });
    expect(seq).toBe(2);

    const rows = await as.query(api.ydoc.updatesSince, { docId, afterSeq: 1 });
    expect(rows.length).toBe(chunks.length);
    expect(rows.every((r) => r.seq === 2)).toBe(true);
    const joined = joinUpdateRows(rows);
    expect(joined).toHaveLength(1);
    expect(Buffer.from(joined[0].update)).toEqual(Buffer.from(new Uint8Array(big)));

    // The compactor folds the group whole: the doc rebuilt from the snapshot
    // holds the text the oversized update carried.
    await t.mutation(internal.ydoc.compact, { docId, targetSeq: seq });
    const meta = await as.query(api.ydoc.meta, { docId });
    const parts: ArrayBuffer[] = [];
    for (let part = 0; part < meta!.snapshotParts; part++) {
      const chunk = await as.query(api.ydoc.snapshot, {
        docId,
        gen: meta!.snapshotSeq,
        part,
      });
      parts.push(chunk!);
    }
    const whole = new Uint8Array(parts.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of parts) {
      whole.set(new Uint8Array(c), at);
      at += c.byteLength;
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, whole);
    expect(doc.getText("t").toString().length).toBe(UPDATE_CHUNK_BYTES * 2 + 1);
  });

  test("a log too heavy for one read comes back in pages", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("seed ") });
    const last = await fatLog(t, docId, 6);

    // The first page stops short of the log — this is the shape that used to
    // come back as one 16MiB read and killed the query, blanking the page.
    const page = await as.query(api.ydoc.updatesSince, { docId, afterSeq: 0 });
    expect(page.length).toBeLessThan(
      await t.run(async (ctx) =>
        (
          await ctx.db
            .query("yUpdates")
            .withIndex("by_doc_and_seq", (q) => q.eq("docId", docId))
            .collect()
        ).length,
      ),
    );
    // Whole updates only: the page never ends inside a chunk group.
    const tail = page[page.length - 1];
    expect(tail.parts === undefined || tail.part === tail.parts - 1).toBe(true);

    // And the client's loop — pull, apply, advance — still arrives at the
    // whole document, however many pages it takes.
    const doc = new Y.Doc();
    let cursor = 0;
    let pages = 0;
    while (cursor < last) {
      const rows = await as.query(api.ydoc.updatesSince, {
        docId,
        afterSeq: cursor,
      });
      expect(rows.length).toBeGreaterThan(0);
      pages++;
      for (const row of joinUpdateRows(rows)) {
        Y.applyUpdate(doc, row.update);
        cursor = Math.max(cursor, row.seq);
      }
    }
    expect(pages).toBeGreaterThan(1);
    // The replay lands on the document the writer left: the seed it started
    // from and the last rewrite, with the overwritten ones gone.
    const text = doc.getText("t").toString();
    expect(text).toContain("seed");
    expect(text).toContain("m5 ");
    expect(text).not.toContain("m0 ");
  });

  test("appending to a doc that was never made Yjs-native fails", async () => {
    const t = harness();
    const { docId } = await world(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.ydoc.append, {
        docId,
        update: encodedInsert("a"),
      }),
    ).rejects.toThrow("Not a Yjs document");
  });
});

describe("auth", () => {
  test("strangers and viewers cannot write; editors can", async () => {
    const t = harness();
    const { projectId, docId } = await world(t, {
      shareToken: "view-tok",
      editShareToken: "edit-tok",
    });
    await t
      .withIdentity(OWNER)
      .mutation(api.ydoc.init, { docId, update: encodedInsert("a") });

    const guest = t.withIdentity(GUEST);
    await expect(
      guest.mutation(api.ydoc.append, { docId, update: encodedInsert("x") }),
    ).rejects.toThrow("Not found");

    await claim(t, projectId, "viewer");
    await expect(
      guest.mutation(api.ydoc.append, { docId, update: encodedInsert("x") }),
    ).rejects.toThrow("Not found");

    // Promote the standing claim, the same one row the app's upsert keeps.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) =>
          q.eq("projectId", projectId).eq("granteeId", GUEST.subject),
        )
        .unique();
      await ctx.db.patch(row!._id, { role: "editor" });
    });
    await expect(
      guest.mutation(api.ydoc.append, { docId, update: encodedInsert("x") }),
    ).resolves.toBeTypeOf("number");
  });

  test("anonymous reads ride a live link and die with it", async () => {
    const t = harness();
    const { projectId, docId } = await world(t, { shareToken: "view-tok" });
    await t
      .withIdentity(OWNER)
      .mutation(api.ydoc.init, { docId, update: encodedInsert("a") });

    const tail = await t.query(api.ydoc.updatesSince, { docId, afterSeq: 0 });
    expect(tail).toHaveLength(1);

    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { shareToken: undefined });
    });
    await expect(
      t.query(api.ydoc.updatesSince, { docId, afterSeq: 0 }),
    ).rejects.toThrow("Not found");
  });
});

describe("compaction", () => {
  test("fold preserves the document and trims the log", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("seed ") });
    for (let i = 0; i < 5; i++) {
      await as.mutation(api.ydoc.append, {
        docId,
        update: encodedInsert(`w${i} `),
      });
    }

    await t.mutation(internal.ydoc.compact, { docId, targetSeq: 6 });

    const meta = await as.query(api.ydoc.meta, { docId });
    expect(meta).toMatchObject({ seq: 6, snapshotSeq: 6, snapshotParts: 1 });
    expect(await as.query(api.ydoc.updatesSince, { docId, afterSeq: 6 })).toEqual(
      [],
    );

    const chunk = await as.query(api.ydoc.snapshot, {
      docId,
      gen: 6,
      part: 0,
    });
    const rebuilt = new Y.Doc();
    Y.applyUpdate(rebuilt, new Uint8Array(chunk!));
    const words = rebuilt.getText("t").toString();
    for (const expected of ["seed", "w0", "w4"]) {
      expect(words).toContain(expected);
    }
  });

  test("a log too heavy for one fold is folded in passes", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("seed ") });
    const last = await fatLog(t, docId, 6);

    // One pass cannot reach the target — but it leaves a real snapshot, and
    // the passes it schedules carry the rest.
    await t.mutation(internal.ydoc.compact, { docId, targetSeq: last });
    const first = await as.query(api.ydoc.meta, { docId });
    expect(first!.snapshotSeq).toBeGreaterThan(0);
    expect(first!.snapshotSeq).toBeLessThan(last);

    // It carries itself: the pass that came up short schedules the next one.
    const queued = await t.run(async (ctx) =>
      await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(queued.some((f) => f.name.includes("compact"))).toBe(true);

    for (let pass = 0; pass < 12; pass++) {
      const meta = await as.query(api.ydoc.meta, { docId });
      if (meta!.snapshotSeq === last) break;
      await t.mutation(internal.ydoc.compact, { docId, targetSeq: last });
    }
    const meta = await as.query(api.ydoc.meta, { docId });
    expect(meta).toMatchObject({ seq: last, snapshotSeq: last });
    expect(
      await as.query(api.ydoc.updatesSince, { docId, afterSeq: 0 }),
    ).toEqual([]);

    // And the document the folds left behind is the document that was written.
    const text = (await rebuild(as, docId)).getText("t").toString();
    expect(text).toContain("seed");
    expect(text).toContain("m5 ");
  });

  test("a stale compact target is a no-op", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("a") });
    await t.mutation(internal.ydoc.compact, { docId, targetSeq: 1 });
    await t.mutation(internal.ydoc.compact, { docId, targetSeq: 1 });
    const meta = await as.query(api.ydoc.meta, { docId });
    expect(meta).toMatchObject({ snapshotSeq: 1, snapshotParts: 1 });
  });

  test("appends racing the fold stay readable through the cursor", async () => {
    const t = harness();
    const { docId } = await world(t);
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: encodedInsert("a ") });
    await as.mutation(api.ydoc.append, { docId, update: encodedInsert("b ") });
    // Fold only up to 1; the append at 2 must survive in the log.
    await t.mutation(internal.ydoc.compact, { docId, targetSeq: 1 });
    const meta = await as.query(api.ydoc.meta, { docId });
    expect(meta).toMatchObject({ seq: 2, snapshotSeq: 1 });
    const tail = await as.query(api.ydoc.updatesSince, { docId, afterSeq: 1 });
    expect(tail.map((u) => u.seq)).toEqual([2]);
  });
});
