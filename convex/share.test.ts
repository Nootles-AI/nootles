/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

/**
 * Asking for the pen, and being handed it.
 *
 * The properties worth pinning are the ones about blast radius: a grant must
 * promote exactly one person and turn no link on, it must survive the editor
 * link being revoked (it was never that link's doing), and it must NOT survive
 * the project being unshared — revoking every link stays the owner's one move
 * that closes the door on everybody.
 */

const modules = import.meta.glob("./**/*.ts");

const OWNER = { subject: "user_owner" };
const GUEST = { subject: "user_guest" };
const STRANGER = { subject: "user_stranger" };

async function world(
  t: TestConvex<typeof schema>,
  opts: { shareToken?: string; editShareToken?: string } = { shareToken: "v" },
) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      ownerId: OWNER.subject,
      title: "P",
      createdAt: 1,
      ...opts,
    });
    await ctx.db.insert("profiles", {
      ownerId: GUEST.subject,
      name: "Ada Lovelace",
      status: "skipped",
      createdAt: 1,
    });
    return projectId;
  });
}

async function claim(
  t: TestConvex<typeof schema>,
  projectId: Id<"projects">,
  granteeId: string,
  role: "viewer" | "editor" = "viewer",
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

/** The whole loop, since most tests need a grant to have happened. */
async function askAndGrant(
  t: TestConvex<typeof schema>,
  projectId: Id<"projects">,
  grant = true,
) {
  await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });
  const [ask] = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});
  await t
    .withIdentity(OWNER)
    .mutation(api.share.decideRequest, { requestId: ask.requestId, grant });
  return ask;
}

describe("requestEdit", () => {
  test("a viewer's ask reaches the owner, named", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);

    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });

    const inbox = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ projectId, projectTitle: "P", name: "Ada Lovelace" });
    expect(
      await t.withIdentity(GUEST).query(api.share.myEditRequest, { projectId }),
    ).toEqual({ status: "pending" });
  });

  test("asking twice is one question", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);

    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });
    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });

    expect(
      await t.withIdentity(OWNER).query(api.share.incomingRequests, {}),
    ).toHaveLength(1);
  });

  test("someone with no role cannot even learn the project exists", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);

    await expect(
      t.withIdentity(STRANGER).mutation(api.share.requestEdit, { projectId }),
    ).rejects.toThrow("Not found");
    expect(
      await t.withIdentity(OWNER).query(api.share.incomingRequests, {}),
    ).toHaveLength(0);
  });

  test("someone who already has the pen asks for nothing", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { editShareToken: "e" });
    await claim(t, projectId, GUEST.subject, "editor");

    expect(
      await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId }),
    ).toBeNull();
    expect(
      await t.withIdentity(OWNER).mutation(api.share.requestEdit, { projectId }),
    ).toBeNull();
    expect(
      await t.withIdentity(OWNER).query(api.share.incomingRequests, {}),
    ).toHaveLength(0);
  });
});

describe("decideRequest", () => {
  test("granting promotes one person and turns no link on", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);
    await claim(t, projectId, STRANGER.subject);

    await askAndGrant(t, projectId);

    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId }),
    ).toBe("editor");
    // The other viewer on the same link is untouched, and so is the link.
    expect(
      await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId }),
    ).toBe("viewer");
    expect(
      await t.withIdentity(OWNER).query(api.share.links, { projectId }),
    ).toMatchObject({ viewer: "v", commenter: null, editor: null });
    // Answered, so it leaves the inbox.
    expect(
      await t.withIdentity(OWNER).query(api.share.incomingRequests, {}),
    ).toHaveLength(0);
  });

  test("the pen outlives the editor link, but not being unshared", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { shareToken: "v", editShareToken: "e" });
    await claim(t, projectId, GUEST.subject);
    await askAndGrant(t, projectId);

    await t
      .withIdentity(OWNER)
      .mutation(api.share.setLink, { projectId, role: "editor", enabled: false });
    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId }),
    ).toBe("editor");

    await t
      .withIdentity(OWNER)
      .mutation(api.share.setLink, { projectId, role: "viewer", enabled: false });
    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId }),
    ).toBeNull();
  });

  test("a grant is announced to the requester exactly once", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);
    await askAndGrant(t, projectId);

    const news = await t.withIdentity(GUEST).query(api.share.grantedForMe, {});
    expect(news).toMatchObject([{ projectId, projectTitle: "P" }]);

    await t
      .withIdentity(GUEST)
      .mutation(api.share.markGrantsSeen, {
        requestIds: news.map((n) => n.requestId),
      });
    expect(
      await t.withIdentity(GUEST).query(api.share.grantedForMe, {}),
    ).toHaveLength(0);
  });

  test("a decline is quiet, and leaves them free to ask again", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);
    await askAndGrant(t, projectId, false);

    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId }),
    ).toBe("viewer");
    // Nothing is said about it — only grants are announced.
    expect(
      await t.withIdentity(GUEST).query(api.share.grantedForMe, {}),
    ).toHaveLength(0);

    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });
    expect(
      await t.withIdentity(OWNER).query(api.share.incomingRequests, {}),
    ).toHaveLength(1);
  });

  test("only the project's owner may answer", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);
    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });
    const [ask] = await t.withIdentity(OWNER).query(api.share.incomingRequests, {});

    // Including the requester, who would otherwise grant themselves the pen.
    for (const who of [GUEST, STRANGER]) {
      await expect(
        t
          .withIdentity(who)
          .mutation(api.share.decideRequest, { requestId: ask.requestId, grant: true }),
      ).rejects.toThrow("Not found");
    }
    expect(
      await t.withIdentity(GUEST).query(api.projects.myRole, { projectId }),
    ).toBe("viewer");
  });

  test("the owner's inbox is theirs alone", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);
    await claim(t, projectId, GUEST.subject);
    await t.withIdentity(GUEST).mutation(api.share.requestEdit, { projectId });

    expect(
      await t.withIdentity(STRANGER).query(api.share.incomingRequests, {}),
    ).toHaveLength(0);
    expect(
      await t.withIdentity(GUEST).query(api.share.incomingRequests, {}),
    ).toHaveLength(0);
  });
});

