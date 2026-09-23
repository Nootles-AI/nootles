/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { channelAdmits, type DocChannel, type ProjectRole } from "./auth";
import { recordAudit } from "./audit";
import { commentsEnabled, PLAN_FEATURES } from "./entitlements";
import { removePageCascade } from "./pages";
import { purgeProject } from "./projects";
import { pageAndChannelForDoc } from "./prosemirror";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import { joinUpdateRows } from "./yshape";
import { decodeNmlDocument, executeNmlCommands, type NmlBlock } from "@/app/lib/nml";
import { threadsOf } from "@/app/lib/comments/types";

/**
 * The comments channel (docs/commenting-plan.md §5): a page's second Yjs
 * document, gated by WHICH INDEX a docId matched rather than by anything the
 * caller says. Every test builds the same small world — an owner's project
 * with one page and whatever links a case needs — and asks who may do what on
 * each of the page's two documents.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const EDITOR = { subject: "user_editor" };
const VIEWER = { subject: "user_viewer" };
const COMMENTER = { subject: "user_commenter" };
const STRANGER = { subject: "user_stranger" };
/** The owner's own subject, carried by an operator's stand-in token. */
const STAND_IN = { subject: OWNER.subject, act: "operator_1" };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type World = {
  projectId: Id<"projects">;
  pageId: Id<"pages">;
  docId: string;
};

/** An owner's project with one page; editor and viewer claims ride live links. */
async function world(
  t: TestConvex<typeof schema>,
  links: { shareToken?: string; editShareToken?: string } = {
    shareToken: "view-tok",
    editShareToken: "edit-tok",
  },
): Promise<World> {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
      updatedAt: 1,
      ...links,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "Plan",
      order: 0,
      docId,
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("shareClaims", { projectId, granteeId: EDITOR.subject, role: "editor", createdAt: 1 });
    await ctx.db.insert("shareClaims", { projectId, granteeId: VIEWER.subject, role: "viewer", createdAt: 1 });
    return { projectId, pageId, docId };
  });
}

async function mint(t: TestConvex<typeof schema>, w: World): Promise<string> {
  return await t.withIdentity(OWNER).mutation(api.comments.ensureDoc, { pageId: w.pageId });
}

function bytes(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

function textUpdate(text: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  return bytes(Y.encodeStateAsUpdate(doc));
}

/** Everything stored for a doc, rebuilt into a fresh Y.Doc. */
async function stored(t: TestConvex<typeof schema>, docId: string): Promise<Y.Doc> {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) => q.eq("docId", docId))
      .collect(),
  );
  const doc = new Y.Doc();
  for (const row of joinUpdateRows(rows)) Y.applyUpdate(doc, new Uint8Array(row.update));
  return doc;
}

const ROLES: Array<ProjectRole | null> = [null, "viewer", "commenter", "editor", "owner"];

describe("channelAdmits — the whole rule, without a database", () => {
  const cases: Array<[DocChannel, "read" | "write", ProjectRole | null, boolean, boolean]> = [];
  // [channel, access, role, linkLive, expected]
  for (const linkLive of [false, true]) {
    for (const role of ROLES) {
      cases.push(["document", "read", role, linkLive, role !== null || linkLive]);
      cases.push(["comments", "read", role, linkLive, role !== null]);
      cases.push(["document", "write", role, linkLive, role === "editor" || role === "owner"]);
      cases.push([
        "comments",
        "write",
        role,
        linkLive,
        role === "commenter" || role === "editor" || role === "owner",
      ]);
    }
  }
  test.each(cases)("%s %s as %s (link live: %s) → %s", (channel, access, role, linkLive, expected) => {
    expect(channelAdmits({ channel, access, role, linkLive })).toBe(expected);
  });

  test("a commenter writes the comments and never the page", () => {
    expect(channelAdmits({ channel: "comments", access: "write", role: "commenter", linkLive: true })).toBe(true);
    expect(channelAdmits({ channel: "document", access: "write", role: "commenter", linkLive: true })).toBe(false);
  });

  test("a signed-out link visitor reads the page and not its comments", () => {
    expect(channelAdmits({ channel: "document", access: "read", role: null, linkLive: true })).toBe(true);
    expect(channelAdmits({ channel: "comments", access: "read", role: null, linkLive: true })).toBe(false);
  });
});

