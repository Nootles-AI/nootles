/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { packTurn, unpackTurn } from "../app/lib/ai/review/pack";

/**
 * The purge cascade and the chat turns that edited a purged page: a turn that
 * also edited other pages keeps them, and nothing of the purged page — not
 * its ids, not its ops or hunks — stays behind in the row.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = "user_owner";
/** What a purged page's agent edit held — it must not outlive the page. */
const SECRET = "the purged page's words";

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type Stored = { pages?: Array<{ pageId: string }> };

/** A two-page turn as `ReviewSession.commit` stores one, packed or in the legacy plain form. */
async function twoPageTurn(t: TestConvex<typeof schema>, packed: boolean) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: OWNER, title: "P", createdAt: 1 });
    const page = (title: string, deletedAt?: number) =>
      ctx.db.insert("pages", {
        ownerId: OWNER,
        projectId,
        title,
        order: 0,
        docId: `doc-${title}-${packed}`,
        createdAt: 1,
        ...(deletedAt === undefined ? {} : { deletedAt }),
      });
    const kept = await page("Kept");
    // In the trash since the epoch: well past retention.
    const purged = await page("Purged", 1);
    const threadId = await ctx.db.insert("chatThreads", {
      ownerId: OWNER,
      projectId,
      title: "T",
      createdAt: 1,
      updatedAt: 1,
    });
    const checkpoint = (pageId: Id<"pages">) =>
      ctx.db.insert("checkpoints", { ownerId: OWNER, pageId, chatPromptId: "turn", docSnapshot: [], createdAt: 1 });
    const keptCheckpoint = await checkpoint(kept);
    const purgedCheckpoint = await checkpoint(purged);

    const trace = {
      pages: [
        { pageId: kept, checkpointId: keptCheckpoint, ops: [], trace: [], replacing: [], logged: true },
        {
          pageId: purged,
          checkpointId: purgedCheckpoint,
          ops: [{ kind: "insertBlocks", blocks: [{ type: "paragraph", content: SECRET }] }],
          trace: [],
          replacing: [],
          logged: true,
        },
      ],
    };
    const hunks = {
      pages: [
        { pageId: kept, hunks: [], status: {}, edited: [] },
        { pageId: purged, hunks: [{ id: "h1", text: SECRET }], status: {}, edited: [] },
      ],
    };
    const turnId = await ctx.db.insert("chatTurns", {
      ownerId: OWNER,
      threadId,
      projectId,
      chatPromptId: `turn-${packed}`,
      pageIds: [kept, purged],
      checkpointIds: [keptCheckpoint, purgedCheckpoint],
      trace: packed ? await packTurn(trace) : trace,
      hunks: packed ? await packTurn(hunks) : hunks,
      status: "pending",
      createdAt: 1,
    });
    return { turnId, kept, keptCheckpoint };
  });
}

describe("purging a page", () => {
  for (const packed of [true, false]) {
    test(`drops it from a ${packed ? "packed" : "plain (pre-packing)"} two-page turn, blobs and ids alike`, async () => {
      const t = harness();
      const { turnId, kept, keptCheckpoint } = await twoPageTurn(t, packed);

      await t.mutation(internal.trash.purge, {});

      const row = await t.run((ctx) => ctx.db.get(turnId));
      expect(row).not.toBeNull();
      expect(row!.pageIds).toEqual([kept]);
      expect(row!.checkpointIds).toEqual([keptCheckpoint]);

      const trace = await unpackTurn<Stored>(row!.trace);
      const hunks = await unpackTurn<Stored>(row!.hunks);
      expect(trace.pages?.map((p) => p.pageId)).toEqual([kept]);
      expect(hunks.pages?.map((p) => p.pageId)).toEqual([kept]);
      expect(JSON.stringify([trace, hunks])).not.toContain(SECRET);
      // A packed row stays packed: the client reads it through unpackTurn,
      // and packing is what keeps a drawn board under the value ceiling.
      expect(row!.trace instanceof ArrayBuffer).toBe(packed);
      expect(row!.hunks instanceof ArrayBuffer).toBe(packed);
    });
  }
});

