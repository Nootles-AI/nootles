/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { PageDigest } from "./context/shape";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The pages connector and the reads over it: a writer's digest becomes a node,
 * its text and its mention edges; a viewer's is declined and unreviewed AI
 * text is held back; everyone on the project reads the whole graph, owners
 * included; and a page purged for good leaves nothing behind.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const EDITOR = { subject: "user_editor" };
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
      title: "Rover",
      shareToken: "view",
      editShareToken: "edit",
      createdAt: 1,
    });
    const page = (title: string, order: number, createdBy?: string) =>
      ctx.db.insert("pages", {
        ownerId: OWNER.subject,
        ...(createdBy ? { createdBy } : {}),
        projectId,
        title,
        order,
        docId: `doc-${title}`,
        createdAt: 1,
      });
    const spec = await page("Spec", 0);
    const firmware = await page("Firmware", 1, EDITOR.subject);
    const notes = await page("Notes", 2);
    for (const [who, role] of [
      [EDITOR, "editor"],
      [VIEWER, "viewer"],
    ] as const) {
      await ctx.db.insert("shareClaims", {
        projectId,
        granteeId: who.subject,
        role,
        createdAt: 1,
      });
    }
    await ctx.db.insert("profiles", {
      ownerId: EDITOR.subject,
      name: "Eda",
      status: "done",
      createdAt: 1,
    });
    await ctx.db.insert("contextSheet", {
      ownerId: OWNER.subject,
      projectId,
      question: "What is this project?",
      answer: "A teleoperated rover.",
      source: "human",
      createdAt: 1,
    });
    return { projectId, spec, firmware, notes };
  });
}

const digest = (over: Partial<PageDigest> = {}): PageDigest => ({
  brief: "The watchdog stops the rover.",
  summary: "Sections: Watchdog",
  terms: "Watchdog\nThe watchdog stops the rover within 300 ms.",
  mentions: [],
  contentHash: `h-${Math.random()}`,
  ...over,
});

describe("the pages connector", () => {
  test("a writer's digest becomes a node, its text and its mention edges", async () => {
    const t = harness();
    const { projectId, spec, firmware } = await world(t);
    const editor = t.withIdentity(EDITOR);

    expect(
      await editor.mutation(api.context.pages.digest, {
        docId: "doc-Firmware",
        digest: digest({ mentions: [spec, spec, firmware, "not-an-id"] }),
      }),
    ).toBe(true);

    const pack = await t
      .withIdentity(VIEWER)
      .query(api.context.read.packInputs, { projectId, pageId: firmware });
    expect(pack?.pages.find((p) => p.pageId === firmware)?.brief).toBe(
      "The watchdog stops the rover.",
    );
    // Repeats and self-mentions collapse; a junk id is no page.
    expect(pack?.links).toEqual({ out: [spec], in: [] });
    expect(pack?.notes).toEqual([
      { question: "What is this project?", answer: "A teleoperated rover." },
    ]);

    const fromSpec = await editor.query(api.context.read.expand, { projectId, id: spec });
    expect(fromSpec?.links.map((l) => [l.relation, l.title, l.owner])).toEqual([
      ["mentioned by", "Firmware", "Eda"],
    ]);
  });

  test("an unchanged digest writes nothing, and a dropped mention is retired", async () => {
    const t = harness();
    const { projectId, spec, firmware } = await world(t);
    const owner = t.withIdentity(OWNER);
    const first = digest({ mentions: [spec] });
    await owner.mutation(api.context.pages.digest, { docId: "doc-Firmware", digest: first });
    expect(
      await owner.mutation(api.context.pages.digest, { docId: "doc-Firmware", digest: first }),
    ).toBe(true);

    await owner.mutation(api.context.pages.digest, {
      docId: "doc-Firmware",
      digest: digest({ mentions: [] }),
    });
    const edges = await t.run((ctx) => ctx.db.query("contextEdges").collect());
    expect(edges).toHaveLength(1);
    expect(edges[0].expiredAt).toBeTypeOf("number");
    const pack = await owner.query(api.context.read.packInputs, { projectId, pageId: firmware });
    expect(pack?.links).toEqual({ out: [], in: [] });
  });

  test("a viewer's digest and a stranger's are declined", async () => {
    const t = harness();
    await world(t);
    for (const who of [VIEWER, STRANGER]) {
      expect(
        await t
          .withIdentity(who)
          .mutation(api.context.pages.digest, { docId: "doc-Spec", digest: digest() }),
      ).toBe(false);
    }
    expect(await t.run((ctx) => ctx.db.query("contextNodes").collect())).toEqual([]);
  });

  test("a page an AI turn edited is held back until the review settles", async () => {
    const t = harness();
    const { projectId, spec } = await world(t);
    const turnId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("chatThreads", {
        ownerId: OWNER.subject,
        projectId,
        title: "T",
        createdAt: 1,
        updatedAt: 1,
      });
      return await ctx.db.insert("chatTurns", {
        ownerId: OWNER.subject,
        threadId,
        projectId,
        chatPromptId: "turn",
        pageIds: [spec],
        checkpointIds: [],
        trace: null,
        hunks: null,
        status: "pending",
        createdAt: 1,
      });
    });
    const owner = t.withIdentity(OWNER);
    const offered = digest();
    expect(
      await owner.mutation(api.context.pages.digest, { docId: "doc-Spec", digest: offered }),
    ).toBe(false);

    await t.run((ctx) => ctx.db.patch(turnId, { status: "accepted" }));
    expect(
      await owner.mutation(api.context.pages.digest, { docId: "doc-Spec", digest: offered }),
    ).toBe(true);
  });

  test("a digest past the limits is refused", async () => {
    const t = harness();
    await world(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.context.pages.digest, {
        docId: "doc-Spec",
        digest: digest({ brief: "x".repeat(500) }),
      }),
    ).rejects.toThrow("Digest too large");
  });
});