describe("pageAndChannelForDoc — the channel is the index that matched", () => {
  test("the page's docId is the document channel, its commentsDocId the comments channel", async () => {
    const t = harness();
    const w = await world(t);
    const commentsDocId = await mint(t, w);
    const [page, comments, neither] = await t.run(async (ctx) => [
      await pageAndChannelForDoc(ctx, w.docId),
      await pageAndChannelForDoc(ctx, commentsDocId),
      await pageAndChannelForDoc(ctx, crypto.randomUUID()),
    ]);
    expect(page?.channel).toBe("document");
    expect(page?.page._id).toBe(w.pageId);
    expect(comments?.channel).toBe("comments");
    expect(comments?.page._id).toBe(w.pageId);
    expect(neither).toBeNull();
  });

  test("a docId cannot be spelled into the comments channel", async () => {
    const t = harness();
    const w = await world(t);
    const commentsDocId = await mint(t, w);
    const spellings = [
      `${w.docId}:comments`,
      `comments:${w.docId}`,
      commentsDocId.toUpperCase(),
      ` ${commentsDocId}`,
      "",
    ];
    const found = await t.run(async (ctx) =>
      Promise.all(spellings.map((id) => pageAndChannelForDoc(ctx, id))),
    );
    expect(found).toEqual(spellings.map(() => null));
  });
});

describe("ensureDoc", () => {
  test("mints once, born holding an empty comments document", async () => {
    const t = harness();
    const w = await world(t);
    const first = await mint(t, w);
    const again = await mint(t, w);
    expect(again).toBe(first);

    const { page, ydocs, updates } = await t.run(async (ctx) => ({
      page: await ctx.db.get(w.pageId),
      ydocs: await ctx.db
        .query("ydocs")
        .withIndex("by_doc", (q) => q.eq("docId", first))
        .collect(),
      updates: await ctx.db
        .query("yUpdates")
        .withIndex("by_doc_and_seq", (q) => q.eq("docId", first))
        .collect(),
    }));
    expect(page?.commentsDocId).toBe(first);
    expect(ydocs).toHaveLength(1);
    expect(ydocs[0].seq).toBe(1);
    expect(updates.map((u) => u.seq)).toEqual([1]);

    const document = decodeNmlDocument(await stored(t, first));
    expect(document).toEqual({ schemaVersion: 1, documentId: first, kind: "comments", blocks: [] });
    // The page's own document is untouched by any of it.
    expect(page?.yjs).toBeUndefined();
    expect(page?.updatedAt).toBe(1);
  });

  test("two first comments racing converge on one document", async () => {
    const t = harness();
    const w = await world(t);
    const [a, b] = await Promise.all([
      t.withIdentity(OWNER).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
      t.withIdentity(EDITOR).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ]);
    expect(a).toBe(b);
    const rows = await t.run(async (ctx) => ctx.db.query("ydocs").collect());
    expect(rows.map((r) => r.docId)).toEqual([a]);
  });

  test("owner and editor may mint; viewer, stranger and the signed-out may not", async () => {
    const t = harness();
    const w = await world(t);
    await expect(
      t.withIdentity(EDITOR).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).resolves.toBeTypeOf("string");
    for (const who of [VIEWER, STRANGER]) {
      await expect(
        t.withIdentity(who).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
      ).rejects.toThrow("Not found");
    }
    await expect(t.mutation(api.comments.ensureDoc, { pageId: w.pageId })).rejects.toThrow("Not found");
  });

  test("an operator standing in is refused, as read-only", async () => {
    const t = harness();
    const w = await world(t);
    await expect(
      t.withIdentity(STAND_IN).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow(/Read-only/);
    const page = await t.run(async (ctx) => ctx.db.get(w.pageId));
    expect(page?.commentsDocId).toBeUndefined();
  });

  test("a trashed page or project has no comments to start", async () => {
    const t = harness();
    const a = await world(t);
    await t.run(async (ctx) => ctx.db.patch(a.pageId, { deletedAt: 5 }));
    await expect(mint(t, a)).rejects.toThrow("Not found");

    const b = await world(t);
    await t.run(async (ctx) => ctx.db.patch(b.projectId, { deletedAt: 5 }));
    await expect(mint(t, b)).rejects.toThrow("Not found");
  });

  test("a commenter claim with its link off is only a viewer (fails closed)", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) =>
      ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: COMMENTER.subject, role: "commenter", createdAt: 1 }),
    );
    await expect(
      t.withIdentity(COMMENTER).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow("Not found");
    expect(await t.withIdentity(COMMENTER).query(api.projects.myRole, { projectId: w.projectId })).toBe("viewer");
  });
});

