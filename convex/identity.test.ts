/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import type { UserIdentity } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import * as identityModule from "./identity";
import * as profilesModule from "./profiles";

/**
 * Who an account is when its session token will not say: Clerk's default
 * token carries only the subject, so the address invitations and join
 * domains are bound to is confirmed server-side (`identity.sync`) and read
 * back by `auth.verifiedEmail`. The rules worth pinning are the ones a
 * mistake here would turn into a door: only a verified primary address is
 * ever stamped, nothing a client sends reaches the stamp, and a stand-in
 * confirms nothing.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

type T = TestConvex<typeof schema>;

const OWNER = { subject: "user_owner", email: "olive@acme.com" };
/** Clerk's default session token: the subject and nothing else. */
const NIA = { subject: "user_nia" };
const SAL = { subject: "user_sal" };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const KEY = "sk_test_identity";

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

/** Clerk's `GET /v1/users/{id}`, as far as `identity.sync` reads it. */
function clerkUser(overrides: Record<string, unknown> = {}) {
  return {
    id: NIA.subject,
    primary_email_address_id: "idn_primary",
    email_addresses: [
      {
        id: "idn_other",
        email_address: "nia@elsewhere.org",
        verification: { status: "verified" },
      },
      {
        id: "idn_primary",
        email_address: "Nia@Acme.com",
        verification: { status: "verified" },
      },
    ],
    first_name: "Nia",
    last_name: "Newman",
    image_url: "https://img.clerk.com/nia.png",
    has_image: true,
    ...overrides,
  };
}

/** Stubs Clerk: `answer` is its body, or a status, or a thrown failure. */
function stubClerk(answer: object | number | Error = clerkUser()) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(JSON.stringify(answer), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const stampOf = (t: T, subject: string) =>
  t.run((ctx) =>
    ctx.db
      .query("identities")
      .withIndex("by_owner", (q) => q.eq("ownerId", subject))
      .unique(),
  );

const profileOf = (t: T, subject: string) =>
  t.run((ctx) =>
    ctx.db
      .query("profiles")
      .withIndex("by_owner", (q) => q.eq("ownerId", subject))
      .unique(),
  );

const sync = (t: T, who: Partial<UserIdentity>) =>
  t.withIdentity(who).action(api.identity.sync, {});

/** Acme, with acme.com open to join and an invitation out to nia@acme.com. */
async function invited(t: T) {
  return await t.run(async (ctx) => {
    const workspaceId: Id<"workspaces"> = await ctx.db.insert("workspaces", {
      slug: "acme",
      name: "Acme",
      createdBy: OWNER.subject,
      plan: "team",
      settings: {
        linkSharing: true,
        guestCodeAccess: false,
        joinDomains: ["acme.com"],
        autoJoin: true,
      },
      createdAt: 1,
    });
    await ctx.db.insert("workspaceSlugs", { slug: "acme", workspaceId });
    await ctx.db.insert("workspaceDomains", { domain: "acme.com", workspaceId });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: OWNER.subject,
      role: "owner",
      status: "active",
      joinedAt: 1,
    });
    await ctx.db.insert("invitations", {
      workspaceId,
      email: "nia@acme.com",
      role: "member",
      token: "tok_nia",
      invitedBy: OWNER.subject,
      createdAt: Date.now(),
      expiresAt: Date.now() + 14 * DAY,
    });
    return workspaceId;
  });
}

