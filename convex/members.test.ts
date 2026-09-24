/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import type { WorkspaceRole } from "./auth";
import { maskEmail } from "./members";

/**
 * Who is in a workspace, and every way in and out: invitations bound to one
 * address, join domains, role changes, removal and leaving. The rules worth
 * pinning are the ones a mistake here would turn into a door: an invitation
 * admits only the address it names, an admin cannot make or unmake a peer, a
 * workspace always keeps an owner, and a seat taken away takes every way back
 * in along with it — its projects' stewardship, its link claims, its requests.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

type Identity = { subject: string; email?: string; emailVerified?: boolean; act?: string };

const OWNER = { subject: "user_ws_owner", email: "olive@acme.com" };
const ADMIN = { subject: "user_ws_admin", email: "ada@acme.com" };
/** A member, and the one who made every project in the world. */
const CREATOR = { subject: "user_creator", email: "cy@acme.com" };
const MEMBER = { subject: "user_member", email: "max@acme.com" };
const GUEST = { subject: "user_guest", email: "gus@partner.io" };
const REMOVED = { subject: "user_removed", email: "rex@acme.com" };
const STRANGER = { subject: "user_stranger", email: "sal@elsewhere.org" };
/** Someone new at Acme, with no seat and no profile yet. */
const NEWCOMER = { subject: "user_newcomer", email: "nia@acme.com" };
const STAND_IN = { ...OWNER, act: "ops_session_1" };

type T = TestConvex<typeof schema>;
type Caller = Pick<T, "query" | "mutation">;

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

const as = (t: T, who: Identity | null): Caller => (who ? t.withIdentity(who) : t);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Where accepting or joining lands someone in `world`'s workspace. */
const arrived = (w: { workspaceId: Id<"workspaces"> }, role: WorkspaceRole) => ({
  workspaceId: w.workspaceId,
  slug: "acme",
  name: "Acme",
  role,
});

async function world(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    await ctx.db.insert("workspaceSlugs", { slug: "acme", workspaceId });
    const seat = (who: Identity, role: Doc<"memberships">["role"], joinedAt = 10) =>
      ctx.db.insert("memberships", {
        workspaceId,
        userId: who.subject,
        role,
        status: "active",
        joinedAt,
      });
    await seat(OWNER, "owner", 1);
    await seat(ADMIN, "admin");
    await seat(CREATOR, "member");
    await seat(MEMBER, "member");
    await seat(GUEST, "guest");
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: REMOVED.subject,
      role: "member",
      status: "removed",
      joinedAt: 1,
      removedAt: 2,
      removedBy: ADMIN.subject,
    });
    for (const [who, name] of [
      [OWNER, "Olive"],
      [ADMIN, "Ada"],
      [CREATOR, "Cy"],
      [MEMBER, "Max"],
      [GUEST, "Gus"],
      [REMOVED, "Rex"],
      [STRANGER, "Sal"],
    ] as const) {
      await ctx.db.insert("profiles", {
        ownerId: who.subject,
        name,
        email: who.email.toUpperCase(),
        status: "done",
        createdAt: 1,
      });
    }

    const project = async (title: string, extra: Partial<Doc<"projects">> = {}) => {
      const projectId = await ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title,
        workspaceId,
        createdAt: 1,
        ...extra,
      });
      const docId = crypto.randomUUID();
      const pageId = await ctx.db.insert("pages", {
        ownerId: CREATOR.subject,
        createdBy: CREATOR.subject,
        projectId,
        title: "Plan",
        order: 0,
        docId,
        createdAt: 1,
      });
      return { projectId, pageId, docId };
    };
    const open = await project("Roadmap");
    const secret = await project("Offsite", { visibility: "private" });
    const binned = await project("Old plans", { deletedAt: 5 });
    const others = await project("Hiring", { ownerId: MEMBER.subject });
    const personal = await ctx.db.insert("projects", {
      ownerId: STRANGER.subject,
      title: "Sal's diary",
      shareToken: "sal-view",
      createdAt: 1,
    });
    return { workspaceId, open, secret, binned, others, personal };
  });
}

type World = Awaited<ReturnType<typeof world>>;

const seatOf = (t: T, workspaceId: Id<"workspaces">, who: Identity) =>
  t.run((ctx) =>
    ctx.db
      .query("memberships")
      .withIndex("by_workspace_user", (q) =>
        q.eq("workspaceId", workspaceId).eq("userId", who.subject),
      )
      .unique(),
  );

describe("the people list", () => {
  test("is every member's to read, and only an admin sees open invitations", async () => {
    const t = harness();
    const w = await world(t);
    await t.withIdentity(ADMIN).mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: NEWCOMER.email,
      role: "member",
    });

    const asMember = await t.withIdentity(MEMBER).query(api.members.list, {
      workspaceId: w.workspaceId,
    });
    expect(asMember?.role).toBe("member");
    expect(asMember?.members.map((m) => [m.name, m.role, m.isMe])).toEqual([
      ["Olive", "owner", false],
      ["Ada", "admin", false],
      ["Cy", "member", false],
      ["Max", "member", true],
      ["Gus", "guest", false],
    ]);
    expect(asMember?.invitations).toEqual([]);

    const asAdmin = await t.withIdentity(ADMIN).query(api.members.list, {
      workspaceId: w.workspaceId,
    });
    expect(asAdmin?.invitations).toMatchObject([
      { email: NEWCOMER.email, role: "member", token: expect.any(String) },
    ]);
    expect(
      (await t.withIdentity(STAND_IN).query(api.members.list, { workspaceId: w.workspaceId }))
        ?.invitations,
    ).toHaveLength(1);
  });

  test("is null to a guest and to anyone without a seat", async () => {
    const t = harness();
    const w = await world(t);
    for (const who of [GUEST, REMOVED, STRANGER, null]) {
      expect(await as(t, who).query(api.members.list, { workspaceId: w.workspaceId })).toBeNull();
    }
  });
});