describe("docFor", () => {
  test("null until minted, then the id for every signed-in role", async () => {
    const t = harness();
    const w = await world(t);
    expect(await t.withIdentity(OWNER).query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
    const id = await mint(t, w);
    for (const who of [OWNER, EDITOR, VIEWER, STAND_IN]) {
      expect(await t.withIdentity(who).query(api.comments.docFor, { pageId: w.pageId })).toBe(id);
    }
  });

  test("strangers and signed-out link visitors learn nothing", async () => {
    const t = harness();
    const w = await world(t);
    await mint(t, w);
    expect(await t.withIdentity(STRANGER).query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
    expect(await t.query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
  });

  test("a trashed page answers null", async () => {
    const t = harness();
    const w = await world(t);
    await mint(t, w);
    await t.run(async (ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    expect(await t.withIdentity(OWNER).query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
  });
});

describe("the comments channel on the Yjs pipeline", () => {
  const read = async (t: TestConvex<typeof schema>, who: object | null, docId: string) => {
    const as = who ? t.withIdentity(who) : t;
    return await Promise.all([
      as.query(api.ydoc.meta, { docId }),
      as.query(api.ydoc.load, { docId, afterSeq: 0 }),
      as.query(api.ydoc.updatesSince, { docId, afterSeq: 0 }),
      as.query(api.ydoc.snapshot, { docId, gen: 0, part: 0 }),
      as.query(api.ydoc.state, { docId }),
    ]);
  };

  test("owner, editor, viewer and a stand-in read it", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    for (const who of [OWNER, EDITOR, VIEWER, STAND_IN]) {
      const [meta, load, since, snapshot, state] = await read(t, who, docId);
      expect(meta?.seq).toBe(1);
      expect(load?.updates).toHaveLength(1);
      expect(since).toHaveLength(1);
      expect(snapshot).toBeNull();
      expect(state).toBe("yjs");
    }
  });

  test("a stranger is refused, and so is a signed-out visitor holding every link", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await expect(read(t, STRANGER, docId)).rejects.toThrow("Not found");
    await expect(read(t, null, docId)).rejects.toThrow("Not found");
    // The same visitor still reads the PAGE through the link — that door is unchanged.
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });
    await expect(t.query(api.ydoc.meta, { docId: w.docId })).resolves.toMatchObject({ seq: 1 });
  });

  test("owner and editor write it; viewer, stranger and the signed-out cannot", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await expect(
      t.withIdentity(OWNER).mutation(api.ydoc.append, { docId, update: textUpdate("o") }),
    ).resolves.toBe(2);
    await expect(
      t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId, update: textUpdate("e") }),
    ).resolves.toBe(3);
    for (const who of [VIEWER, STRANGER]) {
      await expect(
        t.withIdentity(who).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
      ).rejects.toThrow("Not found");
    }
    await expect(t.mutation(api.ydoc.append, { docId, update: textUpdate("x") })).rejects.toThrow("Not found");
  });

  test("an operator standing in is refused on both channels", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });
    for (const id of [docId, w.docId]) {
      await expect(
        t.withIdentity(STAND_IN).mutation(api.ydoc.append, { docId: id, update: textUpdate("x") }),
      ).rejects.toThrow(/Read-only/);
    }
  });

  test("trashing the page or its project closes the channel", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.run(async (ctx) => ctx.db.patch(w.pageId, { deletedAt: 5 }));
    await expect(read(t, OWNER, docId)).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(OWNER).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
    await t.run(async (ctx) => {
      await ctx.db.patch(w.pageId, { deletedAt: undefined });
      await ctx.db.patch(w.projectId, { deletedAt: 5 });
    });
    await expect(read(t, OWNER, docId)).rejects.toThrow("Not found");
  });

  test("revoking every link closes it to claimants but not the owner", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.run(async (ctx) => ctx.db.patch(w.projectId, { shareToken: undefined, editShareToken: undefined }));
    await expect(read(t, VIEWER, docId)).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
    await expect(read(t, OWNER, docId)).resolves.toHaveLength(5);
  });

  test("a thread written is not the page edited: no page stamps", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    for (let i = 0; i < 3; i++) {
      await t.withIdentity(OWNER).mutation(api.ydoc.append, { docId, update: textUpdate(`c${i}`) });
    }
    const { page, project } = await t.run(async (ctx) => ({
      page: await ctx.db.get(w.pageId),
      project: await ctx.db.get(w.projectId),
    }));
    expect(page?.updatedAt).toBe(1);
    expect(page?.yjs).toBeUndefined();
    expect(project?.updatedAt).toBe(1);
  });

  test("init is the document channel's alone — a comments doc is never re-born", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await expect(
      t.withIdentity(OWNER).mutation(api.ydoc.init, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
  });

  test("a commenter claim with its link off reads both channels and writes neither", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });
    await t.run(async (ctx) =>
      ctx.db.insert("shareClaims", { projectId: w.projectId, granteeId: COMMENTER.subject, role: "commenter", createdAt: 1 }),
    );
    await expect(read(t, COMMENTER, docId)).resolves.toHaveLength(5);
    for (const id of [docId, w.docId]) {
      await expect(
        t.withIdentity(COMMENTER).mutation(api.ydoc.append, { docId: id, update: textUpdate("x") }),
      ).rejects.toThrow("Not found");
    }
  });

  test("an identity that may write the comments is still refused the page's own docId", async () => {
    // Every identity pointed at the PAGE docId is judged by the document
    // channel's rule. The same test with a commenter who claimed a live comment
    // link, end to end, is in `commenter.test.ts`.
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });
    await expect(
      t.withIdentity(VIEWER).mutation(api.ydoc.append, { docId: w.docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
    await expect(
      t.withIdentity(VIEWER).mutation(api.ydoc.append, { docId, update: textUpdate("x") }),
    ).rejects.toThrow("Not found");
    // The channel an append lands on is decided by the id, never by who asks.
    const channels = await t.run(async (ctx) => [
      (await pageAndChannelForDoc(ctx, w.docId))?.channel,
      (await pageAndChannelForDoc(ctx, docId))?.channel,
    ]);
    expect(channels).toEqual(["document", "comments"]);
  });
});

