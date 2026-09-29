/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ATTRIBUTION_WINDOW_MS,
  DEFAULT_DESTINATION,
  NEW_ACCOUNT_TOLERANCE_MS,
  formatRef,
  signClick,
} from "./affiliateRules";
import schema from "./schema";

/**
 * Affiliate links, driven as the people involved: a visitor clicking (signed
 * out, through the route's signature), a brand-new account claiming the
 * click, an account that was here before the click, someone arriving by a
 * share link, the affiliate themselves, and an operator standing in.
 */

const modules = import.meta.glob("./**/*.ts");

const SECRET = "a-shared-click-secret";
const T0 = Date.UTC(2026, 8, 28, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const NEWBIE = { subject: "user_newbie" };
const VETERAN = { subject: "user_veteran" };
const INFLUENCER = { subject: "user_influencer" };
const STAND_IN = { subject: NEWBIE.subject, act: "operator_1" };

const VISITOR = "0b5e7a1c-3f2d-4c8e-9a6b-1d2e3f4a5b6c";
const OTHER_VISITOR = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.stubEnv("AFFILIATE_CLICK_SECRET", SECRET);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const at = (ms: number) => vi.setSystemTime(ms);

async function affiliate(
  t: T,
  fields: Partial<Doc<"affiliates">> & { slug: string },
): Promise<Id<"affiliates">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("affiliates", {
      name: fields.slug,
      destination: "https://nootles.com/for/writers",
      createdAt: 1,
      ...fields,
    }),
  );
}

/** A click as the route makes it: signed now with the shared secret, unless told otherwise. */
async function click(
  t: T,
  slug: string,
  visitorId = VISITOR,
  opts: { signedAt?: number; secret?: string; signature?: string } = {},
) {
  const signedAt = opts.signedAt ?? Date.now();
  const signature =
    opts.signature ?? (await signClick(opts.secret ?? SECRET, { slug, visitorId, signedAt }));
  return await t.mutation(api.affiliates.recordClick, { slug, visitorId, signedAt, signature });
}

const visits = (t: T) => t.run((ctx) => ctx.db.query("affiliateVisits").collect());
const days = (t: T) => t.run((ctx) => ctx.db.query("affiliateDays").collect());
const attributions = (t: T) => t.run((ctx) => ctx.db.query("affiliateAttributions").collect());

const ref = (slug: string, visitorId = VISITOR, clickedAt = Date.now()) =>
  formatRef({ slug, visitorId, clickedAt });

const attribute = (t: T, who: { subject: string }, raw: string) =>
  t.withIdentity(who).mutation(api.affiliates.attribute, { ref: raw });

