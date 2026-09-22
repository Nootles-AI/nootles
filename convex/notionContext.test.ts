/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The Notion connector's half of the graph, without Notion: linking queues a
 * read, a read's result lands as a searchable document, and unlinking takes it
 * away. The reader itself is never run here — it would go to the network.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const VIEWER = { subject: "user_viewer" };
const STRANGER = { subject: "user_stranger" };
const PAGE = "1f2e3d4c-5b6a-4789-8abc-def012345678";

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

async function project(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "Rover",
      shareToken: "view",
      createdAt: 1,
    });
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId: VIEWER.subject,
      role: "viewer",
      createdAt: 1,
    });
    return projectId;
  });
}

async function linked(t: TestConvex<typeof schema>) {
  const projectId = await project(t);
  const rowId = await t.run(
    async (ctx) =>
      await ctx.db.insert("projectNotion", {
        ownerId: OWNER.subject,
        projectId,
        pageId: PAGE,
        title: "Telemetry spec",
        url: `https://www.notion.so/${PAGE.replace(/-/g, "")}`,
        index: { state: "reading" },
        addedAt: 1,
      }),
  );
  return { projectId, rowId };
}

const TEXT =
  "Telemetry cadence\n\nThe rover reports its odometry every 250ms over the radio.\n\nFallback\n\nOn a dropped link it holds position.";

// Scheduled reads stay queued: under fake timers they never fire.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("linking", () => {
  test("inserts queued rows, and a page linked twice is linked once", async () => {
    const t = harness();
    const projectId = await project(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.notion.context.link, {
      projectId,
      pages: [
        { pageId: PAGE, title: "Telemetry spec", emoji: "📡" },
        { pageId: "abc", title: "Parts" },
        { pageId: "abc", title: "Parts" },
      ],
    });
    await owner.mutation(api.notion.context.link, {
      projectId,
      pages: [{ pageId: PAGE, title: "Telemetry spec" }],
    });

    const rows = await owner.query(api.notion.context.listForProject, { projectId });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.pageId === PAGE)).toMatchObject({
      ownerId: OWNER.subject,
      title: "Telemetry spec",
      emoji: "📡",
      url: "https://www.notion.so/1f2e3d4c5b6a47898abcdef012345678",
      index: { state: "queued" },
    });
    expect(rows.every((r) => r.index.state === "queued")).toBe(true);
  });

  test("only the owner links, or sees what is linked", async () => {
    const t = harness();
    const projectId = await project(t);
    for (const who of [VIEWER, STRANGER]) {
      await expect(
        t.withIdentity(who).mutation(api.notion.context.link, {
          projectId,
          pages: [{ pageId: PAGE, title: "Telemetry spec" }],
        }),
      ).rejects.toThrow();
      expect(
        await t.withIdentity(who).query(api.notion.context.listForProject, { projectId }),
      ).toEqual([]);
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("projectNotion").collect());
    expect(rows).toEqual([]);
  });

  test("a re-read is refused while one is waiting", async () => {
    const t = harness();
    const { rowId } = await linked(t);
    await t.withIdentity(OWNER).mutation(api.notion.context.reindex, { rowId });
    const row = await t.run(async (ctx) => await ctx.db.get(rowId));
    expect(row?.index.state).toBe("reading");
    await expect(
      t.withIdentity(VIEWER).mutation(api.notion.context.reindex, { rowId }),
    ).rejects.toThrow();
  });
});

describe("reading", () => {
  test("a read lands as a document node with its text", async () => {
    const t = harness();
    const { projectId, rowId } = await linked(t);
    await t.mutation(internal.notion.context.write, {
      rowId,
      title: "Telemetry spec v2",
      text: TEXT,
      headings: ["Telemetry cadence", "Fallback"],
    });

    const { node, text, row } = await t.run(async (ctx) => {
      const node = await ctx.db
        .query("contextNodes")
        .withIndex("by_project_and_externalId", (q) =>
          q.eq("projectId", projectId).eq("externalId", `notion:${PAGE}`),
        )
        .unique();
      const text =
        node &&
        (await ctx.db
          .query("contextNodeText")
          .withIndex("by_nodeId", (q) => q.eq("nodeId", node._id))
          .unique());
      return { node, text, row: await ctx.db.get(rowId) };
    });
    expect(node).toMatchObject({
      kind: "document",
      source: "notion",
      title: "Telemetry spec v2",
      url: `https://www.notion.so/${PAGE.replace(/-/g, "")}`,
      owner: { memberId: OWNER.subject },
    });
    expect(text?.body).toBe(TEXT);
    expect(text?.summary.startsWith("Sections: Telemetry cadence · Fallback")).toBe(true);
    expect(row).toMatchObject({
      title: "Telemetry spec v2",
      index: { state: "ready", chars: TEXT.length },
    });

    const found = await t
      .withIdentity(VIEWER)
      .query(api.context.read.search, { projectId, query: "odometry" });
    expect(found.map((f) => f.id)).toContain(node!._id);
  });

  test("a failed re-read keeps what the last one read", async () => {
    const t = harness();
    const { rowId } = await linked(t);
    await t.mutation(internal.notion.context.write, {
      rowId,
      title: "Telemetry spec",
      text: TEXT,
      headings: [],
    });
    await t.mutation(internal.notion.context.setIndex, {
      rowId,
      index: { state: "failed", error: "Notion cannot see that page." },
    });
    const row = await t.run(async (ctx) => await ctx.db.get(rowId));
    expect(row?.index).toMatchObject({
      state: "failed",
      error: "Notion cannot see that page.",
      chars: TEXT.length,
    });
    expect(row?.index.at).toBeTypeOf("number");
  });

  test("unlinking takes the row, the node and its text", async () => {
    const t = harness();
    const { projectId, rowId } = await linked(t);
    await t.mutation(internal.notion.context.write, {
      rowId,
      title: "Telemetry spec",
      text: TEXT,
      headings: [],
    });
    await expect(
      t.withIdentity(VIEWER).mutation(api.notion.context.unlink, { rowId }),
    ).rejects.toThrow();
    await t.withIdentity(OWNER).mutation(api.notion.context.unlink, { rowId });

    const left = await t.run(async (ctx) => ({
      row: await ctx.db.get(rowId),
      nodes: await ctx.db
        .query("contextNodes")
        .withIndex("by_project_and_externalId", (q) => q.eq("projectId", projectId))
        .collect(),
      texts: await ctx.db
        .query("contextNodeText")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    }));
    expect(left).toEqual({ row: null, nodes: [], texts: [] });
  });
});
