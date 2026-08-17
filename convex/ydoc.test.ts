/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
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