describe("recordClick", () => {
  test("a signed click counts, and sends the visitor to the affiliate's page", async () => {
    const t = convexTest(schema, modules);
    const id = await affiliate(t, { slug: "jane" });

    expect(await click(t, "jane")).toEqual({ destination: "https://nootles.com/for/writers" });

    expect(await visits(t)).toMatchObject([
      { affiliateId: id, visitorId: VISITOR, firstAt: T0, lastAt: T0, clicks: 1 },
    ]);
    expect(await days(t)).toMatchObject([
      { affiliateId: id, day: "2026-09-28", clicks: 1, visitors: 1 },
    ]);
  });

  test.each([
    ["forged with another secret", { secret: "guessed" }],
    ["missing", { signature: "" }],
    ["not hex", { signature: "z".repeat(64) }],
    ["stale, eleven minutes old", { signedAt: T0 - 11 * MINUTE }],
    ["from two minutes in the future", { signedAt: T0 + 2 * MINUTE }],
  ])("a signature %s still redirects but counts nothing", async (_, opts) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });

    expect(await click(t, "jane", VISITOR, opts)).toEqual({
      destination: "https://nootles.com/for/writers",
    });
    expect(await visits(t)).toEqual([]);
    expect(await days(t)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/jane not counted: signature/));
  });

  test("a signature is good for ten minutes behind and one ahead", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });

    await click(t, "jane", VISITOR, { signedAt: T0 - 9 * MINUTE });
    await click(t, "jane", VISITOR, { signedAt: T0 + 30_000 });
    expect((await visits(t))[0].clicks).toBe(2);
  });

  test("a signature over a different slug or visitor does not verify", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await affiliate(t, { slug: "john" });

    const signedAt = Date.now();
    const janes = await signClick(SECRET, { slug: "jane", visitorId: VISITOR, signedAt });
    await t.mutation(api.affiliates.recordClick, {
      slug: "john",
      visitorId: VISITOR,
      signedAt,
      signature: janes,
    });
    await t.mutation(api.affiliates.recordClick, {
      slug: "jane",
      visitorId: OTHER_VISITOR,
      signedAt,
      signature: janes,
    });
    expect(await visits(t)).toEqual([]);
  });

  test("with no secret on the deployment nothing is counted, and the visitor still lands", async () => {
    vi.stubEnv("AFFILIATE_CLICK_SECRET", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });

    expect(await click(t, "jane")).toEqual({ destination: "https://nootles.com/for/writers" });
    expect(await visits(t)).toEqual([]);
    expect(await days(t)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no secret/));
  });

  test("a visitor id that is not a UUID is not counted, even signed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });

    await click(t, "jane", "visitor-1");
    expect(await visits(t)).toEqual([]);
  });

  test("an unknown or disabled slug goes to the default destination and records nothing", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "gone", disabledAt: T0 - DAY });

    expect(await click(t, "nobody")).toEqual({ destination: DEFAULT_DESTINATION });
    expect(await click(t, "gone")).toEqual({ destination: DEFAULT_DESTINATION });
    expect(await click(t, "x")).toEqual({ destination: DEFAULT_DESTINATION });
    expect(await click(t, "admin")).toEqual({ destination: DEFAULT_DESTINATION });
    expect(await visits(t)).toEqual([]);
    expect(await days(t)).toEqual([]);
  });

  test("a slug in another case finds its affiliate; the signature is over the normalized slug", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane-doe" });

    const signedAt = Date.now();
    const signature = await signClick(SECRET, { slug: "jane-doe", visitorId: VISITOR, signedAt });
    expect(
      await t.mutation(api.affiliates.recordClick, {
        slug: "Jane_Doe",
        visitorId: VISITOR,
        signedAt,
        signature,
      }),
    ).toEqual({ destination: "https://nootles.com/for/writers" });
    expect(await visits(t)).toHaveLength(1);

    // Signing the raw segment instead does not verify.
    await click(t, "Jane_Doe", OTHER_VISITOR);
    expect(await visits(t)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/signature invalid/));
  });

  test.each([
    "https://evil.com/",
    "http://nootles.com/",
    "https://nootles.com.evil.com/",
    "https://user@nootles.com/",
    "javascript:alert(1)",
    "//evil.com",
  ])("a stored destination of %j is never followed", async (destination) => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane", destination });

    expect(await click(t, "jane")).toEqual({ destination: DEFAULT_DESTINATION });
    // The click is still the affiliate's.
    expect(await visits(t)).toHaveLength(1);
  });

  test("two clicks by one visitor are two clicks and one visitor; another visitor is a second", async () => {
    const t = convexTest(schema, modules);
    const id = await affiliate(t, { slug: "jane" });

    await click(t, "jane");
    at(T0 + 5 * MINUTE);
    await click(t, "jane");
    at(T0 + 6 * MINUTE);
    await click(t, "jane", OTHER_VISITOR);

    const rows = await visits(t);
    expect(rows.find((r) => r.visitorId === VISITOR)).toMatchObject({
      firstAt: T0,
      lastAt: T0 + 5 * MINUTE,
      clicks: 2,
    });
    expect(rows.find((r) => r.visitorId === OTHER_VISITOR)).toMatchObject({ clicks: 1 });
    expect(await days(t)).toMatchObject([
      { affiliateId: id, day: "2026-09-28", clicks: 3, visitors: 2 },
    ]);
  });

  test("a visitor counts once per day, and again on a new day", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });

    await click(t, "jane");
    at(Date.UTC(2026, 8, 28, 23, 59));
    await click(t, "jane");
    at(Date.UTC(2026, 8, 29, 0, 1));
    await click(t, "jane");
    await click(t, "jane");

    const byDay = Object.fromEntries((await days(t)).map((d) => [d.day, d]));
    expect(byDay["2026-09-28"]).toMatchObject({ clicks: 2, visitors: 1 });
    expect(byDay["2026-09-29"]).toMatchObject({ clicks: 2, visitors: 1 });
    expect(await visits(t)).toMatchObject([
      { firstAt: T0, lastAt: Date.UTC(2026, 8, 29, 0, 1), clicks: 4 },
    ]);
  });

  test("clicks are counted per affiliate", async () => {
    const t = convexTest(schema, modules);
    const jane = await affiliate(t, { slug: "jane" });
    const john = await affiliate(t, { slug: "john" });

    await click(t, "jane");
    await click(t, "john");

    const rows = await days(t);
    expect(rows.find((d) => d.affiliateId === jane)).toMatchObject({ clicks: 1, visitors: 1 });
    expect(rows.find((d) => d.affiliateId === john)).toMatchObject({ clicks: 1, visitors: 1 });
  });
});