describe("pipelines that serve only the page refuse a comments docId", () => {
  test("presence: no heartbeat, list or roster", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    const as = t.withIdentity(OWNER);
    // A heartbeat is declined without a throw — it writes nothing either way.
    expect(
      await as.mutation(api.presence.heartbeat, {
        docId,
        sessionId: "s1",
        clientId: 1,
        user: { name: "O", color: "#000000" },
        state: new ArrayBuffer(1),
      }),
    ).toBeNull();
    await expect(as.query(api.presence.list, { docId })).rejects.toThrow("Not found");
    await expect(as.query(api.presence.roster, { docId })).rejects.toThrow("Not found");
    const rows = await t.run(async (ctx) => ctx.db.query("presence").collect());
    expect(rows).toHaveLength(0);
  });

  test("presence: a tab whose links were just turned off has its last heartbeat declined, not thrown", async () => {
    const t = harness();
    const w = await world(t);
    const beat = () =>
      t.withIdentity(VIEWER).mutation(api.presence.heartbeat, {
        docId: w.docId,
        sessionId: "s_viewer",
        clientId: 7,
        user: { name: "V", color: "#000000" },
        state: new ArrayBuffer(1),
      });
    expect(await beat()).toBeNull();
    await t.run((ctx) => ctx.db.patch(w.projectId, { shareToken: undefined, editShareToken: undefined }));
    const before = await t.run(async (ctx) => (await ctx.db.query("presence").unique())!.updatedAt);
    expect(await beat()).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query("presence").unique())!.updatedAt)).toBe(before);
    await expect(t.withIdentity(VIEWER).query(api.presence.list, { docId: w.docId })).rejects.toThrow("Not found");
  });

  test("previews: nothing to read, and an offer is quietly declined", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    const as = t.withIdentity(OWNER);
    await expect(as.query(api.previews.get, { docId })).rejects.toThrow("Not found");
    await expect(as.mutation(api.previews.set, { docId, blocks: "[]", seq: 1 })).resolves.toBeNull();
    const rows = await t.run(async (ctx) => ctx.db.query("pagePreviews").collect());
    expect(rows).toHaveLength(0);
  });

  test("the context digest is declined", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    const taken = await t.withIdentity(OWNER).mutation(api.context.pages.digest, {
      docId,
      digest: { brief: "", summary: "", terms: "", mentions: [], contentHash: "h" },
    });
    expect(taken).toBe(false);
  });

  test("the NML migrator never treats it as a migratable page", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    const as = t.withIdentity(OWNER);
    await expect(as.mutation(api.nmlMigration.addToCohort, { scope: "doc", key: docId })).rejects.toThrow("Not found");
    await expect(as.query(api.nmlMigration.inCohort, { docId })).rejects.toThrow("Not found");
    await expect(as.query(api.nmlMigration.nmlState, { docId })).rejects.toThrow("Not found");
    await expect(as.query(api.nmlMigration.nmlAuthority, { docId })).rejects.toThrow("Not found");
    await expect(
      as.mutation(api.nmlMigration.electMigration, {
        docId,
        update: textUpdate("x"),
        nmlSchemaVersion: 1,
        nmlEncodingVersion: 1,
        equivalenceOk: true,
        mismatchClasses: [],
        limitOk: true,
      }),
    ).rejects.toThrow("Not found");
    await expect(as.mutation(api.nmlMigration.rollback, { docId, reason: "x", diverged: false })).rejects.toThrow("Not found");
    const cohorts = await t.run(async (ctx) => ctx.db.query("nmlCohorts").collect());
    expect(cohorts).toHaveLength(0);
  });

  test("the legacy ProseMirror sync API: comments are Yjs-only", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    const as = t.withIdentity(OWNER);
    await expect(as.query(api.prosemirror.latestVersion, { id: docId })).rejects.toThrow("Not found");
    await expect(as.query(api.prosemirror.getSnapshot, { id: docId })).rejects.toThrow("Not found");
    await expect(as.query(api.prosemirror.getSteps, { id: docId, version: 0 })).rejects.toThrow("Not found");
    await expect(
      as.mutation(api.prosemirror.submitSteps, { id: docId, version: 0, clientId: "c", steps: [] }),
    ).rejects.toThrow("Not found");
    await expect(
      as.mutation(api.prosemirror.submitSnapshot, { id: docId, version: 1, content: "{}" }),
    ).rejects.toThrow("Not found");
  });
});