describe("an invitation", () => {
  const invite = (t: T, who: Identity, w: World, email: string, role: "admin" | "member" | "guest") =>
    t.withIdentity(who).mutation(api.members.invite, { workspaceId: w.workspaceId, email, role });

  test("is an admin's to send, and an admin's own rank is an owner's to offer", async () => {
    const t = harness();
    const w = await world(t);
    await expect(invite(t, ADMIN, w, "a@acme.com", "member")).resolves.toBeTruthy();
    await expect(invite(t, ADMIN, w, "b@acme.com", "guest")).resolves.toBeTruthy();
    await expect(invite(t, ADMIN, w, "c@acme.com", "admin")).rejects.toThrow(
      "Only a workspace owner can invite an admin.",
    );
    await expect(invite(t, OWNER, w, "c@acme.com", "admin")).resolves.toBeTruthy();
    // …and changing that invitation is the owner's too.
    await expect(invite(t, ADMIN, w, "c@acme.com", "member")).rejects.toThrow(
      "Only a workspace owner can change an admin’s invitation.",
    );
    await expect(invite(t, MEMBER, w, "d@acme.com", "guest")).rejects.toThrow(
      "Only a workspace admin can do that.",
    );
    await expect(invite(t, GUEST, w, "d@acme.com", "guest")).rejects.toThrow(
      "Only a workspace admin can do that.",
    );
    await expect(invite(t, STRANGER, w, "d@acme.com", "guest")).rejects.toThrow("Not found");
    await expect(invite(t, STAND_IN, w, "d@acme.com", "guest")).rejects.toThrow("Read-only");
  });

  test("is for one normalized address, never someone already in", async () => {
    const t = harness();
    const w = await world(t);
    await invite(t, ADMIN, w, "  Nia@ACME.com ", "member");
    const [row] = await t.run((ctx) => ctx.db.query("invitations").collect());
    expect(row).toMatchObject({
      email: "nia@acme.com",
      role: "member",
      invitedBy: ADMIN.subject,
      workspaceId: w.workspaceId,
    });
    expect(row.expiresAt - row.createdAt).toBe(14 * 24 * 60 * 60 * 1000);

    await expect(invite(t, ADMIN, w, "not an address", "member")).rejects.toThrow(
      "doesn’t look like an email address",
    );
    // Profiles hold the address as the sign-in gave it; the match ignores case.
    await expect(invite(t, ADMIN, w, "Max@acme.com", "member")).rejects.toThrow(
      "max@acme.com is already in Acme.",
    );
    // Someone who used to be here can be asked back.
    await expect(invite(t, ADMIN, w, REMOVED.email, "member")).resolves.toBeTruthy();
  });

  test("asked again, renews the one already open", async () => {
    const t = harness();
    const w = await world(t);
    const first = await invite(t, ADMIN, w, NEWCOMER.email, "guest");
    expect(first.replaced).toBe(false);
    await t.run((ctx) => ctx.db.patch(first.invitationId, { expiresAt: 0 }));
    const second = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    expect(second.invitationId).toBe(first.invitationId);
    expect(second.token).not.toBe(first.token);
    // A lapsed link was dead already; only a live one is said to be replaced.
    expect(second.replaced).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("invitations").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "member", token: second.token });
    expect(rows[0].expiresAt).toBeGreaterThan(Date.now());

    const newcomer = t.withIdentity(NEWCOMER);
    expect(await newcomer.query(api.members.invitation, { token: first.token })).toBeNull();
    await expect(
      newcomer.mutation(api.members.acceptInvite, { token: first.token }),
    ).rejects.toThrow("Not found");
    await expect(
      newcomer.mutation(api.members.acceptInvite, { token: second.token }),
    ).resolves.toEqual(arrived(w, "member"));
  });

  test("asked again while its link works, says that link is replaced", async () => {
    const t = harness();
    const w = await world(t);
    const first = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    const second = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    expect(second).toMatchObject({ invitationId: first.invitationId, replaced: true });
    expect(
      await t.withIdentity(NEWCOMER).query(api.members.invitation, { token: first.token }),
    ).toBeNull();
  });

  test("in a deleted workspace, says so rather than withdrawn", async () => {
    const t = harness();
    const w = await world(t);
    const { token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    await t.withIdentity(OWNER).mutation(api.workspaces.remove, { workspaceId: w.workspaceId });
    const newcomer = t.withIdentity(NEWCOMER);
    expect(await newcomer.query(api.members.invitation, { token })).toMatchObject({
      state: "gone",
      workspaceName: "Acme",
    });
    await expect(newcomer.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
      "Not found",
    );
  });

  test("withdrawn, admits no one", async () => {
    const t = harness();
    const w = await world(t);
    const { invitationId, token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    await expect(
      t.withIdentity(MEMBER).mutation(api.members.revokeInvite, { invitationId }),
    ).rejects.toThrow("Only a workspace admin");
    await expect(
      t.withIdentity(STAND_IN).mutation(api.members.revokeInvite, { invitationId }),
    ).rejects.toThrow("Read-only");
    await t.withIdentity(ADMIN).mutation(api.members.revokeInvite, { invitationId });

    const newcomer = t.withIdentity(NEWCOMER);
    expect(await newcomer.query(api.members.invitation, { token })).toMatchObject({
      state: "revoked",
    });
    await expect(newcomer.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
      "This invitation was withdrawn.",
    );
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toBeNull();
    expect(
      (await t.withIdentity(ADMIN).query(api.members.list, { workspaceId: w.workspaceId }))
        ?.invitations,
    ).toEqual([]);
  });

  test("an admin's invitation is withdrawn by an owner, and an accepted one by nobody", async () => {
    const t = harness();
    const w = await world(t);
    const asAdmin = await invite(t, OWNER, w, "boss@acme.com", "admin");
    await expect(
      t.withIdentity(ADMIN).mutation(api.members.revokeInvite, {
        invitationId: asAdmin.invitationId,
      }),
    ).rejects.toThrow("Only a workspace owner can withdraw an admin’s invitation.");
    await t
      .withIdentity(OWNER)
      .mutation(api.members.revokeInvite, { invitationId: asAdmin.invitationId });

    const { invitationId, token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
    await t.withIdentity(NEWCOMER).mutation(api.members.acceptInvite, { token });
    await expect(
      t.withIdentity(ADMIN).mutation(api.members.revokeInvite, { invitationId }),
    ).rejects.toThrow("already been accepted");
  });

  describe("seen from the invitation page", () => {
    test("says what it offers to the address it is for", async () => {
      const t = harness();
      const w = await world(t);
      const { invitationId, token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
      const newcomer = t.withIdentity(NEWCOMER);
      expect(await newcomer.query(api.members.invitation, { token })).toEqual({
        state: "valid",
        email: NEWCOMER.email,
        role: "member",
        workspaceName: "Acme",
        workspaceIcon: null,
        inviterName: "Ada",
        slug: null,
      });

      await t.run((ctx) => ctx.db.patch(invitationId, { expiresAt: Date.now() - 1 }));
      expect(await newcomer.query(api.members.invitation, { token })).toMatchObject({
        state: "expired",
      });
      await t.run((ctx) => ctx.db.patch(invitationId, { expiresAt: Date.now() + 60_000 }));
      await newcomer.mutation(api.members.acceptInvite, { token });
      expect(await newcomer.query(api.members.invitation, { token })).toMatchObject({
        state: "accepted",
        slug: "acme",
      });
    });

    test("tells anyone else only that it is someone else's", async () => {
      const t = harness();
      const w = await world(t);
      const { token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
      for (const who of [STRANGER, MEMBER]) {
        expect(await t.withIdentity(who).query(api.members.invitation, { token })).toEqual({
          state: "wrong-account",
          email: "n••@acme.com",
        });
      }
      // A sign-in that vouches for no address may be the right person, so it
      // is not told the invitation is someone else's — and learns no more.
      for (const who of [{ ...NEWCOMER, emailVerified: false }, { subject: NEWCOMER.subject }]) {
        expect(await t.withIdentity(who).query(api.members.invitation, { token })).toEqual({
          state: "unconfirmed",
        });
      }
      expect(await t.query(api.members.invitation, { token })).toBeNull();
      expect(
        await t.withIdentity(NEWCOMER).query(api.members.invitation, { token: "nope" }),
      ).toBeNull();
    });

    test("masks an address down to its first letter and domain", () => {
      expect(maskEmail("nia@acme.com")).toBe("n••@acme.com");
      expect(maskEmail("a@acme.com")).toBe("a••@acme.com");
      expect(maskEmail("alexandria@acme.com")).toBe("a••••••@acme.com");
    });
  });

  describe("accepted", () => {
    test("seats the address it names, and makes it a profile that skips the welcome", async () => {
      const t = harness();
      const w = await world(t);
      const { token } = await invite(t, ADMIN, w, NEWCOMER.email, "guest");
      const newcomer = t.withIdentity({ ...NEWCOMER, email: "Nia@Acme.com" });
      await expect(newcomer.mutation(api.members.acceptInvite, { token })).resolves.toEqual(
        arrived(w, "guest"),
      );

      expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
        role: "guest",
        status: "active",
        invitedBy: ADMIN.subject,
      });
      const after = await t.run(async (ctx) => ({
        invitation: (await ctx.db.query("invitations").collect())[0],
        profile: await ctx.db
          .query("profiles")
          .withIndex("by_owner", (q) => q.eq("ownerId", NEWCOMER.subject))
          .unique(),
      }));
      expect(after.invitation).toMatchObject({ acceptedBy: NEWCOMER.subject });
      expect(after.invitation.acceptedAt).toBeTypeOf("number");
      expect(after.profile).toMatchObject({ status: "skipped", hints: ["tester-note"] });

      // Twice is the same answer; nobody else can use it after.
      await expect(newcomer.mutation(api.members.acceptInvite, { token })).resolves.toEqual(
        arrived(w, "guest"),
      );
      await expect(
        t.withIdentity({ subject: "user_twin", email: NEWCOMER.email }).mutation(
          api.members.acceptInvite,
          { token },
        ),
      ).rejects.toThrow("already been used");
    });

    test("is refused to any other account, an unverified one and a late one", async () => {
      const t = harness();
      const w = await world(t);
      const { invitationId, token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
      for (const who of [STRANGER, { ...NEWCOMER, emailVerified: false }, { subject: NEWCOMER.subject }]) {
        await expect(
          t.withIdentity(who).mutation(api.members.acceptInvite, { token }),
        ).rejects.toThrow("This invitation is for another account.");
      }
      await expect(
        t.withIdentity({ ...NEWCOMER, act: "ops" }).mutation(api.members.acceptInvite, { token }),
      ).rejects.toThrow("Read-only");
      await expect(t.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
        "Not signed in",
      );

      await t.run((ctx) => ctx.db.patch(invitationId, { expiresAt: Date.now() - 1 }));
      await expect(
        t.withIdentity(NEWCOMER).mutation(api.members.acceptInvite, { token }),
      ).rejects.toThrow("This invitation has expired.");
      expect(await seatOf(t, w.workspaceId, NEWCOMER)).toBeNull();
    });

    test("brings someone back on their old row", async () => {
      const t = harness();
      const w = await world(t);
      const back = await invite(t, ADMIN, w, REMOVED.email, "member");
      await t.withIdentity(REMOVED).mutation(api.members.acceptInvite, { token: back.token });
      const seats = await t.run((ctx) =>
        ctx.db
          .query("memberships")
          .withIndex("by_workspace_user", (q) =>
            q.eq("workspaceId", w.workspaceId).eq("userId", REMOVED.subject),
          )
          .collect(),
      );
      expect(seats).toHaveLength(1);
      expect(seats[0]).toMatchObject({ status: "active", role: "member" });
      expect(seats[0].removedAt).toBeUndefined();
      expect(seats[0].removedBy).toBeUndefined();
    });

    test("is a way in, never a way up or down for a seat already held", async () => {
      const t = harness();
      const w = await world(t);
      // Nia walks in by the domain. Her profile carries no address yet, so
      // nothing stops an invitation to her while she is in — and an admin
      // then makes her a guest.
      await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
        workspaceId: w.workspaceId,
        patch: { joinDomains: ["acme.com"], autoJoin: true },
      });
      const nia = t.withIdentity(NEWCOMER);
      await nia.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
      const { token } = await invite(t, ADMIN, w, NEWCOMER.email, "member");
      await t.withIdentity(ADMIN).mutation(api.members.setRole, {
        workspaceId: w.workspaceId,
        userId: NEWCOMER.subject,
        role: "guest",
      });

      expect(await nia.query(api.members.invitation, { token })).toMatchObject({
        state: "accepted",
        role: "guest",
        slug: "acme",
      });
      await expect(nia.mutation(api.members.acceptInvite, { token })).resolves.toEqual(
        arrived(w, "guest"),
      );
      expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
        status: "active",
        role: "guest",
      });
      // Answered, so it leaves the admins' list and is no way back in later.
      expect(
        (await t.withIdentity(ADMIN).query(api.members.list, { workspaceId: w.workspaceId }))
          ?.invitations,
      ).toEqual([]);
      await nia.mutation(api.members.leave, { workspaceId: w.workspaceId });
      await expect(nia.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
        "already been used",
      );

      // An admin who signed up under a second address is not demoted by it.
      await t.run(async (ctx) => {
        await ctx.db.insert("invitations", {
          workspaceId: w.workspaceId,
          email: "ada@acme.com",
          role: "guest",
          token: "for-ada",
          invitedBy: OWNER.subject,
          createdAt: 1,
          expiresAt: Date.now() + 60_000,
        });
      });
      await t.withIdentity(ADMIN).mutation(api.members.acceptInvite, { token: "for-ada" });
      expect(await seatOf(t, w.workspaceId, ADMIN)).toMatchObject({ role: "admin" });
    });
  });
});