describe("attribute", () => {
  test("a brand-new account is attributed to the link it clicked", async () => {
    const t = convexTest(schema, modules);
    const id = await affiliate(t, { slug: "jane" });
    await click(t, "jane");
    at(T0 + 3 * MINUTE);

    expect(await attribute(t, NEWBIE, ref("jane", VISITOR, T0))).toEqual({
      status: "attributed",
      affiliate: "jane",
    });
    expect(await attributions(t)).toMatchObject([
      {
        ownerId: NEWBIE.subject,
        affiliateId: id,
        visitorId: VISITOR,
        clickedAt: T0,
        attributedAt: T0 + 3 * MINUTE,
        via: "link",
      },
    ]);
    expect(await t.query(internal.affiliates.slugFor, { ownerId: NEWBIE.subject })).toBe("jane");
  });

  test("the click's time comes from the visit, never the cookie", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");
    at(T0 + 40 * DAY);
    await click(t, "jane");

    // A cookie claiming an old click cannot age a fresh visit out of the
    // window, and one claiming a fresh click cannot revive an expired one.
    expect(await attribute(t, NEWBIE, ref("jane", VISITOR, 1))).toMatchObject({
      status: "attributed",
    });
    expect((await attributions(t))[0].clickedAt).toBe(T0 + 40 * DAY);
  });

  test("an account first seen through a share link, after the click, is still new", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await t.run(async (ctx) => {
      await ctx.db.insert("projects", {
        ownerId: INFLUENCER.subject,
        title: "Shared plan",
        createdAt: T0 - DAY,
        shareToken: "view-token",
      });
    });
    await click(t, "jane");

    at(T0 + 2 * MINUTE);
    await t.withIdentity(NEWBIE).mutation(api.share.claim, { token: "view-token" });
    const profile = await t.run((ctx) =>
      ctx.db
        .query("profiles")
        .withIndex("by_owner", (q) => q.eq("ownerId", NEWBIE.subject))
        .unique(),
    );
    expect(profile).not.toBeNull();

    at(T0 + 3 * MINUTE);
    expect(await attribute(t, NEWBIE, ref("jane"))).toEqual({
      status: "attributed",
      affiliate: "jane",
    });
  });

  test.each([
    ["an identity stamp", "identities"],
    ["a profile", "profiles"],
    ["a billing account", "billingAccounts"],
    ["a redeemed code", "codeRedemptions"],
    ["a project", "projects"],
  ] as const)("an account with %s from before the click is not re-attributed", async (_, table) => {
    const t = convexTest(schema, modules);
    at(T0 - DAY);
    await trace(t, VETERAN.subject, table);
    at(T0);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, VETERAN, ref("jane"))).toEqual({
      status: "ignored",
      affiliate: null,
      reason: "existing account",
    });
    expect(await attributions(t)).toEqual([]);
  });

  test("a trace within the tolerance before the first click still counts as new", async () => {
    const t = convexTest(schema, modules);
    at(T0 - NEW_ACCOUNT_TOLERANCE_MS + MINUTE);
    await trace(t, NEWBIE.subject, "profiles");
    at(T0);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({ status: "attributed" });
  });

  test("a trace just past the tolerance before the first click is an existing account", async () => {
    const t = convexTest(schema, modules);
    at(T0 - NEW_ACCOUNT_TOLERANCE_MS - MINUTE);
    await trace(t, VETERAN.subject, "profiles");
    at(T0);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, VETERAN, ref("jane"))).toMatchObject({
      status: "ignored",
      reason: "existing account",
    });
  });

  test("a workspace project handed to a new heir does not make them an existing account", async () => {
    const t = convexTest(schema, modules);
    at(T0 - 90 * DAY);
    await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        slug: "acme",
        name: "Acme",
        createdBy: VETERAN.subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      });
      // Made by someone else, since passed to the newcomer.
      await ctx.db.insert("projects", {
        ownerId: NEWBIE.subject,
        title: "Inherited",
        createdAt: 1,
        workspaceId,
      });
    });
    at(T0);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({ status: "attributed" });
  });

  test("newness is measured against the visitor's first click, not the latest", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");
    at(T0 + DAY);
    await trace(t, NEWBIE.subject, "profiles");
    at(T0 + 2 * DAY);
    await click(t, "jane");

    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({ status: "attributed" });
  });

  test("an operator standing in is refused, and nothing is written", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    await expect(attribute(t, STAND_IN, ref("jane"))).rejects.toThrow(/Read-only/);
    expect(await attributions(t)).toEqual([]);
  });

  test("signed out is refused", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    await expect(t.mutation(api.affiliates.attribute, { ref: ref("jane") })).rejects.toThrow(
      /Not signed in/,
    );
  });

  test("an affiliate cannot attribute themselves", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane", ownerId: INFLUENCER.subject });
    await click(t, "jane");

    expect(await attribute(t, INFLUENCER, ref("jane"))).toEqual({
      status: "ignored",
      affiliate: null,
      reason: "self-referral",
    });
  });

  test("a click older than the window is ignored", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    at(T0 + ATTRIBUTION_WINDOW_MS + MINUTE);
    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({
      status: "ignored",
      reason: "expired",
    });
    expect(await attributions(t)).toEqual([]);
  });

  test("a click just inside the window is attributed", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    at(T0 + ATTRIBUTION_WINDOW_MS - MINUTE);
    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({ status: "attributed" });
  });

  test("clicking again restarts the window", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");
    at(T0 + 20 * DAY);
    await click(t, "jane");

    at(T0 + ATTRIBUTION_WINDOW_MS + DAY);
    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({ status: "attributed" });
  });

  test("last click wins: the cookie names the later affiliate", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    const john = await affiliate(t, { slug: "john" });
    await click(t, "jane");
    at(T0 + DAY);
    await click(t, "john");

    // The route rewrote the cookie on the second click.
    expect(await attribute(t, NEWBIE, ref("john"))).toEqual({
      status: "attributed",
      affiliate: "john",
    });
    expect((await attributions(t))[0].affiliateId).toBe(john);
  });

  test("attribution is written once: a repeat, or another link, answers already", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await affiliate(t, { slug: "john" });
    await click(t, "jane");
    await click(t, "john");

    await attribute(t, NEWBIE, ref("jane"));
    expect(await attribute(t, NEWBIE, ref("jane"))).toEqual({
      status: "already",
      affiliate: "jane",
    });
    expect(await attribute(t, NEWBIE, ref("john"))).toEqual({
      status: "already",
      affiliate: "jane",
    });
    expect(await attribute(t, NEWBIE, "garbage")).toEqual({ status: "already", affiliate: "jane" });
    expect(await attributions(t)).toHaveLength(1);
  });

  test.each([
    ["empty", ""],
    ["garbage", "not-a-ref"],
    ["no visitor", "jane..1"],
    ["not a uuid", "jane.abc.1"],
    ["too many parts", `jane.${VISITOR}.1.2`],
    ["huge", "x".repeat(10_000)],
  ])("a malformed ref (%s) is ignored", async (_, raw) => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, NEWBIE, raw)).toEqual({
      status: "ignored",
      affiliate: null,
      reason: "malformed",
    });
  });

  test("an unknown slug, a disabled link, or a visit that never happened is ignored", async () => {
    const t = convexTest(schema, modules);
    const jane = await affiliate(t, { slug: "jane" });
    await click(t, "jane");

    expect(await attribute(t, NEWBIE, ref("nobody"))).toMatchObject({
      status: "ignored",
      reason: "unknown affiliate",
    });
    // A visitor id the route never minted for this link.
    expect(await attribute(t, NEWBIE, ref("jane", OTHER_VISITOR))).toMatchObject({
      status: "ignored",
      reason: "no such visit",
    });
    await t.run((ctx) => ctx.db.patch(jane, { disabledAt: T0 + 1 }));
    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({
      status: "ignored",
      reason: "disabled",
    });
    expect(await attributions(t)).toEqual([]);
  });

  test("a click that was never counted cannot be claimed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane", VISITOR, { secret: "guessed" });

    expect(await attribute(t, NEWBIE, ref("jane"))).toMatchObject({
      status: "ignored",
      reason: "no such visit",
    });
  });

  test("each person is attributed on their own", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await click(t, "jane");
    await click(t, "jane", OTHER_VISITOR);
    const OTHER = { subject: "user_other" };

    await attribute(t, NEWBIE, ref("jane"));
    await attribute(t, OTHER, ref("jane", OTHER_VISITOR));
    expect((await attributions(t)).map((a) => a.ownerId).sort()).toEqual([
      NEWBIE.subject,
      OTHER.subject,
    ]);
    expect(await t.query(internal.affiliates.slugFor, { ownerId: VETERAN.subject })).toBeNull();
  });
});

