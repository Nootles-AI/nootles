import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import * as Y from "yjs";
import { components } from "./_generated/api";
import { joinUpdateRows } from "./yshape";

/**
 * Throwaway verification seed — an isolated project under a fake subject so
 * the anonymous share surfaces can be exercised headlessly. Run via
 * `npx convex run devSeed:seedShareVerify`, sweep with `cleanShareVerify`,
 * then delete this file. Never ships.
 */

const VERIFY_OWNER = "verify|sharing";

export const seedShareVerify = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const shareToken = crypto.randomUUID();
    const editShareToken = crypto.randomUUID();
    const projectId = await ctx.db.insert("projects", {
      ownerId: VERIFY_OWNER,
      title: "Share verify",
      shareToken,
      editShareToken,
      createdAt: now,
    });
    await ctx.db.insert("pages", {
      ownerId: VERIFY_OWNER,
      projectId,
      title: "A shared page",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: now,
    });
    return { projectId, shareToken, editShareToken };
  },
});

/**
 * A project+page owned by a THROWAWAY CLERK USER, for authenticated E2E: the
 * caller creates the user via the Clerk Backend API and passes its subject.
 * Same lifecycle as the rest of this file — verification only, then swept.
 */
export const seedOwnedVerify = internalMutation({
  args: { subject: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      ownerId: args.subject,
      title: args.title ?? "Storyboard verify",
      shareToken: crypto.randomUUID(),
      editShareToken: crypto.randomUUID(),
      createdAt: now,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId: args.subject,
      projectId,
      title: "Board",
      order: 0,
      docId,
      createdAt: now,
    });
    await ctx.db.insert("ydocs", {
      docId,
      seq: 0,
      snapshotSeq: 0,
      snapshotParts: 0,
      updatedAt: now,
    });
    return { projectId, pageId, docId };
  },
});

export const cleanOwnedVerify = internalMutation({
  args: { subject: v.string() },
  handler: async (ctx, args) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.subject))
      .collect();
    for (const project of projects) {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      await Promise.all(pages.map((p) => ctx.db.delete(p._id)));
      await ctx.db.delete(project._id);
    }
    return projects.length;
  },
});

/** Makes the verify page's doc Yjs-native so the harness can write to it. */
export const initVerifyYDoc = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", VERIFY_OWNER))
      .collect();
    for (const project of projects) {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      for (const page of pages) {
        const existing = await ctx.db
          .query("ydocs")
          .withIndex("by_doc", (q) => q.eq("docId", page.docId))
          .unique();
        if (!existing) {
          await ctx.db.insert("ydocs", {
            docId: page.docId,
            seq: 0,
            snapshotSeq: 0,
            snapshotParts: 0,
            updatedAt: Date.now(),
          });
        }
      }
    }
    return null;
  },
});

/**
 * Compares a migrated doc's text on both pipelines — the legacy snapshot's
 * text nodes against the Yjs fragment's — so a live migration can be audited
 * without trusting the editor that performed it.
 */
export const verifyMigration = internalQuery({
  args: { docId: v.string() },
  handler: async (ctx, args) => {
    const legacy: { content: string | null } = await ctx.runQuery(
      components.prosemirrorSync.lib.getSnapshot,
      { id: args.docId },
    );
    const pmText: string[] = [];
    const walk = (node: { text?: string; content?: unknown[] }) => {
      if (typeof node.text === "string") pmText.push(node.text);
      for (const child of node.content ?? []) {
        walk(child as { text?: string; content?: unknown[] });
      }
    };
    if (legacy.content) walk(JSON.parse(legacy.content));

    const updates = await ctx.db
      .query("yUpdates")
      .withIndex("by_doc_and_seq", (q) => q.eq("docId", args.docId))
      .collect();
    const row = await ctx.db
      .query("ydocs")
      .withIndex("by_doc", (q) => q.eq("docId", args.docId))
      .unique();
    const chunks = row?.snapshotParts
      ? await ctx.db
          .query("ySnapshots")
          .withIndex("by_doc_and_gen_and_part", (q) =>
            q.eq("docId", args.docId).eq("gen", row.snapshotSeq),
          )
          .collect()
      : [];
    const doc = new Y.Doc();
    // Snapshot chunks are byte slices of ONE update — concatenated, then
    // applied; and chunked update rows join the same way (see yshape).
    const ordered = chunks.sort((a, b) => a.part - b.part);
    if (ordered.length) {
      const whole = new Uint8Array(ordered.reduce((n, c) => n + c.data.byteLength, 0));
      let at = 0;
      for (const c of ordered) {
        whole.set(new Uint8Array(c.data), at);
        at += c.data.byteLength;
      }
      Y.applyUpdate(doc, whole);
    }
    for (const u of joinUpdateRows(updates)) Y.applyUpdate(doc, u.update);
    const yText = doc
      .getXmlFragment("prosemirror")
      .toString()
      .replace(/<[^>]*>/g, "");

    const unescaped = yText
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    const pm = pmText.join("");
    // The legacy snapshot trails its doc by whatever steps followed it, so
    // equality is the wrong bar: the Yjs side must CONTAIN every snapshot
    // text run (the steps only ever add what the snapshot hasn't seen).
    const missing = pmText.filter((t) => t.trim() && !unescaped.includes(t));
    return {
      containsAllSnapshotText: missing.length === 0,
      missingRuns: missing.slice(0, 3),
      pmLen: pm.length,
      yLen: unescaped.length,
      pmHead: pm.slice(0, 120),
      yHead: unescaped.slice(0, 120),
    };
  },
});

export const cleanShareVerify = internalMutation({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_owner", (q) => q.eq("ownerId", VERIFY_OWNER))
      .collect();
    for (const project of projects) {
      const pages = await ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", project._id))
        .collect();
      await Promise.all(pages.map((p) => ctx.db.delete(p._id)));
      const claims = await ctx.db
        .query("shareClaims")
        .withIndex("by_project_and_grantee", (q) =>
          q.eq("projectId", project._id),
        )
        .collect();
      await Promise.all(claims.map((c) => ctx.db.delete(c._id)));
      await ctx.db.delete(project._id);
    }
    return projects.length;
  },
});
