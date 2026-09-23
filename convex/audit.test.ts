/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { recordAudit, RETENTION_MS, SWEEP_BATCH, type AuditEvent } from "./audit";
import { commentsEnabled } from "./entitlements";
import { purgeProject } from "./projects";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";

/**
 * The audit log's read side (the owner's CSV export), its one-year retention,
 * the meta contract that keeps words out of it, and the entitlement override
 * that can switch a project's comments off.
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
const STAND_IN = { subject: OWNER.subject, act: "operator_1" };

const DAY = 24 * 60 * 60 * 1000;
const FIRST = { numItems: 100, cursor: null };

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

type World = { projectId: Id<"projects">; pageId: Id<"pages">; docId: string };

async function world(t: TestConvex<typeof schema>, ownerId = OWNER.subject): Promise<World> {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId,
      title: "Launch",
      createdAt: 1,
      updatedAt: 1,
      shareToken: `view-${ownerId}`,
      editShareToken: `edit-${ownerId}`,
      commentShareToken: `comment-${ownerId}`,
    });
    const docId = crypto.randomUUID();
    const pageId = await ctx.db.insert("pages", {
      ownerId,
      projectId,
      title: "Plan",
      order: 0,
      docId,
      createdAt: 1,
      updatedAt: 1,
    });
    for (const [who, role] of [
      [EDITOR, "editor"],
      [VIEWER, "viewer"],
      [COMMENTER, "commenter"],
    ] as const) {
      await ctx.db.insert("shareClaims", { projectId, granteeId: who.subject, role, createdAt: 1 });
    }
    return { projectId, pageId, docId };
  });
}

/** Rows written straight to the table, so a test can place them in time. */
async function seed(
  t: TestConvex<typeof schema>,
  rows: Array<Partial<Doc<"auditEvents">> & { at: number }>,
): Promise<void> {
  await t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert("auditEvents", {
        actorId: EDITOR.subject,
        actorKind: "user",
        action: "comment.create",
        ...row,
      });
    }
  });
}