describe("the page lifecycle", () => {
  test("a duplicated page starts with no comments", async () => {
    const t = harness();
    const w = await world(t);
    await mint(t, w);
    const copyId = await t.withIdentity(OWNER).mutation(api.pages.duplicate, { pageId: w.pageId });
    const copy = await t.run(async (ctx) => ctx.db.get(copyId));
    expect(copy?.commentsDocId).toBeUndefined();
    expect(await t.withIdentity(OWNER).query(api.comments.docFor, { pageId: copyId })).toBeNull();
  });

  test("purging a page takes it out of every inbox, and only it", async () => {
    const t = harness();
    const w = await world(t);
    const other = await t.run(async (ctx) =>
      ctx.db.insert("pages", { ownerId: OWNER.subject, projectId: w.projectId, title: "", order: 1, docId: crypto.randomUUID(), createdAt: 1 }),
    );
    await t.run(async (ctx) => {
      for (const pageId of [w.pageId, w.pageId, other]) {
        await ctx.db.insert("commentNotices", {
          recipientId: EDITOR.subject,
          projectId: w.projectId,
          pageId,
          threadId: "t1",
          actorId: OWNER.subject,
          kind: "mention",
          createdAt: 1,
        });
      }
      const page = await ctx.db.get(w.pageId);
      await removePageCascade(ctx, page!);
    });
    const left = await t.run(async (ctx) => ctx.db.query("commentNotices").collect());
    expect(left.map((n) => n.pageId)).toEqual([other]);
  });

  test("purging a project takes its notices with it", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("commentNotices", {
        recipientId: EDITOR.subject,
        projectId: w.projectId,
        pageId: w.pageId,
        threadId: "t1",
        actorId: OWNER.subject,
        kind: "reply",
        createdAt: 1,
      });
      await purgeProject(ctx, w.projectId);
    });
    expect(await t.run(async (ctx) => ctx.db.query("commentNotices").collect())).toHaveLength(0);
  });

  test("a purged page's comments document is unreachable through the gate", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);
    await t.run(async (ctx) => {
      const page = await ctx.db.get(w.pageId);
      await removePageCascade(ctx, page!);
    });
    await expect(t.withIdentity(OWNER).query(api.ydoc.meta, { docId })).rejects.toThrow("Not found");
  });
});