type Entry = { pageId: Id<"pages">; checkpointId: Id<"checkpoints">; secret?: boolean };

/** `trace` and `hunks` for these pages, as `ReviewSession.commit` stores them. */
async function blobs(entries: Entry[], packed: boolean) {
  const trace = {
    pages: entries.map((e) => ({
      pageId: e.pageId,
      checkpointId: e.checkpointId,
      ops: e.secret ? [{ kind: "insertBlocks", blocks: [{ type: "paragraph", content: SECRET }] }] : [],
      trace: [],
      replacing: [],
      logged: true,
    })),
  };
  const hunks = {
    pages: entries.map((e) => ({
      pageId: e.pageId,
      hunks: e.secret ? [{ id: `h-${e.pageId}`, text: SECRET }] : [],
      status: {},
      edited: [],
    })),
  };
  return packed
    ? { trace: await packTurn(trace), hunks: await packTurn(hunks) }
    : { trace, hunks };
}

/**
 * The rows a purge before the fix left behind, beside rows it must not touch.
 * The deleted page's row and checkpoint are gone, as the purge deleted them.
 */
async function leftovers(t: TestConvex<typeof schema>, packed: boolean) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: OWNER, title: "P", createdAt: 1 });
    const page = (title: string, deletedAt?: number) =>
      ctx.db.insert("pages", {
        ownerId: OWNER,
        projectId,
        title,
        order: 0,
        docId: `doc-${title}`,
        createdAt: 1,
        ...(deletedAt === undefined ? {} : { deletedAt }),
      });
    const kept = await page("Kept");
    const gone = await page("Gone");
    // In the trash, not purged: it can still be restored.
    const trashed = await page("Trashed", Date.now());
    const threadId = await ctx.db.insert("chatThreads", { ownerId: OWNER, projectId, title: "T", createdAt: 1, updatedAt: 1 });
    const checkpoint = (pageId: Id<"pages">) =>
      ctx.db.insert("checkpoints", { ownerId: OWNER, pageId, chatPromptId: "turn", docSnapshot: [], createdAt: 1 });
    const c = { kept: await checkpoint(kept), gone: await checkpoint(gone), trashed: await checkpoint(trashed) };
    const E = {
      kept: { pageId: kept, checkpointId: c.kept },
      gone: { pageId: gone, checkpointId: c.gone, secret: true },
      trashed: { pageId: trashed, checkpointId: c.trashed },
    };

    const turn = async (
      name: string,
      ids: Entry[],
      inBlobs: Entry[],
      status: Doc<"chatTurns">["status"] = "pending",
    ) =>
      await ctx.db.insert("chatTurns", {
        ownerId: OWNER,
        threadId,
        projectId,
        chatPromptId: name,
        pageIds: ids.map((e) => e.pageId),
        checkpointIds: ids.map((e) => e.checkpointId),
        ...(await blobs(inBlobs, packed)),
        status,
        createdAt: 1,
      });
    const turns = {
      // What the purge left: ids clean, the page still inside both blobs.
      inBlobs: await turn("in-blobs", [E.kept], [E.kept, E.gone]),
      // Then answered on reload: the page's ids written back, the turn failed.
      writtenBack: await turn("written-back", [E.kept, E.gone], [E.kept, E.gone], "failed"),
      // Its only page gone.
      onlyGone: await turn("only-gone", [E.gone], [E.gone]),
      trashed: await turn("trashed", [E.kept, E.trashed], [E.kept, E.trashed]),
      healthy: await turn("healthy", [E.kept], [E.kept]),
    };

    await ctx.db.delete(c.gone);
    await ctx.db.delete(gone);
    return { turns, kept, keptCheckpoint: c.kept };
  });
}

const bytesOf = (value: unknown) =>
  value instanceof ArrayBuffer ? Array.from(new Uint8Array(value)) : value;