function textUpdate(text: string): ArrayBuffer {
  const doc = new Y.Doc();
  doc.getText("t").insert(0, text);
  const update = Y.encodeStateAsUpdate(doc);
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("audit.forProject — the owner's, and nobody else's", () => {
  test("the owner reads the project's events", async () => {
    const t = harness();
    const w = await world(t);
    await seed(t, [{ projectId: w.projectId, at: 10 }]);
    const result = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST });
    expect(result.page.map((row) => row.action)).toEqual(["comment.create"]);
    expect(result.isDone).toBe(true);
  });

  test.each([
    ["an editor", EDITOR],
    ["a commenter", COMMENTER],
    ["a viewer", VIEWER],
    ["a stranger", STRANGER],
    ["an operator standing in for the owner", STAND_IN],
    ["a signed-out visitor", null],
  ])("refuses %s", async (_, who) => {
    const t = harness();
    const w = await world(t);
    await seed(t, [{ projectId: w.projectId, at: 10 }]);
    const as = who ? t.withIdentity(who) : t;
    await expect(
      as.query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST }),
    ).rejects.toThrow("Not found");
  });

  test("refuses the owner once the project is in the trash", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => ctx.db.patch(w.projectId, { deletedAt: 5 }));
    await expect(
      t.withIdentity(OWNER).query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST }),
    ).rejects.toThrow("Not found");
  });

  test("never lists another project's events", async () => {
    const t = harness();
    const mine = await world(t);
    const theirs = await world(t, "user_other");
    await seed(t, [
      { projectId: mine.projectId, at: 10, subjectId: "mine" },
      { projectId: theirs.projectId, at: 11, subjectId: "theirs" },
      { workspaceId: "ws_1", at: 12, subjectId: "workspace" },
    ]);
    const result = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: mine.projectId, paginationOpts: FIRST });
    expect(result.page.map((row) => row.subjectId)).toEqual(["mine"]);
  });

  test("names the actor and the page, and nothing a stranger's id could reach", async () => {
    const t = harness();
    const w = await world(t);
    const foreign = await world(t, "user_other");
    await t.run(async (ctx) => {
      const profile = { status: "done", createdAt: 1 } as const;
      await ctx.db.insert("profiles", { ...profile, ownerId: EDITOR.subject, name: "Ada Lovelace", email: "ada@example.com" });
      await ctx.db.insert("profiles", { ...profile, ownerId: COMMENTER.subject, email: "bram@example.com" });
    });
    await seed(t, [
      { projectId: w.projectId, at: 1, meta: { ids: { pageId: w.pageId, threadId: "t1" }, counts: { mentions: 2 } } },
      { projectId: w.projectId, at: 2, actorId: COMMENTER.subject, subjectKind: "page", subjectId: w.pageId },
      { projectId: w.projectId, at: 3, actorId: VIEWER.subject, meta: { ids: { pageId: foreign.pageId } } },
      { projectId: w.projectId, at: 4, actorId: "operator_1", actorKind: "operator", meta: { ids: { pageId: "not-an-id" } } },
      { projectId: w.projectId, at: 5, actorId: "system", actorKind: "system", windowKey: "k", count: 37 },
    ]);
    const { page } = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST });
    expect(page.map(({ actorName, pageId, pageTitle }) => ({ actorName, pageId, pageTitle }))).toEqual([
      { actorName: "Ada Lovelace", pageId: w.pageId, pageTitle: "Plan" },
      { actorName: "bram@example.com", pageId: w.pageId, pageTitle: "Plan" },
      { actorName: null, pageId: null, pageTitle: null },
      { actorName: null, pageId: null, pageTitle: null },
      { actorName: null, pageId: null, pageTitle: null },
    ]);
    expect(page[0].meta).toEqual({ ids: { pageId: w.pageId, threadId: "t1" }, counts: { mentions: 2 } });
    expect(page[4].count).toBe(37);
  });

  test("pages through the log oldest first, every row once", async () => {
    const t = harness();
    const w = await world(t);
    await seed(t, Array.from({ length: 25 }, (_, i) => ({ projectId: w.projectId, at: 1000 - i * 10, subjectId: `s${i}` })));
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const result: { page: Array<{ at: number }>; isDone: boolean; continueCursor: string } = await t
        .withIdentity(OWNER)
        .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: { numItems: 10, cursor } });
      seen.push(...result.page.map((row) => row.at));
      pages += 1;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(seen).toHaveLength(25);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBeGreaterThanOrEqual(3);
  });

  test("a page is capped at 200 rows, however many are asked for", async () => {
    const t = harness();
    const w = await world(t);
    await seed(t, Array.from({ length: 230 }, (_, i) => ({ projectId: w.projectId, at: i })));
    const first = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: { numItems: 10_000, cursor: null } });
    expect(first.page).toHaveLength(200);
    expect(first.isDone).toBe(false);
    const rest = await t.withIdentity(OWNER).query(api.audit.forProject, {
      projectId: w.projectId,
      paginationOpts: { numItems: 10_000, cursor: first.continueCursor },
    });
    expect(rest.page.map((row) => row.at)).toEqual(Array.from({ length: 30 }, (_, i) => 200 + i));
    expect(rest.isDone).toBe(true);
  });

  test("a period is from-inclusive and to-exclusive, so adjacent periods tile", async () => {
    const t = harness();
    const w = await world(t);
    await seed(t, [100, 200, 300, 400].map((at) => ({ projectId: w.projectId, at })));
    const ats = async (range: { from?: number; to?: number }) =>
      (
        await t
          .withIdentity(OWNER)
          .query(api.audit.forProject, { projectId: w.projectId, ...range, paginationOpts: FIRST })
      ).page.map((row) => row.at);
    expect(await ats({ from: 200, to: 400 })).toEqual([200, 300]);
    expect(await ats({ from: 400 })).toEqual([400]);
    expect(await ats({ to: 200 })).toEqual([100]);
    expect(await ats({})).toEqual([100, 200, 300, 400]);
    expect([...(await ats({ to: 250 })), ...(await ats({ from: 250 }))]).toEqual([100, 200, 300, 400]);
  });
});

