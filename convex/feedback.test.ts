/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Feedback may name the workspace page/project that prompted it. Those ids are
 * write-scoped: an owner or a live shared editor may attach them, while a
 * viewer or stranger must not be able to use either id as an oracle.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_owner", email: "owner@example.test" };
const EDITOR = { subject: "user_editor", email: "editor@example.test" };
const VIEWER = { subject: "user_viewer" };
const STRANGER = { subject: "user_stranger" };

async function workspace(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "Shared project",
      editShareToken: "editor-link",
      shareToken: "viewer-link",
      createdAt: 1,
    });
    const pageId = await ctx.db.insert("pages", {
      ownerId: OWNER.subject,
      projectId,
      title: "Current page",
      order: 0,
      docId: "current-page",
      createdAt: 1,
    });
    return { projectId, pageId };
  });
}

async function claim(
  t: TestConvex<typeof schema>,
  projectId: Id<"projects">,
  granteeId: string,
  role: "viewer" | "editor",
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("shareClaims", {
      projectId,
      granteeId,
      role,
      createdAt: 1,
    });
  });
}

function report(projectId: Id<"projects">, pageId: Id<"pages">) {
  return {
    kind: "issue" as const,
    text: "The shared workspace did not save my report.",
    projectId,
    pageId,
    category: "editor" as const,
    env: { ua: "vitest", viewport: "1280x720", sha: "test" },
  };
}

describe("feedback.submit", () => {
  test("a shared editor can report the current page and project under their own identity", async () => {
    const t = convexTest(schema, modules);
    const { projectId } = await workspace(t);
    await claim(t, projectId, EDITOR.subject, "editor");

    // The regression path: the collaborator can edit the workspace first.
    const pageId = await t
      .withIdentity(EDITOR)
      .mutation(api.pages.create, { projectId, title: "Created by editor" });

    const feedbackId = await t
      .withIdentity(EDITOR)
      .mutation(api.feedback.submit, report(projectId, pageId));

    const row = await t.run((ctx) => ctx.db.get(feedbackId));
    expect(row).toMatchObject({
      number: 1,
      ownerId: EDITOR.subject,
      email: EDITOR.email,
      projectId,
      pageId,
      category: "editor",
      status: "new",
    });
  });

  test("the owner retains the same contextual reporting path", async () => {
    const t = convexTest(schema, modules);
    const { projectId, pageId } = await workspace(t);

    await expect(
      t.withIdentity(OWNER).mutation(api.feedback.submit, report(projectId, pageId)),
    ).resolves.toBeDefined();
  });

  test("viewers, strangers, and unauthenticated callers cannot attach a shared workspace", async () => {
    const t = convexTest(schema, modules);
    const { projectId, pageId } = await workspace(t);
    await claim(t, projectId, VIEWER.subject, "viewer");

    for (const caller of [VIEWER, STRANGER]) {
      await expect(
        t.withIdentity(caller).mutation(api.feedback.submit, report(projectId, pageId)),
      ).rejects.toThrow("Not found");
    }
    await expect(t.mutation(api.feedback.submit, report(projectId, pageId))).rejects.toThrow(
      "Not signed in",
    );
    expect(await t.run((ctx) => ctx.db.query("feedback").collect())).toEqual([]);
  });

  test("an editor claim loses reporting access when the editor link is revoked", async () => {
    const t = convexTest(schema, modules);
    const { projectId, pageId } = await workspace(t);
    await claim(t, projectId, EDITOR.subject, "editor");

    await t
      .withIdentity(OWNER)
      .mutation(api.share.setLink, { projectId, role: "editor", enabled: false });

    await expect(
      t.withIdentity(EDITOR).mutation(api.feedback.submit, report(projectId, pageId)),
    ).rejects.toThrow("Not found");
    expect(await t.run((ctx) => ctx.db.query("feedback").collect())).toEqual([]);
  });
});