describe("joining by domain", () => {
  async function openDomain(t: T, w: World, autoJoin = true) {
    await t.withIdentity(ADMIN).mutation(api.workspaces.updateSettings, {
      workspaceId: w.workspaceId,
      patch: { joinDomains: ["acme.com"], autoJoin },
    });
  }

  test("lets a verified address on the domain walk in as a member", async () => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    const newcomer = t.withIdentity(NEWCOMER);
    expect(await newcomer.query(api.members.joinable, {})).toEqual([
      { workspaceId: w.workspaceId, name: "Acme", icon: null, role: "member", via: "domain", token: null },
    ]);
    await expect(
      newcomer.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId }),
    ).resolves.toEqual(arrived(w, "member"));
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
      role: "member",
      status: "active",
    });
    expect(await newcomer.query(api.members.joinable, {})).toEqual([]);
    await expect(
      newcomer.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId }),
    ).resolves.toEqual(arrived(w, "member"));
  });

  test("admits no one off the domain, unverified, or while auto-join is off", async () => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w, false);
    const join = (who: Identity) =>
      t.withIdentity(who).mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    await expect(join(NEWCOMER)).rejects.toThrow("Not found");
    expect(await t.withIdentity(NEWCOMER).query(api.members.joinable, {})).toEqual([]);

    await openDomain(t, w);
    await expect(join(STRANGER)).rejects.toThrow("Not found");
    await expect(join({ ...NEWCOMER, emailVerified: false })).rejects.toThrow("Not found");
    await expect(join({ ...NEWCOMER, email: "nia@acme.com.evil.io" })).rejects.toThrow(
      "Not found",
    );
    await expect(join({ ...NEWCOMER, act: "ops" })).rejects.toThrow("Read-only");
    expect(await t.withIdentity(STRANGER).query(api.members.joinable, {})).toEqual([]);
  });

  test("does not overrule a removal, but welcomes back someone who left", async () => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    expect(await t.withIdentity(REMOVED).query(api.members.joinable, {})).toEqual([]);
    await expect(
      t.withIdentity(REMOVED).mutation(api.members.joinByDomain, { workspaceId: w.workspaceId }),
    ).rejects.toThrow("Not found");

    await t.withIdentity(MEMBER).mutation(api.members.leave, { workspaceId: w.workspaceId });
    expect(await t.withIdentity(MEMBER).query(api.members.joinable, {})).toMatchObject([
      { via: "domain" },
    ]);
    await t.withIdentity(MEMBER).mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({
      status: "active",
      role: "member",
    });
  });

  test("brings someone back no higher than they left, so leaving undoes no demotion", async () => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    await t.withIdentity(ADMIN).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: MEMBER.subject,
      role: "guest",
    });
    const max = t.withIdentity(MEMBER);
    await max.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({ role: "guest" });

    await max.mutation(api.members.leave, { workspaceId: w.workspaceId });
    expect(await max.query(api.members.joinable, {})).toEqual([
      { workspaceId: w.workspaceId, name: "Acme", icon: null, role: "guest", via: "domain", token: null },
    ]);
    await max.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({
      status: "active",
      role: "guest",
    });
  });

  test.each([
    ["an admin's invitation to be a member", ADMIN, "member"],
    ["an owner's invitation to be an admin", OWNER, "admin"],
  ] as const)("answers %s, so it undoes no demotion later", async (_, inviter, role) => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    const { token } = await t.withIdentity(inviter).mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: NEWCOMER.email,
      role,
    });
    const nia = t.withIdentity(NEWCOMER);
    await nia.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({ role: "member" });
    expect(
      (await t.withIdentity(inviter).query(api.members.list, { workspaceId: w.workspaceId }))
        ?.invitations,
    ).toEqual([]);

    await t.withIdentity(OWNER).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: NEWCOMER.subject,
      role: "guest",
    });
    await expect(nia.mutation(api.members.acceptInvite, { token })).resolves.toEqual(
      arrived(w, "guest"),
    );
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
      status: "active",
      role: "guest",
    });

    // Nor, once they have left, does it bring them back.
    await nia.mutation(api.members.leave, { workspaceId: w.workspaceId });
    await expect(nia.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
      "already been used",
    );
  });

  test("an invitation from before someone left brings them back no higher than they left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = harness();
    const w = await world(t);
    // Open since before either left — sent while their profiles showed some
    // other address, which is all `invite` has to check who is already in.
    await t.run(async (ctx) => {
      for (const [email, token] of [
        ["max@acme.com", "for-max"],
        ["ada@acme.com", "for-ada"],
      ]) {
        await ctx.db.insert("invitations", {
          workspaceId: w.workspaceId,
          email,
          role: "admin",
          token,
          invitedBy: OWNER.subject,
          createdAt: Date.now(),
          expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000,
        });
      }
    });
    vi.setSystemTime(Date.now() + 60_000);
    await t.withIdentity(ADMIN).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: MEMBER.subject,
      role: "guest",
    });
    const max = t.withIdentity(MEMBER);
    const ada = t.withIdentity(ADMIN);
    vi.setSystemTime(Date.now() + 60_000);
    await max.mutation(api.members.leave, { workspaceId: w.workspaceId });
    await ada.mutation(api.members.leave, { workspaceId: w.workspaceId });

    // A demoted guest comes back a guest; an admin who walked out, a member.
    expect(await max.query(api.members.joinable, {})).toEqual([
      { workspaceId: w.workspaceId, name: "Acme", icon: null, role: "guest", via: "invitation", token: "for-max" },
    ]);
    expect(await max.query(api.members.invitation, { token: "for-max" })).toMatchObject({
      state: "valid",
      role: "guest",
    });
    await max.mutation(api.members.acceptInvite, { token: "for-max" });
    await ada.mutation(api.members.acceptInvite, { token: "for-ada" });
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({
      status: "active",
      role: "guest",
    });
    expect(await seatOf(t, w.workspaceId, ADMIN)).toMatchObject({
      status: "active",
      role: "member",
    });

    // Asked back since leaving, they get all the invitation names.
    vi.setSystemTime(Date.now() + 60_000);
    await max.mutation(api.members.leave, { workspaceId: w.workspaceId });
    vi.setSystemTime(Date.now() + 60_000);
    const { token } = await t.withIdentity(OWNER).mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: MEMBER.email,
      role: "admin",
    });
    await max.mutation(api.members.acceptInvite, { token });
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({
      status: "active",
      role: "admin",
    });
  });

  test("an invitation sent before an admin removed someone does not bring them back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    const invite = () =>
      t.withIdentity(ADMIN).mutation(api.members.invite, {
        workspaceId: w.workspaceId,
        email: NEWCOMER.email,
        role: "member",
      });
    // In by the domain; her profile carries no address yet, so nothing stops
    // an invitation to her while she is in.
    const nia = t.withIdentity(NEWCOMER);
    await nia.mutation(api.members.joinByDomain, { workspaceId: w.workspaceId });
    const { token } = await invite();
    vi.setSystemTime(Date.now() + 60_000);
    await t.withIdentity(ADMIN).mutation(api.members.remove, {
      workspaceId: w.workspaceId,
      userId: NEWCOMER.subject,
    });

    expect(await nia.query(api.members.joinable, {})).toEqual([]);
    expect(await nia.query(api.members.invitation, { token })).toMatchObject({
      state: "revoked",
    });
    await expect(nia.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
      "This invitation was withdrawn.",
    );
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({ status: "removed" });

    // Asked back since, they come back.
    vi.setSystemTime(Date.now() + 60_000);
    const again = await invite();
    expect(await nia.query(api.members.joinable, {})).toMatchObject([
      { via: "invitation", token: again.token },
    ]);
    await nia.mutation(api.members.acceptInvite, { token: again.token });
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
      status: "active",
      role: "member",
    });
  });

  test("lists open invitations beside domains, one door per workspace", async () => {
    const t = harness();
    const w = await world(t);
    await openDomain(t, w);
    const { token } = await t.withIdentity(ADMIN).mutation(api.members.invite, {
      workspaceId: w.workspaceId,
      email: NEWCOMER.email,
      role: "guest",
    });
    expect(await t.withIdentity(NEWCOMER).query(api.members.joinable, {})).toEqual([
      { workspaceId: w.workspaceId, name: "Acme", icon: null, role: "guest", via: "invitation", token },
    ]);
    await t.withIdentity(OWNER).mutation(api.workspaces.remove, { workspaceId: w.workspaceId });
    expect(await t.withIdentity(NEWCOMER).query(api.members.joinable, {})).toEqual([]);
  });
});