beforeEach(() => {
  vi.stubEnv("CLERK_SECRET_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("sync", () => {
  test("takes the token's own address when it carries one, and asks Clerk nothing", async () => {
    const t = harness();
    const fetch = stubClerk();
    const who = {
      subject: NIA.subject,
      email: "Nia@Acme.com",
      name: "Nia Newman",
      pictureUrl: "https://img.example/nia.png",
    };
    await expect(sync(t, who)).resolves.toBe("nia@acme.com");
    expect(fetch).not.toHaveBeenCalled();
    expect(await stampOf(t, NIA.subject)).toMatchObject({
      verifiedEmail: "nia@acme.com",
      verifiedEmailAt: expect.any(Number),
      name: "Nia Newman",
      imageUrl: "https://img.example/nia.png",
    });
  });

  test("stamps Clerk's verified primary address when the token is silent", async () => {
    const t = harness();
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.clerk.com/v1/users/user_nia");
    expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${KEY}`);
    expect(await stampOf(t, NIA.subject)).toMatchObject({
      verifiedEmail: "nia@acme.com",
      name: "Nia Newman",
      imageUrl: "https://img.clerk.com/nia.png",
    });
    // No profile row is made: its absence is first run's signal.
    expect(await profileOf(t, NIA.subject)).toBeNull();
  });

  test("also asks Clerk when the token's address says it is unverified", async () => {
    const t = harness();
    const fetch = stubClerk();
    await expect(
      sync(t, { ...NIA, email: "nia@acme.com", emailVerified: false }),
    ).resolves.toBe("nia@acme.com");
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("copies onto a profile that exists, and only ever adds to it", async () => {
    const t = harness();
    stubClerk(clerkUser({ first_name: null, last_name: null, has_image: false }));
    await t.run((ctx) =>
      ctx.db.insert("profiles", {
        ownerId: NIA.subject,
        name: "Nia from the survey",
        status: "done",
        createdAt: 1,
      }),
    );
    await sync(t, NIA);
    expect(await profileOf(t, NIA.subject)).toMatchObject({
      email: "nia@acme.com",
      name: "Nia from the survey",
    });
    // Clerk's placeholder picture is no picture.
    expect((await profileOf(t, NIA.subject))?.imageUrl).toBeUndefined();
    expect((await stampOf(t, NIA.subject))?.imageUrl).toBeUndefined();
  });

  test("stamps no address when the primary one is unverified or missing", async () => {
    const t = harness();
    const unverified = clerkUser({
      email_addresses: [
        {
          id: "idn_other",
          email_address: "nia@acme.com",
          verification: { status: "verified" },
        },
        {
          id: "idn_primary",
          email_address: "nia@acme.com",
          verification: { status: "unverified" },
        },
      ],
    });
    for (const answer of [
      unverified,
      clerkUser({ primary_email_address_id: null }),
      clerkUser({ primary_email_address_id: "idn_gone" }),
      clerkUser({ email_addresses: [] }),
    ]) {
      stubClerk(answer);
      await expect(sync(t, NIA)).resolves.toBeNull();
      expect((await stampOf(t, NIA.subject))?.verifiedEmail).toBeUndefined();
    }
  });

  test("trusts a stamp for a day, then asks again — and drops an address no longer vouched for", async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert("identities", {
        ownerId: NIA.subject,
        verifiedEmail: "nia@acme.com",
        verifiedEmailAt: Date.now() - HOUR,
      }),
    );
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
    expect(fetch).not.toHaveBeenCalled();

    const stamp = await stampOf(t, NIA.subject);
    await t.run((ctx) => ctx.db.patch(stamp!._id, { verifiedEmailAt: Date.now() - 25 * HOUR }));
    const unverified = stubClerk(
      clerkUser({
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "nia@acme.com",
            verification: { status: "unverified" },
          },
        ],
      }),
    );
    await expect(sync(t, NIA)).resolves.toBeNull();
    expect(unverified).toHaveBeenCalledOnce();
    expect(await stampOf(t, NIA.subject)).toMatchObject({ name: "Nia Newman" });
    expect((await stampOf(t, NIA.subject))?.verifiedEmail).toBeUndefined();
  });

  test("treats Clerk failing as no answer: nothing crashes and the old stamp stands", async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert("identities", {
        ownerId: NIA.subject,
        verifiedEmail: "nia@acme.com",
        verifiedEmailAt: Date.now() - 25 * HOUR,
      }),
    );
    for (const answer of [500, 404, new Error("network down"), { email_addresses: "?" }]) {
      stubClerk(answer);
      await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
      expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@acme.com" });
    }
    stubClerk(500);
    await expect(sync(t, SAL)).resolves.toBeNull();
    expect(await stampOf(t, SAL.subject)).toBeNull();
  });

  test("asks nobody without CLERK_SECRET_KEY", async () => {
    const t = harness();
    vi.stubEnv("CLERK_SECRET_KEY", "");
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await stampOf(t, NIA.subject)).toBeNull();
  });

  test("is refused to an operator standing in, and to nobody signed in", async () => {
    const t = harness();
    const fetch = stubClerk();
    await expect(sync(t, { ...NIA, act: "ops_session_1" })).rejects.toThrow("Read-only");
    await expect(
      sync(t, { ...NIA, email: "nia@acme.com", act: "ops_session_1" }),
    ).rejects.toThrow("Read-only");
    await expect(t.action(api.identity.sync, {})).rejects.toThrow("Not signed in");
    expect(fetch).not.toHaveBeenCalled();
    expect(await stampOf(t, NIA.subject)).toBeNull();
  });
});

describe("what a client can reach", () => {
  test("the one public door takes no arguments, and the writer is internal", async () => {
    const t = harness();
    stubClerk();
    await expect(
      t
        .withIdentity(NIA)
        .action(api.identity.sync, { verifiedEmail: "olive@acme.com" } as never),
    ).rejects.toThrow();
    expect(await stampOf(t, NIA.subject)).toBeNull();

    const exported = Object.entries(identityModule).filter(
      ([, fn]) => typeof fn === "function" && ("isPublic" in fn || "isInternal" in fn),
    ) as [string, { isPublic?: boolean; isInternal?: boolean }][];
    expect(exported.filter(([, fn]) => fn.isPublic).map(([name]) => name)).toEqual(["sync"]);
    expect(identityModule.stamp.isInternal).toBe(true);
    expect(identityModule.stamped.isInternal).toBe(true);
    // The profile's public mutations take nothing that could name an address.
    expect("stampEmail" in profilesModule).toBe(false);
  });
});

describe("a stamped address", () => {
  test("opens an invitation to a token that names no address", async () => {
    const t = harness();
    const workspaceId = await invited(t);
    const nia = t.withIdentity(NIA);
    expect(await nia.query(api.members.invitation, { token: "tok_nia" })).toEqual({
      state: "unconfirmed",
    });
    await expect(nia.mutation(api.members.acceptInvite, { token: "tok_nia" })).rejects.toThrow(
      "This invitation is for another account.",
    );

    stubClerk();
    await sync(t, NIA);
    expect(await nia.query(api.members.invitation, { token: "tok_nia" })).toMatchObject({
      state: "valid",
    });
    await expect(
      nia.mutation(api.members.acceptInvite, { token: "tok_nia" }),
    ).resolves.toMatchObject({ workspaceId, role: "member" });
  });

  test("refuses an invitation meant for another address", async () => {
    const t = harness();
    await invited(t);
    stubClerk(
      clerkUser({
        id: SAL.subject,
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "sal@acme.com",
            verification: { status: "verified" },
          },
        ],
      }),
    );
    await sync(t, SAL);
    const sal = t.withIdentity(SAL);
    expect(await sal.query(api.members.invitation, { token: "tok_nia" })).toEqual({
      state: "wrong-account",
      email: "n••@acme.com",
    });
    await expect(sal.mutation(api.members.acceptInvite, { token: "tok_nia" })).rejects.toThrow(
      "This invitation is for another account.",
    );
  });

  test("proves a join domain, and names the person in the members list", async () => {
    const t = harness();
    const workspaceId = await invited(t);
    stubClerk(
      clerkUser({
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "sal@acme.com",
            verification: { status: "verified" },
          },
        ],
        first_name: "Sal",
        last_name: null,
      }),
    );
    await sync(t, SAL);
    const sal = t.withIdentity(SAL);
    expect(await sal.query(api.members.joinable, {})).toMatchObject([
      { workspaceId, via: "domain" },
    ]);
    await sal.mutation(api.members.joinByDomain, { workspaceId });

    const people = await t.withIdentity(OWNER).query(api.members.list, { workspaceId });
    expect(people?.members.find((m) => m.userId === SAL.subject)).toMatchObject({
      name: "Sal",
      email: "sal@acme.com",
      imageUrl: "https://img.clerk.com/nia.png",
    });
    // …and an invitation to someone already in is refused by that address.
    await expect(
      t.withIdentity(OWNER).mutation(api.members.invite, {
        workspaceId,
        email: "SAL@acme.com",
        role: "member",
      }),
    ).rejects.toThrow("sal@acme.com is already in Acme.");
  });
});

describe("the profile's copy", () => {
  // The order a new account really runs in: the app confirms who it is on
  // the first signed-in render, and the profile row comes after.
  test("an invitation's arrival row starts with what was confirmed before it", async () => {
    const t = harness();
    await invited(t);
    stubClerk();
    await sync(t, NIA);
    expect(await profileOf(t, NIA.subject)).toBeNull();

    await t.withIdentity(NIA).mutation(api.members.acceptInvite, { token: "tok_nia" });
    expect(await profileOf(t, NIA.subject)).toMatchObject({
      status: "skipped",
      email: "nia@acme.com",
      name: "Nia Newman",
      imageUrl: "https://img.clerk.com/nia.png",
    });
  });

  test("so do the rows first run makes, by skipping or by finishing", async () => {
    const t = harness();
    stubClerk();
    await sync(t, NIA);
    await t.withIdentity(NIA).mutation(api.profiles.skip, {});
    expect(await profileOf(t, NIA.subject)).toMatchObject({
      status: "skipped",
      email: "nia@acme.com",
      name: "Nia Newman",
    });

    stubClerk(
      clerkUser({
        id: SAL.subject,
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "sal@acme.com",
            verification: { status: "verified" },
          },
        ],
        first_name: "Sal",
        last_name: null,
        has_image: false,
      }),
    );
    await sync(t, SAL);
    await t.withIdentity(SAL).mutation(api.onboarding.createSeededProject, {
      title: "Tutorial",
      template: "plan",
      defaultMode: "create",
      pages: [],
      context: [],
      priorChat: { title: "T", asked: "a", answered: "b" },
    });
    const sal = await profileOf(t, SAL.subject);
    expect(sal).toMatchObject({ status: "touring", email: "sal@acme.com", name: "Sal" });
    expect(sal?.imageUrl).toBeUndefined();
  });
});