describe("reading the graph", () => {
  test("search finds a page by its words, not only its title, and says whose it is", async () => {
    const t = harness();
    const { projectId, firmware } = await world(t);
    await t
      .withIdentity(EDITOR)
      .mutation(api.context.pages.digest, { docId: "doc-Firmware", digest: digest() });

    const found = await t
      .withIdentity(VIEWER)
      .query(api.context.read.search, { projectId, query: "watchdog" });
    expect(found.map((f) => [f.pageId, f.title, f.owner])).toEqual([
      [firmware, "Firmware", "Eda"],
    ]);
    expect(
      await t.withIdentity(STRANGER).query(api.context.read.search, { projectId, query: "watchdog" }),
    ).toEqual([]);
  });

  test("a rename reads through at once, and search follows it", async () => {
    const t = harness();
    const { projectId, firmware } = await world(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.context.pages.digest, { docId: "doc-Firmware", digest: digest() });
    await owner.mutation(api.pages.rename, { pageId: firmware, title: "Teleop safety" });

    const read = await owner.query(api.context.read.read, { projectId, id: firmware });
    expect(read?.title).toBe("Teleop safety");
    expect(read?.summary).toBe("Sections: Watchdog");
    const found = await owner.query(api.context.read.search, { projectId, query: "teleop" });
    expect(found.map((f) => f.pageId)).toEqual([firmware]);
  });

  test("a page in the trash is not context; purged, it leaves nothing behind", async () => {
    const t = harness();
    const { projectId, spec, firmware } = await world(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.context.pages.digest, {
      docId: "doc-Firmware",
      digest: digest({ mentions: [spec] }),
    });
    await owner.mutation(api.pages.remove, { pageId: firmware });

    expect(await owner.query(api.context.read.search, { projectId, query: "watchdog" })).toEqual(
      [],
    );
    expect(await owner.query(api.context.read.read, { projectId, id: firmware })).toBeNull();

    await t.run((ctx) => ctx.db.patch(firmware, { deletedAt: 1 }));
    await t.mutation(internal.trash.purge, {});
    const left = await t.run(async (ctx) => ({
      edges: await ctx.db.query("contextEdges").collect(),
      text: await ctx.db.query("contextNodeText").collect(),
      nodes: (await ctx.db.query("contextNodes").collect()).map((n) => n.externalId),
    }));
    expect(left.edges).toEqual([]);
    expect(left.nodes).toEqual([spec]);
    expect(left.text).toHaveLength(1);
  });

  test("the backfill gives every live page a title node, once", async () => {
    const t = harness();
    const { projectId, notes } = await world(t);
    await t.run((ctx) => ctx.db.patch(notes, { deletedAt: 1 }));
    await t.mutation(internal.migrations.contextPageNodes, {});
    await t.mutation(internal.migrations.contextPageNodes, {});
    const nodes = await t.run((ctx) => ctx.db.query("contextNodes").collect());
    expect(nodes.map((n) => [n.title, n.owner.memberId]).sort()).toEqual([
      ["Firmware", EDITOR.subject],
      ["Spec", OWNER.subject],
    ]);
    const found = await t
      .withIdentity(OWNER)
      .query(api.context.read.search, { projectId, query: "spec" });
    expect(found.map((f) => f.title)).toEqual(["Spec"]);
  });

  test("an id the model got wrong is no node", async () => {
    const t = harness();
    const { projectId } = await world(t);
    const other = await t.run((ctx) =>
      ctx.db.insert("projects", { ownerId: OWNER.subject, title: "Other", createdAt: 1 }),
    );
    const owner = t.withIdentity(OWNER);
    for (const id of ["nonsense", other as Id<"projects"> as string]) {
      expect(await owner.query(api.context.read.expand, { projectId, id })).toBeNull();
    }
  });
});