describe("changing a role", () => {
  const setRole = (t: T, who: Identity, w: World, target: Identity, role: Doc<"memberships">["role"]) =>
    t.withIdentity(who).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: target.subject,
      role,
    });

  test("an admin moves people between member and guest, and no further", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId: w.workspaceId,
        userId: NEWCOMER.subject,
        role: "admin",
        status: "active",
        joinedAt: 20,
      });
    });
    await setRole(t, ADMIN, w, MEMBER, "guest");
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({ role: "guest" });
    await setRole(t, ADMIN, w, MEMBER, "member");
    await expect(setRole(t, ADMIN, w, MEMBER, "admin")).rejects.toThrow(
      "Only a workspace owner can do that.",
    );
    await expect(setRole(t, ADMIN, w, OWNER, "member")).rejects.toThrow(
      "Only a workspace owner can do that.",
    );
    // Nor a peer: another admin is an owner's to demote.
    for (const role of ["member", "guest", "owner"] as const) {
      await expect(setRole(t, ADMIN, w, NEWCOMER, role)).rejects.toThrow(
        "Only a workspace owner can do that.",
      );
    }
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({ role: "admin" });
    await expect(setRole(t, ADMIN, w, ADMIN, "member")).rejects.toThrow(
      "You can’t change your own role.",
    );
    await expect(setRole(t, MEMBER, w, GUEST, "member")).rejects.toThrow(
      "Only a workspace admin",
    );
    await expect(setRole(t, ADMIN, w, REMOVED, "member")).rejects.toThrow("Not found");
    await expect(setRole(t, ADMIN, w, STRANGER, "member")).rejects.toThrow("Not found");
    await expect(setRole(t, STAND_IN, w, MEMBER, "guest")).rejects.toThrow("Read-only");
  });

  test("an owner appoints admins and owners, and steps down only once there is another", async () => {
    const t = harness();
    const w = await world(t);
    await expect(setRole(t, OWNER, w, OWNER, "admin")).rejects.toThrow(
      "A workspace needs an owner.",
    );
    await setRole(t, OWNER, w, MEMBER, "admin");
    await setRole(t, OWNER, w, ADMIN, "owner");
    await setRole(t, OWNER, w, OWNER, "admin");
    expect(await seatOf(t, w.workspaceId, OWNER)).toMatchObject({ role: "admin" });
    await expect(setRole(t, ADMIN, w, ADMIN, "member")).rejects.toThrow(
      "A workspace needs an owner.",
    );
    await setRole(t, ADMIN, w, MEMBER, "member");
    expect(await seatOf(t, w.workspaceId, MEMBER)).toMatchObject({ role: "member" });
  });

  describe("takes back the invitations the old rank sent", () => {
    /** Someone off the domain an owner might ask in — say, an account of their own. */
    const ALT = { subject: "user_alt", email: "alt@elsewhere.org" };
    const send = (t: T, who: Identity, w: World, email: string, role: "admin" | "member" | "guest") =>
      t.withIdentity(who).mutation(api.members.invite, { workspaceId: w.workspaceId, email, role });
    const open = async (t: T, w: World) =>
      (await t.withIdentity(ADMIN).query(api.members.list, { workspaceId: w.workspaceId }))!
        .invitations.map((i) => [i.email, i.role])
        .sort();

    test("so an owner demoted before an admin's invitation is answered seats no admin", async () => {
      const t = harness();
      const w = await world(t);
      await setRole(t, OWNER, w, ADMIN, "owner");
      const { token } = await send(t, OWNER, w, ALT.email, "admin");
      const alt = t.withIdentity(ALT);
      expect(await alt.query(api.members.invitation, { token })).toMatchObject({
        state: "valid",
        role: "admin",
      });
      expect(await alt.query(api.members.joinable, {})).toMatchObject([
        { role: "admin", via: "invitation", token },
      ]);

      await setRole(t, ADMIN, w, OWNER, "member");

      expect(await alt.query(api.members.invitation, { token })).toMatchObject({
        state: "revoked",
      });
      expect(await alt.query(api.members.joinable, {})).toEqual([]);
      await expect(alt.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
        "This invitation was withdrawn.",
      );
      expect(await seatOf(t, w.workspaceId, ALT)).toBeNull();
      // Given the rank back, they are given none of what it sent.
      await setRole(t, ADMIN, w, OWNER, "owner");
      await expect(alt.mutation(api.members.acceptInvite, { token })).rejects.toThrow(
        "This invitation was withdrawn.",
      );
    });

    test("and only those: each step down takes what the rank below could not send", async () => {
      const t = harness();
      const w = await world(t);
      await send(t, ADMIN, w, "ari@acme.com", "member");
      // A promotion takes nothing back.
      await setRole(t, OWNER, w, ADMIN, "owner");
      await send(t, OWNER, w, ALT.email, "admin");
      await send(t, OWNER, w, "mo@acme.com", "member");
      await send(t, OWNER, w, "gia@partner.io", "guest");
      expect(await open(t, w)).toEqual([
        [ALT.email, "admin"],
        ["ari@acme.com", "member"],
        ["gia@partner.io", "guest"],
        ["mo@acme.com", "member"],
      ]);

      await setRole(t, ADMIN, w, OWNER, "admin");
      expect(await open(t, w)).toEqual([
        ["ari@acme.com", "member"],
        ["gia@partner.io", "guest"],
        ["mo@acme.com", "member"],
      ]);

      // A member invites no one; what someone else sent is theirs.
      await setRole(t, ADMIN, w, OWNER, "member");
      expect(await open(t, w)).toEqual([["ari@acme.com", "member"]]);
    });
  });
});