describe("audit.sweepExpired — one year, then gone", () => {
  test("deletes events older than a year and nothing younger", async () => {
    const t = harness();
    const w = await world(t);
    const now = Date.now();
    await seed(t, [
      { projectId: w.projectId, at: now - RETENTION_MS - DAY, subjectId: "old" },
      { projectId: w.projectId, at: now - RETENTION_MS + DAY, subjectId: "almost" },
      { projectId: w.projectId, at: now, subjectId: "new" },
      { workspaceId: "ws_1", at: now - 2 * RETENTION_MS, subjectId: "old-workspace" },
    ]);
    expect(await t.mutation(internal.audit.sweepExpired, {})).toBe(2);
    const left = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(left.map((row) => row.subjectId).sort()).toEqual(["almost", "new"]);
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled).toHaveLength(0);
  });

  test("a backlog past one batch reschedules itself until it drains", async () => {
    vi.useFakeTimers();
    const t = harness();
    const w = await world(t);
    const old = Date.now() - RETENTION_MS - DAY;
    await seed(t, Array.from({ length: SWEEP_BATCH + 7 }, (_, i) => ({ projectId: w.projectId, at: old - i })));
    await seed(t, [{ projectId: w.projectId, at: Date.now(), subjectId: "keep" }]);

    expect(await t.mutation(internal.audit.sweepExpired, {})).toBe(SWEEP_BATCH);
    const pending = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(pending.map((job) => job.name)).toEqual(["audit:sweepExpired"]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(left.map((row) => row.subjectId)).toEqual(["keep"]);
  });

  test("runs on the daily cron", async () => {
    const crons = (await import("./crons")).default as unknown as {
      crons: Record<string, { name: string; schedule: { type: string; hours?: number } }>;
    };
    const job = crons.crons["sweep expired audit events"];
    expect(job.name).toBe("audit:sweepExpired");
    expect(job.schedule).toMatchObject({ type: "interval", hours: 24 });
  });
});

describe("recordAudit — a comment body cannot be passed through", () => {
  const base: AuditEvent = {
    actorId: EDITOR.subject,
    actorKind: "user",
    action: "comment.create",
    subjectKind: "thread",
    subjectId: "t1",
  };

  test("the type has nowhere to put words", () => {
    // Compile-time only: tsc refuses each of these, which is the proof.
    const refused: AuditEvent[] = [
      // @ts-expect-error — no free-text column exists on an event
      { ...base, body: "Is Friday realistic?" },
      // @ts-expect-error — meta holds ids and counts, nothing else
      { ...base, meta: { text: "Is Friday realistic?" } },
      // @ts-expect-error — a count is a number, never a sentence
      { ...base, meta: { counts: { words: "Is Friday realistic?" } } },
    ];
    expect(refused).toHaveLength(3);
  });

  test.each([
    ["a one-word body in an id named for it", { meta: { ids: { body: "LGTM" } } }],
    ["a quote in an id named for it", { meta: { ids: { exact: "Friday" } } }],
    ["text keyed by any casing", { meta: { ids: { Text: "LGTM" } } }],
    ["a sentence as an id", { meta: { ids: { commentId: "Is Friday realistic?" } } }],
    ["a body with a line break", { subjectId: "LGTM\nship" }],
    ["a body in the action", { action: "comment.lgtm ship it" }],
    ["more than a handful of references", {
      meta: { ids: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "x"])) },
    }],
  ])("refuses %s", async (_, override) => {
    const t = harness();
    const w = await world(t);
    await expect(
      t.run(async (ctx) => recordAudit(ctx, { ...base, projectId: w.projectId, ...override })),
    ).rejects.toThrow(/Audit/);
  });

  test("and a field smuggled past the type is refused by the schema", async () => {
    const t = harness();
    const w = await world(t);
    const smuggled = { ...base, projectId: w.projectId, body: "Is Friday realistic?" } as AuditEvent;
    await expect(t.run(async (ctx) => recordAudit(ctx, smuggled))).rejects.toThrow();
    expect(await t.run(async (ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(0);
  });

  test("what does land is ids and counts", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) =>
      recordAudit(ctx, {
        ...base,
        projectId: w.projectId,
        meta: { ids: { pageId: w.pageId, commentId: "c_1" }, counts: { mentions: 1 } },
      }),
    );
    const [row] = await t.run(async (ctx) => ctx.db.query("auditEvents").collect());
    expect(Object.keys(row).sort()).toEqual(
      ["_creationTime", "_id", "action", "actorId", "actorKind", "at", "meta", "projectId", "subjectId", "subjectKind"].sort(),
    );
  });
});

