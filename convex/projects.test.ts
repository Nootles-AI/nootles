/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * The "Shared with me" join: which claims still earn a row, and what the row
 * says. The interesting properties are the negative ones — a dead link, a
 * vanished project, or a stray claim on your own project must all vanish
 * rather than draw a lying row.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_owner" };
const GUEST = { subject: "user_guest" };

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
    await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "",
      order: 0,
      docId: crypto.randomUUID(),
      createdAt: 1,
    });
    return projectId;
  });
}

async function claim(
  t: TestConvex<typeof schema>,
  projectId: Id<"projects">,
  granteeId: string,
  role: "viewer" | "editor",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("shareClaims", { projectId, granteeId, role, createdAt: 1 });
  });
}

describe("sharedWithMe", () => {
  test("a live claim earns a row, at the role the tokens still grant", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { editShareToken: "e" });
    await claim(t, projectId, GUEST.subject, "editor");
    await t.run(async (ctx) => {
      await ctx.db.insert("profiles", {
        ownerId: OWNER.subject,
        name: "Priya Sharma",
        status: "skipped",
        createdAt: 1,
      });
    });

    const rows = await t.withIdentity(GUEST).query(api.projects.sharedWithMe, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: projectId,
      role: "editor",
      ownerName: "Priya Sharma",
      pageCount: 1,
    });
  });

  test("revoking every link removes the row, not just the pen", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t); // no tokens live
    await claim(t, projectId, GUEST.subject, "editor");

    const rows = await t.withIdentity(GUEST).query(api.projects.sharedWithMe, {});
    expect(rows).toEqual([]);
  });

  test("an editor claim outliving its link demotes to view-only", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { shareToken: "v" });
    await claim(t, projectId, GUEST.subject, "editor");

    const rows = await t.withIdentity(GUEST).query(api.projects.sharedWithMe, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("viewer");
  });

  test("a stray claim on your own project never shows under Shared with me", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { editShareToken: "e" });
    await claim(t, projectId, OWNER.subject, "editor");

    const rows = await t.withIdentity(OWNER).query(api.projects.sharedWithMe, {});
    expect(rows).toEqual([]);
  });
});

describe("create from a template", () => {
  const pagesOf = (t: TestConvex<typeof schema>, projectId: Id<"projects">) =>
    t.run((ctx) =>
      ctx.db
        .query("pages")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .collect(),
    );

  test("the picker lists PRD", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.templates.list, {})).toEqual([
      { id: "prd", name: "PRD", description: "A product requirements document" },
    ]);
  });

  test("PRD is blank for now: one untitled page, like any new project", async () => {
    const t = convexTest(schema, modules);
    const projectId = await t
      .withIdentity(OWNER)
      .mutation(api.projects.create, { title: "Spec", template: "prd" });
    const pages = await pagesOf(t, projectId);
    expect(pages.map((p) => [p.title, p.order])).toEqual([["", 0]]);
  });

  test("an id nobody defined is refused, and nothing is made", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.withIdentity(OWNER).mutation(api.projects.create, { title: "Spec", template: "nope" }),
    ).rejects.toThrow("Unknown template");
    expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
  });
});
