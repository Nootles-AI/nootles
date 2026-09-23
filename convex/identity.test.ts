/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import type { UserIdentity } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
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
 * ever stamped, nothing a client sends reaches the stamp, a stand-in
 * confirms nothing, and a stamp Clerk has stopped vouching for — or has not
 * vouched for lately — admits nobody.
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

/** A stamp Clerk last vouched for `age` ago. */
const stampAged = (t: T, ownerId: string, email: string, age: number) =>
  t.run((ctx) =>
    ctx.db.insert("identities", {
      ownerId,
      verifiedEmail: email,
      verifiedEmailAt: Date.now() - age,
      name: "Nia Newman",
    }),
  );

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
  vi.useRealTimers();
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
      const t = harness();
      const fetch = stubClerk(answer);
      await expect(sync(t, NIA)).resolves.toBeNull();
      expect(fetch).toHaveBeenCalledOnce();
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
    for (const answer of [500, 404, 429, new Error("network down"), { email_addresses: "?" }]) {
      const t = harness();
      await stampAged(t, NIA.subject, "nia@acme.com", 25 * HOUR);
      const fetch = stubClerk(answer);
      await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
      expect(fetch).toHaveBeenCalledOnce();
      expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@acme.com" });
    }
  });

  test("with nothing answered before, says Clerk gave no answer rather than that there is no address", async () => {
    const t = harness();
    stubClerk(500);
    await expect(sync(t, SAL)).rejects.toMatchObject({ data: { code: "unanswered" } });
    expect((await stampOf(t, SAL.subject))?.verifiedEmail).toBeUndefined();
    expect((await stampOf(t, SAL.subject))?.answeredAt).toBeUndefined();
  });

  test("asks nobody without CLERK_SECRET_KEY", async () => {
    const t = harness();
    vi.stubEnv("CLERK_SECRET_KEY", "");
    const fetch = stubClerk();
    await expect(sync(t, NIA)).rejects.toMatchObject({ data: { code: "unanswered" } });
    expect(fetch).not.toHaveBeenCalled();
    expect((await stampOf(t, NIA.subject))?.verifiedEmail).toBeUndefined();
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

describe("how often Clerk is asked", () => {
  /** Moves the last ask `by` into the past, as if that long had gone by. */
  const age = async (t: T, ownerId: string, by: number) => {
    const row = await stampOf(t, ownerId);
    await t.run((ctx) => ctx.db.patch(row!._id, { checkedAt: row!.checkedAt! - by }));
  };
  const noVerifiedPrimary = () => clerkUser({ primary_email_address_id: null });

  test("an answer of no address is kept for a minute, not asked for on every call", async () => {
    const t = harness();
    const fetch = stubClerk(noVerifiedPrimary());
    for (let i = 0; i < 20; i++) await expect(sync(t, NIA)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();

    await age(t, NIA.subject, 59_000);
    await expect(sync(t, NIA)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();

    await age(t, NIA.subject, 2_000);
    stubClerk();
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
  });

  test("so is a lapsed address, which is asked about at most once a minute", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", 4 * DAY);
    await t.mutation(internal.identity.expire, {});
    const fetch = stubClerk(noVerifiedPrimary());
    for (let i = 0; i < 5; i++) await expect(sync(t, NIA)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("while Clerk fails, an account asks at most once every five seconds", async () => {
    const t = harness();
    const failing = stubClerk(429);
    for (let i = 0; i < 10; i++) {
      await expect(sync(t, NIA)).rejects.toMatchObject({ data: { code: "unanswered" } });
    }
    expect(failing).toHaveBeenCalledOnce();

    await age(t, NIA.subject, 5_000);
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("a failed ask on an answered account gives the last answer, and waits too", async () => {
    const t = harness();
    stubClerk(noVerifiedPrimary());
    await sync(t, NIA);
    await age(t, NIA.subject, 61_000);
    const failing = stubClerk(503);
    await expect(sync(t, NIA)).resolves.toBeNull();
    await expect(sync(t, NIA)).resolves.toBeNull();
    expect(failing).toHaveBeenCalledOnce();
  });

  test("calls that race each other before the first answer ask once between them", async () => {
    const t = harness();
    const fetch = stubClerk();
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => sync(t, NIA)));
    expect(fetch).toHaveBeenCalledOnce();
    expect(results.filter((r) => r.status === "fulfilled")).toEqual([
      { status: "fulfilled", value: "nia@acme.com" },
    ]);
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
  });

  test("the token's own address is taken even while Clerk is being waited on", async () => {
    const t = harness();
    await t.run((ctx) =>
      ctx.db.insert("identities", { ownerId: NIA.subject, checkedAt: Date.now() }),
    );
    const fetch = stubClerk();
    await expect(sync(t, { ...NIA, email: "nia@acme.com" })).resolves.toBe("nia@acme.com");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a stamp the webhook just made is answered from, not asked about", async () => {
    const t = harness();
    await t.mutation(internal.identity.stamp, { ownerId: NIA.subject, email: null });
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
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
    expect(identityModule.begin.isInternal).toBe(true);
    expect(identityModule.forget.isInternal).toBe(true);
    expect(identityModule.expire.isInternal).toBe(true);
    // The webhook's door is HTTP, and opens only to what Clerk signed.
    expect(identityModule.clerkWebhook.isHttp).toBe(true);
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

describe("a stamp's age", () => {
  test("admits nobody once Clerk hasn't vouched for it in three days", async () => {
    const t = harness();
    const workspaceId = await invited(t);
    const stampId = await stampAged(t, NIA.subject, "nia@acme.com", 3 * DAY + HOUR);
    const nia = t.withIdentity(NIA);
    await expect(nia.mutation(api.members.acceptInvite, { token: "tok_nia" })).rejects.toThrow(
      "This invitation is for another account.",
    );
    await expect(nia.mutation(api.members.joinByDomain, { workspaceId })).rejects.toThrow(
      "Not found",
    );

    // A query can't read the clock, so it shows the stamp as it stands until
    // `expire` takes the address off.
    expect(await nia.query(api.members.invitation, { token: "tok_nia" })).toMatchObject({
      state: "valid",
    });
    await t.mutation(internal.identity.expire, {});
    expect(await nia.query(api.members.invitation, { token: "tok_nia" })).toEqual({
      state: "unconfirmed",
    });
    expect(await nia.query(api.members.joinable, {})).toEqual([]);

    await t.run((ctx) =>
      ctx.db.patch(stampId, {
        verifiedEmail: "nia@acme.com",
        verifiedEmailAt: Date.now() - 2 * DAY,
      }),
    );
    await expect(
      nia.mutation(api.members.acceptInvite, { token: "tok_nia" }),
    ).resolves.toMatchObject({ workspaceId, role: "member" });
  });

  test("doesn't prove a join domain once it has lapsed", async () => {
    const t = harness();
    const workspaceId = await t.run(async (ctx) => {
      const workspaceId: Id<"workspaces"> = await ctx.db.insert("workspaces", {
        slug: "nia-co",
        name: "Nia & Co",
        createdBy: NIA.subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      });
      await ctx.db.insert("memberships", {
        workspaceId,
        userId: NIA.subject,
        role: "owner",
        status: "active",
        joinedAt: 1,
      });
      return workspaceId;
    });
    const stampId = await stampAged(t, NIA.subject, "nia@acme.com", 4 * DAY);
    const addAcme = () =>
      t.withIdentity(NIA).mutation(api.workspaces.updateSettings, {
        workspaceId,
        patch: { joinDomains: ["acme.com"] },
      });
    await expect(addAcme()).rejects.toThrow("You can only add your own email’s domain.");

    await t.run((ctx) => ctx.db.patch(stampId, { verifiedEmailAt: Date.now() - HOUR }));
    await addAcme();
    const workspace = await t.run((ctx) => ctx.db.get(workspaceId));
    expect(workspace?.settings.joinDomains).toEqual(["acme.com"]);
  });

  test("expire takes the address off every stamp past the window, and nothing else", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    const t = harness();
    // More than one run's worth, so the rest are left to the run it schedules.
    const lapsing = 130;
    await t.run(async (ctx) => {
      for (let i = 0; i < lapsing; i++) {
        await ctx.db.insert("identities", {
          ownerId: `user_old_${i}`,
          verifiedEmail: `old${i}@acme.com`,
          verifiedEmailAt: Date.now() - 3 * DAY - 1 - i * HOUR,
          name: "Old Timer",
        });
      }
      await ctx.db.insert("identities", {
        ownerId: "user_edge",
        verifiedEmail: "edge@acme.com",
        verifiedEmailAt: Date.now() - 3 * DAY,
      });
      await ctx.db.insert("identities", { ownerId: "user_none", name: "No Address" });
    });

    await t.mutation(internal.identity.expire, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const rows = await t.run((ctx) => ctx.db.query("identities").collect());
    const old = rows.filter((row) => row.ownerId.startsWith("user_old_"));
    expect(old).toHaveLength(lapsing);
    for (const row of old) {
      expect(row.verifiedEmail).toBeUndefined();
      expect(row.verifiedEmailAt).toBeUndefined();
      expect(row.name).toBe("Old Timer");
    }
    expect(rows.find((row) => row.ownerId === "user_edge")).toMatchObject({
      verifiedEmail: "edge@acme.com",
    });
    expect(rows.find((row) => row.ownerId === "user_none")).toMatchObject({
      name: "No Address",
    });
  });

  test("a lapsed stamp is asked about again rather than trusted", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", 4 * DAY);
    await t.mutation(internal.identity.expire, {});
    const fetch = stubClerk();
    await expect(sync(t, NIA)).resolves.toBe("nia@acme.com");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("the Clerk webhook", () => {
  const SECRET = `whsec_${btoa("a webhook secret for these tests")}`;

  /** Signs as Svix does: HMAC-SHA256 over `${id}.${timestamp}.${body}`. */
  async function svixHeaders(body: string, secret = SECRET, at = Date.now()) {
    const key = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const id = "msg_test";
    const timestamp = String(Math.floor(at / 1000));
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
    );
    return {
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${btoa(String.fromCharCode(...mac))}`,
    };
  }

  const post = (t: T, body: string, headers: Record<string, string>) =>
    t.fetch("/clerk/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  async function deliver(t: T, event: object) {
    const body = JSON.stringify(event);
    return await post(t, body, await svixHeaders(body));
  }

  beforeEach(() => {
    vi.stubEnv("CLERK_WEBHOOK_SECRET", SECRET);
  });

  test("stamps what Clerk says now, not what the event carried", async () => {
    const t = harness();
    const fetch = stubClerk();
    const response = await deliver(t, {
      type: "user.updated",
      data: clerkUser({
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "someone@else.org",
            verification: { status: "verified" },
          },
        ],
      }),
    });
    expect(response.status).toBe(204);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://api.clerk.com/v1/users/user_nia");
    expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@acme.com" });
  });

  test("an address taken off in Clerk stops admitting its old holder at once", async () => {
    const t = harness();
    const workspaceId = await invited(t);
    await stampAged(t, NIA.subject, "nia@acme.com", HOUR);
    stubClerk(
      clerkUser({
        email_addresses: [
          {
            id: "idn_primary",
            email_address: "nia@newco.com",
            verification: { status: "verified" },
          },
        ],
      }),
    );
    expect((await deliver(t, { type: "user.updated", data: { id: NIA.subject } })).status).toBe(
      204,
    );
    expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@newco.com" });

    const nia = t.withIdentity(NIA);
    await expect(nia.mutation(api.members.acceptInvite, { token: "tok_nia" })).rejects.toThrow(
      "This invitation is for another account.",
    );
    await expect(nia.mutation(api.members.joinByDomain, { workspaceId })).rejects.toThrow(
      "Not found",
    );
    expect(await nia.query(api.members.joinable, {})).toEqual([]);
  });

  test("forgets a deleted account's address without asking Clerk", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", HOUR);
    const fetch = stubClerk();
    const response = await deliver(t, {
      type: "user.deleted",
      data: { id: NIA.subject, deleted: true, object: "user" },
    });
    expect(response.status).toBe(204);
    expect(fetch).not.toHaveBeenCalled();
    const stamp = await stampOf(t, NIA.subject);
    expect(stamp?.verifiedEmail).toBeUndefined();
    expect(stamp?.name).toBe("Nia Newman");
  });

  test("refuses a delivery it can't verify, and touches nothing", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", HOUR);
    const fetch = stubClerk();
    const body = JSON.stringify({ type: "user.deleted", data: { id: NIA.subject } });
    const good = await svixHeaders(body);
    const refused = [
      await post(t, body, await svixHeaders(body, `whsec_${btoa("some other secret")}`)),
      await post(t, body.replace("user.deleted", "user.updated"), good),
      await post(t, body, { ...good, "svix-id": "msg_other" }),
      await post(t, body, await svixHeaders(body, SECRET, Date.now() - 10 * 60 * 1000)),
      await post(t, body, { "svix-id": good["svix-id"], "svix-timestamp": good["svix-timestamp"] }),
      await post(t, body, {}),
    ];
    vi.stubEnv("CLERK_WEBHOOK_SECRET", "");
    refused.push(await post(t, body, good));
    expect(refused.map((response) => response.status)).toEqual(refused.map(() => 401));
    expect(fetch).not.toHaveBeenCalled();
    expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@acme.com" });
  });

  test("takes any one good signature, as while Clerk rotates the secret", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", HOUR);
    const body = JSON.stringify({ type: "user.deleted", data: { id: NIA.subject } });
    const good = await svixHeaders(body);
    const rotating = `v1,${btoa("an old signature")} ${good["svix-signature"]}`;
    const response = await post(t, body, { ...good, "svix-signature": rotating });
    expect(response.status).toBe(204);
    expect((await stampOf(t, NIA.subject))?.verifiedEmail).toBeUndefined();
  });

  test("answers 503 when Clerk doesn't, so Svix delivers again, and the stamp stands", async () => {
    const t = harness();
    await stampAged(t, NIA.subject, "nia@acme.com", HOUR);
    for (const answer of [500, new Error("network down")]) {
      stubClerk(answer);
      const response = await deliver(t, { type: "user.updated", data: { id: NIA.subject } });
      expect(response.status).toBe(503);
      expect(await stampOf(t, NIA.subject)).toMatchObject({ verifiedEmail: "nia@acme.com" });
    }
  });

  test("acknowledges other events and does nothing with them", async () => {
    const t = harness();
    const fetch = stubClerk();
    for (const event of [
      { type: "session.created", data: { id: "sess_1", user_id: NIA.subject } },
      { type: "email.created", data: { id: "ema_1", to_email_address: "nia@acme.com" } },
      { type: "user.updated", data: null },
    ]) {
      expect((await deliver(t, event)).status).toBe(204);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(await stampOf(t, NIA.subject)).toBeNull();
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