describe("a thread round-trips through the real pipeline", () => {
  test("replica A writes a thread; replica B, a viewer, reads it back", async () => {
    const t = harness();
    const w = await world(t);
    const docId = await mint(t, w);

    // A: the editor, loading what is stored and writing through the executor.
    const a = await stored(t, docId);
    const sent: Uint8Array[] = [];
    a.on("update", (update: Uint8Array) => sent.push(update));
    const thread: NmlBlock = {
      id: "t1",
      type: "commentThread",
      props: {
        anchor: { blockId: "p_7f3a", exact: "by Friday", prefix: "ship it ", suffix: " if the", offsetHint: 8 },
        status: "open",
      },
      children: [
        {
          id: "c1",
          type: "comment",
          props: { authorId: EDITOR.subject, createdAt: 10 },
          content: [{ type: "text", text: "Is Friday realistic?", marks: [] }],
          children: [],
        },
      ],
    };
    await executeNmlCommands({
      doc: a,
      documentId: docId,
      commands: [{ type: "insertNodes", parentId: null, nodes: [thread] }],
      origin: { version: 1, transactionId: "tx1", actor: { userId: EDITOR.subject, kind: "human" }, command: "createThread" },
      idempotencyKey: "tx1",
      authorize: () => true,
    });
    await t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId, update: bytes(Y.mergeUpdates(sent)) });

    // B: the viewer, reading the log the way the provider does.
    const loaded = await t.withIdentity(VIEWER).query(api.ydoc.load, { docId, afterSeq: 0 });
    const b = new Y.Doc();
    for (const row of joinUpdateRows(loaded!.updates)) Y.applyUpdate(b, new Uint8Array(row.update));
    const [read] = threadsOf(decodeNmlDocument(b));
    expect(read.id).toBe("t1");
    expect(read.anchor.exact).toBe("by Friday");
    expect(read.comments.map((c) => c.authorId)).toEqual([EDITOR.subject]);
  });
});

describe("recordAudit — ids and counts, never words", () => {
  test("a well-formed event lands, stamped", async () => {
    const t = harness();
    const w = await world(t);
    const row = await t.run(async (ctx) => {
      const id = await recordAudit(ctx, {
        projectId: w.projectId,
        actorId: EDITOR.subject,
        actorKind: "user",
        action: "comment.create",
        subjectKind: "thread",
        subjectId: "t1",
        meta: { ids: { pageId: w.pageId, commentId: "c1" }, counts: { mentions: 2 } },
      });
      return await ctx.db.get(id);
    });
    expect(row).toMatchObject({ action: "comment.create", subjectId: "t1", meta: { counts: { mentions: 2 } } });
    expect(row?.at).toBeTypeOf("number");
  });

  test.each([
    ["a sentence in an id", { meta: { ids: { commentId: "Is Friday realistic?" } } }],
    ["a body smuggled as a subject", { subjectId: "ship it by Friday" }],
    ["an action that is not a dotted verb", { action: "Commented on the plan" }],
    ["a meta key that is prose", { meta: { counts: { "words said": 3 } } }],
    ["a count that is not a number", { meta: { counts: { mentions: Number.NaN } } }],
    ["an actor that is not an id", { actorId: "Ada Lovelace" }],
    ["an overlong id", { subjectId: "x".repeat(129) }],
  ])("refuses %s", async (_, override) => {
    const t = harness();
    const w = await world(t);
    await expect(
      t.run(async (ctx) =>
        recordAudit(ctx, {
          projectId: w.projectId,
          actorId: EDITOR.subject,
          actorKind: "user",
          action: "comment.create",
          ...override,
        }),
      ),
    ).rejects.toThrow(/Audit/);
    expect(await t.run(async (ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(0);
  });
});

describe("commentsEnabled", () => {
  test("on for every plan", async () => {
    expect(Object.values(PLAN_FEATURES).every((features) => features.comments)).toBe(true);
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      const project = (await ctx.db.get(w.projectId))!;
      expect(await commentsEnabled(ctx, project)).toBe(true);
      await ctx.db.insert("billingAccounts", {
        ownerId: OWNER.subject,
        acceptedCompletions: 0,
        chatConversations: 0,
        vip: true,
        createdAt: 1,
      });
      expect(await commentsEnabled(ctx, project)).toBe(true);
    });
  });
});
