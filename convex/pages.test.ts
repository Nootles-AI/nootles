/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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