describe("entitlement overrides — switching comments off", () => {
  async function override(
    t: TestConvex<typeof schema>,
    args: { scope: "project" | "account"; scopeId: string; value: boolean | null; expiresAt?: number },
  ) {
    await t.mutation(internal.entitlements.setOverride, {
      feature: "comments",
      note: "abuse report",
      grantedBy: "operator_1",
      ...args,
    });
  }

  async function enabled(t: TestConvex<typeof schema>, projectId: Id<"projects">) {
    return await t.run(async (ctx) => commentsEnabled(ctx, (await ctx.db.get(projectId))!));
  }

  test("a project override turns the comments channel off, and clearing it turns it back on", async () => {
    const t = harness();
    const w = await world(t);
    const commentsDoc = await t.withIdentity(OWNER).mutation(api.comments.ensureDoc, { pageId: w.pageId });
    await t.withIdentity(OWNER).mutation(api.ydoc.init, { docId: w.docId, update: textUpdate("page") });

    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    expect(await enabled(t, w.projectId)).toBe(false);

    await expect(
      t.withIdentity(EDITOR).mutation(api.comments.ensureDoc, { pageId: w.pageId }),
    ).rejects.toThrow("Comments are turned off for this project.");
    for (const who of [OWNER, EDITOR]) {
      await expect(
        t.withIdentity(who).mutation(api.ydoc.append, { docId: commentsDoc, update: textUpdate("x") }),
      ).rejects.toThrow("Not found");
      await expect(
        t.withIdentity(who).query(api.ydoc.load, { docId: commentsDoc, afterSeq: 0 }),
      ).rejects.toThrow("Not found");
      await expect(t.withIdentity(who).query(api.ydoc.meta, { docId: commentsDoc })).rejects.toThrow("Not found");
    }
    expect(await t.withIdentity(OWNER).query(api.comments.docFor, { pageId: w.pageId })).toBeNull();
    // The page itself is untouched: only its comments are switched off.
    await t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId: w.docId, update: textUpdate("still") });
    await expect(t.withIdentity(OWNER).query(api.ydoc.meta, { docId: w.docId })).resolves.toMatchObject({ seq: 2 });

    await override(t, { scope: "project", scopeId: w.projectId, value: null });
    expect(await enabled(t, w.projectId)).toBe(true);
    await t.withIdentity(EDITOR).mutation(api.ydoc.append, { docId: commentsDoc, update: textUpdate("back") });
    expect(await t.withIdentity(OWNER).query(api.comments.docFor, { pageId: w.pageId })).toBe(commentsDoc);
  });

  test("an account override covers every project the owner has; a project override outranks it", async () => {
    const t = harness();
    const a = await world(t);
    const b = await world(t);
    const other = await world(t, "user_other");
    await override(t, { scope: "account", scopeId: OWNER.subject, value: false });
    expect(await enabled(t, a.projectId)).toBe(false);
    expect(await enabled(t, b.projectId)).toBe(false);
    expect(await enabled(t, other.projectId)).toBe(true);

    await override(t, { scope: "project", scopeId: b.projectId, value: true });
    expect(await enabled(t, a.projectId)).toBe(false);
    expect(await enabled(t, b.projectId)).toBe(true);
  });

  test("the owner's account decides, not the caller's", async () => {
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "account", scopeId: EDITOR.subject, value: false });
    expect(await enabled(t, w.projectId)).toBe(true);
    await t.withIdentity(EDITOR).mutation(api.comments.ensureDoc, { pageId: w.pageId });
  });

  test("an override lapses at its expiry — deleted by a scheduled job, not read off the clock", async () => {
    vi.useFakeTimers();
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: false, expiresAt: Date.now() + DAY });
    expect(await enabled(t, w.projectId)).toBe(false);
    const pending = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(pending.map((job) => job.name)).toEqual(["entitlements:expireOverride"]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await enabled(t, w.projectId)).toBe(true);
    expect(await t.run(async (ctx) => ctx.db.query("entitlementOverrides").collect())).toHaveLength(0);
    const { page } = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST });
    expect(page.map((row) => [row.action, row.actorKind])).toEqual([
      ["entitlement.revoke", "operator"],
      ["entitlement.expire", "system"],
    ]);
  });

  test("a replaced override is not expired by the old one's job", async () => {
    vi.useFakeTimers();
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: false, expiresAt: Date.now() + DAY });
    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await enabled(t, w.projectId)).toBe(false);
  });

  test("an override cannot be set to expire in the past", async () => {
    const t = harness();
    const w = await world(t);
    await expect(
      override(t, { scope: "project", scopeId: w.projectId, value: false, expiresAt: Date.now() - 1 }),
    ).rejects.toThrow("An override cannot expire in the past.");
  });

  test("clearing what was never set changes nothing and records nothing", async () => {
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: null });
    expect(await t.run(async (ctx) => ctx.db.query("auditEvents").collect())).toHaveLength(0);
  });

  test("the operator is named by id, for either scope", async () => {
    const t = harness();
    const w = await world(t);
    for (const [scope, scopeId] of [["project", w.projectId], ["account", OWNER.subject]] as const) {
      await expect(
        t.mutation(internal.entitlements.setOverride, {
          scope, scopeId, feature: "comments", value: false, note: "n", grantedBy: "ops@example.com",
        }),
      ).rejects.toThrow("grantedBy must be the operator's id");
    }
    expect(await t.run(async (ctx) => ctx.db.query("entitlementOverrides").collect())).toHaveLength(0);
  });

  test("purging the project takes its overrides with it", async () => {
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    await override(t, { scope: "account", scopeId: OWNER.subject, value: false });
    await t.run(async (ctx) => purgeProject(ctx, w.projectId));
    const left = await t.run(async (ctx) => ctx.db.query("entitlementOverrides").collect());
    expect(left.map((row) => row.scope)).toEqual(["account"]);
  });

  test("setting twice keeps one row", async () => {
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    const rows = await t.run(async (ctx) => ctx.db.query("entitlementOverrides").collect());
    expect(rows).toHaveLength(1);
  });

  test("a project override is in that project's log, for its owner to find", async () => {
    const t = harness();
    const w = await world(t);
    await override(t, { scope: "project", scopeId: w.projectId, value: false });
    await override(t, { scope: "project", scopeId: w.projectId, value: null });
    await override(t, { scope: "account", scopeId: OWNER.subject, value: false });
    const { page } = await t
      .withIdentity(OWNER)
      .query(api.audit.forProject, { projectId: w.projectId, paginationOpts: FIRST });
    expect(page.map((row) => [row.action, row.actorKind, row.subjectId])).toEqual([
      ["entitlement.revoke", "operator", "comments"],
      ["entitlement.clear", "operator", "comments"],
    ]);
  });

  test("a project scope must name a live project", async () => {
    const t = harness();
    const w = await world(t);
    await expect(override(t, { scope: "project", scopeId: "nope", value: false })).rejects.toThrow(
      "No live project has that id.",
    );
    await t.run(async (ctx) => ctx.db.patch(w.projectId, { deletedAt: 5 }));
    await expect(override(t, { scope: "project", scopeId: w.projectId, value: false })).rejects.toThrow(
      "No live project has that id.",
    );
  });
});