describe("attributeByCode", () => {
  const byCode = (t: T, ownerId: string, promotionCodeId: string, when = Date.now()) =>
    t.mutation(internal.affiliates.attributeByCode, { ownerId, promotionCodeId, at: when });

  test("a new account whose checkout used an affiliate's code is theirs, via the code", async () => {
    const t = convexTest(schema, modules);
    const id = await affiliate(t, { slug: "jane", promotionCodeId: "promo_jane" });
    await trace(t, NEWBIE.subject, "profiles");
    at(T0 + 5 * DAY);

    expect(await byCode(t, NEWBIE.subject, "promo_jane")).toEqual({
      status: "attributed",
      affiliate: "jane",
    });
    const [row] = await attributions(t);
    expect(row).toMatchObject({ ownerId: NEWBIE.subject, affiliateId: id, via: "code" });
    expect(row.visitorId).toBeUndefined();
    expect(row.clickedAt).toBeUndefined();
    expect(await t.query(internal.affiliates.slugFor, { ownerId: NEWBIE.subject })).toBe("jane");
  });

  test("an account with no trace at all is new", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane", promotionCodeId: "promo_jane" });
    expect(await byCode(t, NEWBIE.subject, "promo_jane")).toMatchObject({ status: "attributed" });
  });

  test("a link attribution always wins over a code", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane" });
    await affiliate(t, { slug: "john", promotionCodeId: "promo_john" });
    await click(t, "jane");
    await attribute(t, NEWBIE, ref("jane"));

    expect(await byCode(t, NEWBIE.subject, "promo_john")).toEqual({
      status: "already",
      affiliate: "jane",
    });
    expect(await attributions(t)).toHaveLength(1);
  });

  test("an old customer redeeming a code is not a referral", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane", promotionCodeId: "promo_jane" });
    await trace(t, VETERAN.subject, "billingAccounts");
    at(T0 + ATTRIBUTION_WINDOW_MS + DAY);

    expect(await byCode(t, VETERAN.subject, "promo_jane")).toMatchObject({
      status: "ignored",
      reason: "existing account",
    });
  });

  test("unknown codes, disabled affiliates and self-referral are ignored", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "gone", promotionCodeId: "promo_gone", disabledAt: 1 });
    await affiliate(t, {
      slug: "jane",
      promotionCodeId: "promo_jane",
      ownerId: INFLUENCER.subject,
    });

    expect(await byCode(t, NEWBIE.subject, "promo_nobody")).toMatchObject({ status: "ignored" });
    expect(await byCode(t, NEWBIE.subject, "promo_gone")).toMatchObject({ status: "ignored" });
    expect(await byCode(t, INFLUENCER.subject, "promo_jane")).toMatchObject({
      status: "ignored",
      reason: "self-referral",
    });
    expect(await attributions(t)).toEqual([]);
  });

  test("is idempotent", async () => {
    const t = convexTest(schema, modules);
    await affiliate(t, { slug: "jane", promotionCodeId: "promo_jane" });
    await byCode(t, NEWBIE.subject, "promo_jane");
    expect(await byCode(t, NEWBIE.subject, "promo_jane")).toEqual({
      status: "already",
      affiliate: "jane",
    });
    expect(await attributions(t)).toHaveLength(1);
  });
});

/** A row an account leaves behind in `table`, made now. */
async function trace(
  t: T,
  ownerId: string,
  table: "identities" | "profiles" | "billingAccounts" | "codeRedemptions" | "projects",
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    switch (table) {
      case "identities":
        await ctx.db.insert("identities", { ownerId, checkedAt: now });
        break;
      case "profiles":
        await ctx.db.insert("profiles", { ownerId, status: "done", createdAt: now });
        break;
      case "billingAccounts":
        await ctx.db.insert("billingAccounts", {
          ownerId,
          acceptedCompletions: 0,
          chatConversations: 0,
          createdAt: now,
        });
        break;
      case "codeRedemptions": {
        const codeId = await ctx.db.insert("accessCodes", {
          code: "FRIENDS",
          label: "Friends",
          redemptions: 1,
          createdAt: now,
        });
        await ctx.db.insert("codeRedemptions", { codeId, ownerId, redeemedAt: now });
        break;
      }
      case "projects":
        await ctx.db.insert("projects", { ownerId, title: "Mine", createdAt: now });
        break;
    }
  });
}