describe("forgetting deleted pages in turns the purge once left behind", () => {
  test("the preview names the turns to clean, and which of them go", async () => {
    const t = harness();
    await leftovers(t, true);

    const preview = await t.query(internal.migrations.forgetDeletedTurnPagesPreview, {});
    expect(preview).toMatchObject({ seen: 5, done: true, cursor: null });
    expect(
      preview.affected.map((a) => [a.chatPromptId, a.gone, a.deletesTurn]).sort(),
    ).toEqual([
      ["in-blobs", 1, false],
      ["only-gone", 1, true],
      ["written-back", 1, false],
    ]);
  });

  for (const packed of [true, false]) {
    test(`cleans ${packed ? "packed" : "plain"} rows, deletes the emptied turn, and touches nothing else`, async () => {
      const t = harness();
      const { turns, kept, keptCheckpoint } = await leftovers(t, packed);
      const untouched = await t.run(async (ctx) => ({
        trashed: await ctx.db.get(turns.trashed),
        healthy: await ctx.db.get(turns.healthy),
      }));

      expect(await t.mutation(internal.migrations.forgetDeletedTurnPages, {})).toMatchObject({
        seen: 5,
        patched: 2,
        deleted: 1,
        done: true,
      });

      const rows = await t.run(async (ctx) => ({
        inBlobs: await ctx.db.get(turns.inBlobs),
        writtenBack: await ctx.db.get(turns.writtenBack),
        onlyGone: await ctx.db.get(turns.onlyGone),
        trashed: await ctx.db.get(turns.trashed),
        healthy: await ctx.db.get(turns.healthy),
      }));
      expect(rows.onlyGone).toBeNull();
      for (const row of [rows.inBlobs!, rows.writtenBack!]) {
        expect(row.pageIds).toEqual([kept]);
        expect(row.checkpointIds).toEqual([keptCheckpoint]);
        const trace = await unpackTurn<Stored>(row.trace);
        const hunks = await unpackTurn<Stored>(row.hunks);
        expect(trace.pages?.map((p) => p.pageId)).toEqual([kept]);
        expect(hunks.pages?.map((p) => p.pageId)).toEqual([kept]);
        expect(JSON.stringify([trace, hunks])).not.toContain(SECRET);
        expect(row.trace instanceof ArrayBuffer).toBe(packed);
      }
      expect(rows.writtenBack!.status).toBe("failed");
      for (const name of ["trashed", "healthy"] as const) {
        expect(rows[name]!.pageIds).toEqual(untouched[name]!.pageIds);
        expect(bytesOf(rows[name]!.trace)).toEqual(bytesOf(untouched[name]!.trace));
        expect(bytesOf(rows[name]!.hunks)).toEqual(bytesOf(untouched[name]!.hunks));
      }

      // Idempotent: a second pass finds nothing gone.
      expect(await t.mutation(internal.migrations.forgetDeletedTurnPages, {})).toMatchObject({
        seen: 4,
        patched: 0,
        deleted: 0,
        done: true,
      });
      expect((await t.query(internal.migrations.forgetDeletedTurnPagesPreview, {})).affected).toEqual([]);
    });
  }

  test("pages through a table larger than one batch with the returned cursor", async () => {
    const t = harness();
    const { turns } = await leftovers(t, true);
    const threadAndProject = await t.run(async (ctx) => {
      const row = (await ctx.db.get(turns.healthy))!;
      return { threadId: row.threadId, projectId: row.projectId, pageIds: row.pageIds, checkpointIds: row.checkpointIds, trace: row.trace, hunks: row.hunks };
    });
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("chatTurns", {
          ownerId: OWNER,
          chatPromptId: `filler-${i}`,
          status: "accepted",
          createdAt: 2,
          ...threadAndProject,
        });
      }
    });

    let cursor: string | undefined;
    let calls = 0;
    const total = { seen: 0, patched: 0, deleted: 0 };
    for (;;) {
      const result = await t.mutation(internal.migrations.forgetDeletedTurnPages, cursor ? { cursor } : {});
      calls += 1;
      total.seen += result.seen;
      total.patched += result.patched;
      total.deleted += result.deleted;
      if (result.done) break;
      cursor = result.cursor!;
    }
    expect(calls).toBeGreaterThan(1);
    expect(total).toEqual({ seen: 45, patched: 2, deleted: 1 });
  });
});