describe("taking a seat away", () => {
  /** What CREATOR holds beyond their seat: requests, claims, history, an invitation. */
  async function entanglements(t: T, w: World) {
    return await t.run(async (ctx) => {
      await ctx.db.patch(w.open.projectId, { shareToken: "view" });
      // A stranger waiting on the creator's project.
      await ctx.db.insert("shareClaims", {
        projectId: w.open.projectId,
        granteeId: STRANGER.subject,
        role: "viewer",
        createdAt: 1,
      });
      const incoming = await ctx.db.insert("accessRequests", {
        projectId: w.open.projectId,
        requesterId: STRANGER.subject,
        projectOwnerId: CREATOR.subject,
        workspaceId: w.workspaceId,
        status: "pending",
        createdAt: 1,
      });
      // The creator's own claims and requests: on another member's private
      // project here, and on a stranger's personal project elsewhere.
      await ctx.db.patch(w.others.projectId, { visibility: "private", shareToken: "hiring" });
      for (const projectId of [w.others.projectId, w.personal]) {
        await ctx.db.insert("shareClaims", {
          projectId,
          granteeId: CREATOR.subject,
          role: "viewer",
          createdAt: 1,
        });
        await ctx.db.insert("accessRequests", {
          projectId,
          requesterId: CREATOR.subject,
          projectOwnerId: projectId === w.personal ? STRANGER.subject : MEMBER.subject,
          ...(projectId === w.personal ? {} : { workspaceId: w.workspaceId }),
          status: "pending",
          createdAt: 1,
        });
      }
      const threadId = await ctx.db.insert("chatThreads", {
        ownerId: CREATOR.subject,
        projectId: w.open.projectId,
        title: "Pricing",
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("chatMessages", {
        ownerId: CREATOR.subject,
        threadId,
        uiId: "m1",
        role: "assistant",
        seq: 0,
        parts: [{ type: "text", text: "The plan says…" }],
        createdAt: 1,
      });
      const checkpointId = await ctx.db.insert("checkpoints", {
        ownerId: CREATOR.subject,
        pageId: w.open.pageId,
        chatPromptId: "turn-1",
        docSnapshot: [],
        createdAt: 1,
      });
      // An invitation the creator once sent, as an admin, still unanswered.
      await ctx.db.insert("invitations", {
        workspaceId: w.workspaceId,
        email: "friend@acme.com",
        role: "member",
        token: "from-cy",
        invitedBy: CREATOR.subject,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      });
      return { incoming, threadId, checkpointId };
    });
  }

  test("hands what they made to whoever removed them, and closes every way back", async () => {
    const t = harness();
    const w = await world(t);
    const held = await entanglements(t, w);
    const cy = t.withIdentity(CREATOR);
    expect(await cy.query(api.projects.myRole, { projectId: w.others.projectId })).toBe("viewer");
    expect(await cy.query(api.chat.messages.list, { threadId: held.threadId })).toHaveLength(1);

    await t.withIdentity(ADMIN).mutation(api.members.remove, {
      workspaceId: w.workspaceId,
      userId: CREATOR.subject,
    });

    const after = await t.run(async (ctx) => ({
      seat: await ctx.db
        .query("memberships")
        .withIndex("by_workspace_user", (q) =>
          q.eq("workspaceId", w.workspaceId).eq("userId", CREATOR.subject),
        )
        .unique(),
      owners: await Promise.all(
        [w.open, w.secret, w.binned, w.others].map(
          async (p) => (await ctx.db.get(p.projectId))!.ownerId,
        ),
      ),
      page: (await ctx.db.get(w.open.pageId))!,
      incoming: (await ctx.db.get(held.incoming))!,
      claims: await ctx.db
        .query("shareClaims")
        .withIndex("by_grantee", (q) => q.eq("granteeId", CREATOR.subject))
        .collect(),
      asked: await ctx.db
        .query("accessRequests")
        .withIndex("by_requester_and_status", (q) => q.eq("requesterId", CREATOR.subject))
        .collect(),
      invitation: (await ctx.db
        .query("invitations")
        .withIndex("by_token", (q) => q.eq("token", "from-cy"))
        .unique())!,
    }));
    expect(after.seat).toMatchObject({ status: "removed", removedBy: ADMIN.subject });
    expect(after.owners).toEqual([
      ADMIN.subject,
      ADMIN.subject,
      ADMIN.subject,
      MEMBER.subject,
    ]);
    // Pages keep the name they were made under; NML migration keys on it.
    expect(after.page.ownerId).toBe(CREATOR.subject);
    expect(after.incoming.projectOwnerId).toBe(ADMIN.subject);
    expect(after.claims.map((c) => c.projectId)).toEqual([w.personal]);
    expect(after.asked.map((r) => r.projectId)).toEqual([w.personal]);
    expect(after.invitation.revokedAt).toBeTypeOf("number");

    // Refused at once, everywhere — the link included.
    for (const p of [w.open, w.secret, w.others]) {
      expect(await cy.query(api.projects.myRole, { projectId: p.projectId })).toBeNull();
    }
    await expect(cy.query(api.ydoc.state, { docId: w.secret.docId })).rejects.toThrow(
      "Not found",
    );
    expect(await cy.query(api.chat.threads.get, { threadId: held.threadId })).toBeNull();
    expect(await cy.query(api.chat.messages.list, { threadId: held.threadId })).toEqual([]);
    expect(await cy.query(api.ai.checkpoints.get, { id: held.checkpointId })).toBeNull();
    expect(await cy.query(api.workspaces.bySlug, { slug: "acme" })).toBeNull();
    expect(await cy.query(api.projects.myRole, { projectId: w.personal })).toBe("viewer");

    // Their old inbox is empty; the admin's holds the stranger's request.
    expect(await cy.query(api.share.incomingRequests, {})).toEqual([]);
    // Once, though it now reaches the admin both as the project's and as the workspace's.
    expect(
      (await t.withIdentity(ADMIN).query(api.share.incomingRequests, {})).map((r) => r.projectId),
    ).toEqual([w.open.projectId]);
  });

  test("unlinks what they linked, since each is read with their own connection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("No network in tests");
      }),
    );
    const t = harness();
    const w = await world(t);
    const linked = await t.run(async (ctx) => {
      const repo = (who: Identity, projectId: Id<"projects">, fullName: string) =>
        ctx.db.insert("projectRepos", {
          ownerId: who.subject,
          projectId,
          fullName,
          defaultBranch: "main",
          private: true,
          addedAt: 1,
        });
      const page = (who: Identity, projectId: Id<"projects">, pageId: string) =>
        ctx.db.insert("projectNotion", {
          ownerId: who.subject,
          projectId,
          pageId,
          title: pageId,
          index: { state: "ready" },
          addedAt: 1,
        });
      const node = (projectId: Id<"projects">, externalId: string, repoId?: Id<"projectRepos">) =>
        ctx.db.insert("contextNodes", {
          projectId,
          source: repoId ? "github" : "notion",
          ...(repoId ? { repoId } : {}),
          tier: "source",
          kind: repoId ? "repo" : "document",
          externalId,
          title: externalId,
          brief: "",
          owner: {},
        });
      const diary = await ctx.db.insert("projects", {
        ownerId: CREATOR.subject,
        title: "Diary",
        createdAt: 1,
      });
      const cyRepo = await repo(CREATOR, w.open.projectId, "acme/api");
      return {
        repos: {
          cy: cyRepo,
          cyInTrash: await repo(CREATOR, w.binned.projectId, "acme/old"),
          cyOutside: await repo(CREATOR, diary, "cy/dotfiles"),
          ada: await repo(ADMIN, w.open.projectId, "acme/web"),
        },
        pages: {
          cy: await page(CREATOR, w.secret.projectId, "brief"),
          ada: await page(ADMIN, w.open.projectId, "handbook"),
        },
        nodes: {
          cyRepo: await node(w.open.projectId, "github:acme/api", cyRepo),
          cyPage: await node(w.secret.projectId, "notion:brief"),
        },
      };
    });
    /** Which of those rows are still there. */
    const still = () =>
      t.run(async (ctx) => {
        const here = async (ids: Record<string, Id<"projectRepos" | "projectNotion" | "contextNodes">>) =>
          Object.fromEntries(
            await Promise.all(
              Object.entries(ids).map(async ([name, id]) => [name, !!(await ctx.db.get(id))]),
            ),
          );
        return {
          repos: await here(linked.repos),
          pages: await here(linked.pages),
          nodes: await here(linked.nodes),
        };
      });

    await t.withIdentity(ADMIN).mutation(api.members.remove, {
      workspaceId: w.workspaceId,
      userId: CREATOR.subject,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await still()).toEqual({
      repos: { cy: false, cyInTrash: false, cyOutside: true, ada: true },
      pages: { cy: false, ada: true },
      nodes: { cyRepo: false, cyPage: false },
    });

    // Leaving takes them just the same.
    await t.withIdentity(ADMIN).mutation(api.members.leave, { workspaceId: w.workspaceId });
    expect(await still()).toMatchObject({
      repos: { ada: false, cyOutside: true },
      pages: { ada: false },
    });
  });

  test("an admin removes members and guests; admins and owners are an owner's", async () => {
    const t = harness();
    const w = await world(t);
    const remove = (who: Identity, target: Identity) =>
      t.withIdentity(who).mutation(api.members.remove, {
        workspaceId: w.workspaceId,
        userId: target.subject,
      });
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId: w.workspaceId,
        userId: NEWCOMER.subject,
        role: "admin",
        status: "active",
        joinedAt: 20,
      });
    });
    await expect(remove(ADMIN, OWNER)).rejects.toThrow(
      "Only a workspace owner can remove an admin or an owner.",
    );
    await expect(remove(ADMIN, NEWCOMER)).rejects.toThrow(
      "Only a workspace owner can remove an admin or an owner.",
    );
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({
      status: "active",
      role: "admin",
    });
    await expect(remove(ADMIN, ADMIN)).rejects.toThrow("use Leave instead");
    await expect(remove(MEMBER, GUEST)).rejects.toThrow("Only a workspace admin");
    await expect(remove(STAND_IN, GUEST)).rejects.toThrow("Read-only");
    await remove(ADMIN, GUEST);
    await expect(remove(ADMIN, GUEST)).rejects.toThrow("Not found");
    await remove(OWNER, ADMIN);
    expect(await seatOf(t, w.workspaceId, ADMIN)).toMatchObject({ status: "removed" });

    await t.withIdentity(OWNER).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: NEWCOMER.subject,
      role: "owner",
    });
    await remove(OWNER, NEWCOMER);
    expect(await seatOf(t, w.workspaceId, NEWCOMER)).toMatchObject({ status: "removed" });
  });

  test("leaving hands what they made to the longest-standing owner", async () => {
    const t = harness();
    const w = await world(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", {
        workspaceId: w.workspaceId,
        userId: NEWCOMER.subject,
        role: "owner",
        status: "active",
        joinedAt: 20,
      });
    });
    await t.withIdentity(CREATOR).mutation(api.members.leave, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, CREATOR)).toMatchObject({
      status: "removed",
      removedBy: CREATOR.subject,
    });
    const owners = await t.run(async (ctx) =>
      Promise.all([w.open, w.secret].map(async (p) => (await ctx.db.get(p.projectId))!.ownerId)),
    );
    expect(owners).toEqual([OWNER.subject, OWNER.subject]);

    await t.withIdentity(GUEST).mutation(api.members.leave, { workspaceId: w.workspaceId });
    expect(await seatOf(t, w.workspaceId, GUEST)).toMatchObject({ status: "removed" });
  });

  test("the last owner cannot leave; an owner with a co-owner can", async () => {
    const t = harness();
    const w = await world(t);
    const leave = (who: Identity) =>
      t.withIdentity(who).mutation(api.members.leave, { workspaceId: w.workspaceId });
    await expect(leave(OWNER)).rejects.toThrow("You’re the only owner.");
    await expect(leave(STAND_IN)).rejects.toThrow("Read-only");
    await expect(leave(STRANGER)).rejects.toThrow("Not found");
    await t.withIdentity(OWNER).mutation(api.members.setRole, {
      workspaceId: w.workspaceId,
      userId: ADMIN.subject,
      role: "owner",
    });
    await leave(OWNER);
    expect(await seatOf(t, w.workspaceId, OWNER)).toMatchObject({ status: "removed" });
    await expect(leave(ADMIN)).rejects.toThrow("You’re the only owner.");
  });
});