describe("claim", () => {
  test("an account born from a link is spared first run", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t);

    // The stranger, because the fixture gives the guest a profile already —
    // this is about the row the claim itself writes.
    await t.withIdentity(STRANGER).mutation(api.share.claim, { token: "v" });
    const born = await t.run(async (ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", STRANGER.subject))
        .unique(),
    );
    expect(born).toMatchObject({ status: "skipped" });
    expect(
      await t.withIdentity(STRANGER).query(api.projects.myRole, { projectId }),
    ).toBe("viewer");
  });
});

describe("collaborators", () => {
  const turnOff = (t: TestConvex<typeof schema>, projectId: Id<"projects">, role: "viewer" | "editor") =>
    t.withIdentity(OWNER).mutation(api.share.setLink, { projectId, role, enabled: false });
  const listed = async (t: TestConvex<typeof schema>, projectId: Id<"projects">) =>
    (await t.withIdentity(OWNER).query(api.share.collaborators, { projectId })).map(
      ({ granteeId, role }) => [granteeId, role],
    );

  test("unsharing entirely empties the list, and sharing again refills it", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { shareToken: "v", editShareToken: "e" });
    await claim(t, projectId, GUEST.subject, "editor");
    await claim(t, projectId, STRANGER.subject, "viewer");
    expect(await listed(t, projectId)).toEqual([
      [GUEST.subject, "editor"],
      [STRANGER.subject, "viewer"],
    ]);

    await turnOff(t, projectId, "editor");
    await turnOff(t, projectId, "viewer");
    expect(await listed(t, projectId)).toEqual([]);

    await t
      .withIdentity(OWNER)
      .mutation(api.share.setLink, { projectId, role: "viewer", enabled: true });
    expect(await listed(t, projectId)).toEqual([
      [GUEST.subject, "viewer"],
      [STRANGER.subject, "viewer"],
    ]);
  });

  test("the editor link going off reads its claimants as the viewers they now are", async () => {
    const t = convexTest(schema, modules);
    const projectId = await world(t, { shareToken: "v", editShareToken: "e" });
    await claim(t, projectId, GUEST.subject, "editor");

    await turnOff(t, projectId, "editor");
    expect(await listed(t, projectId)).toEqual([[GUEST.subject, "viewer"]]);
  });

  test("every claimant is listed exactly as their own session sees them", async () => {
    const kinds = [
      { who: "user_via_viewer", role: "viewer" },
      { who: "user_via_editor", role: "editor" },
      { who: "user_viewer_granted", role: "viewer", grantedRole: "editor" },
      { who: "user_editor_granted", role: "editor", grantedRole: "editor" },
    ] as const;
    const states = [
      { shareToken: "v", editShareToken: "e" },
      { shareToken: "v" },
      { editShareToken: "e" },
      {},
    ];
    for (const links of states) {
      const t = convexTest(schema, modules);
      const projectId = await world(t, links);
      await t.run(async (ctx) => {
        for (const kind of kinds) {
          const { who, ...row } = kind;
          await ctx.db.insert("shareClaims", { projectId, granteeId: who, ...row, createdAt: 1 });
        }
      });

      // In the index's order, by grantee.
      const expected = [];
      for (const { who } of [...kinds].sort((a, b) => a.who.localeCompare(b.who))) {
        const role = await t
          .withIdentity({ subject: who })
          .query(api.projects.myRole, { projectId });
        if (role) expected.push([who, role]);
      }
      expect({ links, listed: await listed(t, projectId) }).toEqual({ links, listed: expected });
    }
  });
});
