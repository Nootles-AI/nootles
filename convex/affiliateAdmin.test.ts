/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import componentSchema from "../node_modules/@convex-dev/stripe/src/component/schema";
import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { DEFAULT_DESTINATION, formatRef, signClick } from "./affiliateRules";
import { checkoutDiscountOf } from "./billing";
import { onStripeEvent } from "./http";
import schema from "./schema";

/**
 * Affiliates from the operator's chair, and where they meet money: making and
 * changing links, the numbers ops reads, checkout carrying the affiliate into
 * Stripe, and a promotion code claiming a buyer. Driven as the people
 * involved — an operator (and someone who is not one), visitors clicking,
 * new accounts at every stage of the funnel, a Team buyer, an affiliate
 * themselves — with Stripe replaced throughout.
 */

const stripe = vi.hoisted(() => ({
  priceRetrieve: vi.fn(),
  promotionList: vi.fn(),
  promotionRetrieve: vi.fn(),
  sessionRetrieve: vi.fn(),
  getOrCreateCustomer: vi.fn(),
  createCustomer: vi.fn(),
  createCheckoutSession: vi.fn(),
}));

vi.mock("stripe", () => ({
  default: class {
    prices = { retrieve: stripe.priceRetrieve };
    promotionCodes = { list: stripe.promotionList, retrieve: stripe.promotionRetrieve };
    checkout = { sessions: { retrieve: stripe.sessionRetrieve } };
  },
}));

vi.mock("@convex-dev/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@convex-dev/stripe")>()),
  StripeSubscriptions: class {
    getOrCreateCustomer = stripe.getOrCreateCustomer;
    createCustomer = stripe.createCustomer;
    createCheckoutSession = stripe.createCheckoutSession;
  },
}));

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/stripe/src/component/**/*.ts",
);

const SECRET = "a-shared-click-secret";
const TOKEN = "ops-token";
const NOW = Date.UTC(2026, 8, 28, 12);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const MONTHLY = "price_monthly";
const ANNUAL = "price_annual";
const SEAT = "price_team_seat";
const USAGE = "price_team_usage";
const PRICES: Record<string, { unit_amount: number; currency: string; interval: string }> = {
  [MONTHLY]: { unit_amount: 1200, currency: "usd", interval: "month" },
  // 832.5 a month: rounding, not truncation, is what `revenue` does.
  [ANNUAL]: { unit_amount: 9990, currency: "usd", interval: "year" },
  [SEAT]: { unit_amount: 800, currency: "usd", interval: "month" },
};

type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("AFFILIATE_CLICK_SECRET", SECRET);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_affiliates");
  vi.stubEnv("STRIPE_PRICE_MONTHLY", MONTHLY);
  vi.stubEnv("STRIPE_PRICE_ANNUAL", ANNUAL);
  vi.stubEnv("STRIPE_PRICE_TEAM_SEAT", SEAT);
  vi.stubEnv("STRIPE_PRICE_TEAM_USAGE", USAGE);
  vi.stubEnv("STRIPE_TEAM_METER_EVENT", "team_ai_cents");
  vi.stubEnv("APP_URL", "https://app.test");
  stripe.priceRetrieve.mockImplementation(async (id: string) => {
    const price = PRICES[id];
    if (!price) throw new Error(`No such price: '${id}'`);
    return { id, unit_amount: price.unit_amount, currency: price.currency, recurring: { interval: price.interval } };
  });
  stripe.getOrCreateCustomer.mockResolvedValue({ customerId: "cus_me", isNew: true });
  stripe.createCustomer.mockResolvedValue({ customerId: "cus_ws" });
  stripe.createCheckoutSession.mockResolvedValue({ sessionId: "cs_1", url: "https://pay.test/cs_1" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function harness(): T {
  const t = convexTest(schema, modules);
  t.registerComponent("stripe", componentSchema, componentModules);
  return t;
}

const at = (ms: number) => vi.setSystemTime(ms);

async function admin(t: T, expiresAt = NOW + DAY) {
  await t.run((ctx) => ctx.db.insert("adminSessions", { token: TOKEN, createdAt: 1, expiresAt }));
}

const create = (t: T, args: { slug: string; name?: string; note?: string; destination?: string; ownerId?: string }) =>
  t.mutation(api.adminBilling.affiliateCreate, { token: TOKEN, name: args.slug, ...args });

let visitorSeq = 0;
/** A fresh visitor id, as the route mints one. */
const visitor = () => `00000000-0000-4000-8000-${String(++visitorSeq).padStart(12, "0")}`;

/** A signed click from `visitorId`, now. */
async function click(t: T, slug: string, visitorId: string) {
  const signedAt = Date.now();
  const signature = await signClick(SECRET, { slug, visitorId, signedAt });
  return await t.mutation(api.affiliates.recordClick, { slug, visitorId, signedAt, signature });
}

/** A brand-new person who clicks `slug` and signs up through it. */
async function signUp(t: T, subject: string, slug: string) {
  const visitorId = visitor();
  await click(t, slug, visitorId);
  const outcome = await t
    .withIdentity({ subject })
    .mutation(api.affiliates.attribute, { ref: formatRef({ slug, visitorId, clickedAt: Date.now() }) });
  expect(outcome).toMatchObject({ status: "attributed", affiliate: slug });
}

async function profile(t: T, ownerId: string, status: Doc<"profiles">["status"], email = `${ownerId}@test`) {
  await t.run((ctx) =>
    ctx.db.insert("profiles", { ownerId, email, name: ownerId, status, createdAt: Date.now() }),
  );
}

async function account(t: T, ownerId: string, fields: Partial<Doc<"billingAccounts">> = {}) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique();
    if (existing) await ctx.db.patch(existing._id, fields);
    else
      await ctx.db.insert("billingAccounts", {
        ownerId,
        acceptedCompletions: 0,
        chatConversations: 0,
        createdAt: Date.now(),
        ...fields,
      });
  });
}

const subscription = (priceId: string, interval: "month" | "year", status = "active") => ({
  subscription: {
    status,
    interval,
    currentPeriodEnd: Math.floor((NOW + 20 * DAY) / 1000),
    cancelAtPeriodEnd: false,
    priceId,
    subscriptionId: `sub_${priceId}_${status}`,
    updatedAt: 1,
  },
});

const walls = { walls: { firstAt: NOW, lastAt: NOW, projects: 1, completions: 0, chats: 0 } };

/** A workspace `buyer` opened Team checkout for, paying for `seats` seats, or not live. */
async function teamWorkspace(t: T, buyer: string, seats: number, status = "active") {
  return await t.run(async (ctx) => {
    const workspaceId = await ctx.db.insert("workspaces", {
      slug: `ws-${buyer}-${status}`,
      name: `WS ${buyer}`,
      createdBy: "user_someone_else",
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: 1,
    });
    await ctx.db.insert("auditEvents", {
      workspaceId,
      actorId: buyer,
      actorKind: "user",
      action: "billing.checkout",
      category: "billing",
      subjectKind: "workspace",
      subjectId: workspaceId,
      meta: { seats },
      at: Date.now(),
    });
    await ctx.db.insert("workspaceBilling", {
      workspaceId,
      stripeCustomerId: `cus_${buyer}`,
      subscriptionId: `sub_${buyer}`,
      status,
      seats,
      periodStart: NOW - 10 * DAY,
      periodEnd: NOW + 20 * DAY,
      aiAllowanceUsd: 0,
      updatedAt: 1,
    });
    return workspaceId;
  });
}

/** A `checkout.session.completed` event as Stripe delivers it. */
function completed(session: Record<string, unknown>, created = Math.floor(NOW / 1000)) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    created,
    data: {
      object: {
        id: "cs_live",
        object: "checkout.session",
        mode: "subscription",
        customer: "cus_me",
        metadata: {},
        discounts: [],
        total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 0 },
        client_reference_id: null,
        ...session,
      },
    },
  };
}

const attributionOf = (t: T, ownerId: string) =>
  t.run((ctx) =>
    ctx.db
      .query("affiliateAttributions")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .unique(),
  );

async function linkCode(t: T, id: Id<"affiliates">, promotionCodeId: string, promotionCode: string) {
  await t.mutation(internal.adminBilling.affiliateSetPromotion, {
    id,
    promotion: { promotionCodeId, promotionCode },
  });
}

// ---------------------------------------------------------------------------

describe("the admin gate", () => {
  test("every affiliate function refuses a stranger's token and an expired session, and writes nothing", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });

    const calls = (token: string) => [
      () => t.query(api.adminBilling.affiliateList, { token }),
      () => t.query(api.adminBilling.affiliateDetail, { token, id }),
      () => t.mutation(api.adminBilling.affiliateCreate, { token, slug: "john", name: "John" }),
      () => t.mutation(api.adminBilling.affiliateUpdate, { token, id, name: "Hijacked" }),
      () => t.mutation(api.adminBilling.affiliateSetDisabled, { token, id, disabled: true }),
      () => t.action(api.adminBilling.affiliateLinkPromotion, { token, id, code: "JANE10" }),
      () => t.action(api.adminBilling.affiliateStats, { token }),
    ];
    for (const call of calls("not-a-session")) await expect(call()).rejects.toThrow("Not authorized");
    at(NOW + 2 * DAY);
    for (const call of calls(TOKEN)) await expect(call()).rejects.toThrow("Not authorized");

    const rows = await t.run((ctx) => ctx.db.query("affiliates").collect());
    expect(rows).toMatchObject([{ slug: "jane", name: "jane" }]);
    expect(rows[0].disabledAt).toBeUndefined();
    expect(rows[0].promotionCodeId).toBeUndefined();
    expect(stripe.promotionList).not.toHaveBeenCalled();
    expect(stripe.priceRetrieve).not.toHaveBeenCalled();
  });

  test("a signed-in user is not an operator", async () => {
    const t = harness();
    await admin(t);
    const user = t.withIdentity({ subject: "user_curious" });
    await expect(user.query(api.adminBilling.affiliateList, { token: "" })).rejects.toThrow(
      "Not authorized",
    );
    await expect(
      user.mutation(api.adminBilling.affiliateCreate, { token: "", slug: "me", name: "Me" }),
    ).rejects.toThrow("Not authorized");
  });
});

describe("affiliateCreate", () => {
  test("normalizes the slug, defaults the destination, and trims what was typed", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "  Jane Doe ", name: " Jane ", note: " YouTube ", ownerId: " user_jane " });

    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      slug: "jane-doe",
      name: "Jane",
      note: "YouTube",
      destination: DEFAULT_DESTINATION,
      ownerId: "user_jane",
      createdAt: NOW,
    });
  });

  test("keeps an allowed destination and leaves blank extras absent", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, {
      slug: "writers",
      destination: "https://app.nootles.com/sign-in",
      note: "  ",
      ownerId: "",
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row?.destination).toBe("https://app.nootles.com/sign-in");
    expect(row).not.toHaveProperty("note");
    expect(row).not.toHaveProperty("ownerId");
  });

  test.each([
    ["too short", "j"],
    ["too long", "x".repeat(41)],
    ["nothing usable", "!!!"],
    ["reserved", "admin"],
    ["reserved in another case", "Nootles"],
  ])("refuses a slug that is %s, saying why", async (_, slug) => {
    const t = harness();
    await admin(t);
    await expect(create(t, { slug })).rejects.toThrow(/can’t be a link: use 2–40 letters/);
    expect(await t.run((ctx) => ctx.db.query("affiliates").collect())).toEqual([]);
  });

  test("refuses a slug already taken, even typed differently", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane", name: "Jane" });
    await expect(create(t, { slug: "JANE", name: "Other Jane" })).rejects.toThrow(
      "/r/jane already belongs to Jane.",
    );
  });

  test.each([
    "http://nootles.com/",
    "https://evil.example/",
    "https://nootles.com.evil.example/",
    "https://user:pw@nootles.com/",
    "https://nootles.com:8443/",
    "javascript:alert(1)",
  ])("refuses to send people to %s", async (destination) => {
    const t = harness();
    await admin(t);
    await expect(create(t, { slug: "jane", destination })).rejects.toThrow(
      "A link can only send people to https://nootles.com",
    );
  });

  test("refuses a blank name", async () => {
    const t = harness();
    await admin(t);
    await expect(create(t, { slug: "jane", name: "  " })).rejects.toThrow("An affiliate needs a name");
  });
});

describe("affiliateUpdate and affiliateSetDisabled", () => {
  test("changes only the fields given; an empty note and a null owner clear them", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane", name: "Jane", note: "IG", ownerId: "user_jane" });

    await t.mutation(api.adminBilling.affiliateUpdate, {
      token: TOKEN,
      id,
      destination: "https://www.nootles.com/for/writers",
    });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      slug: "jane",
      name: "Jane",
      note: "IG",
      ownerId: "user_jane",
      destination: "https://www.nootles.com/for/writers",
    });

    await t.mutation(api.adminBilling.affiliateUpdate, {
      token: TOKEN,
      id,
      name: "Jane D.",
      note: "",
      ownerId: null,
    });
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).toMatchObject({ name: "Jane D.", slug: "jane" });
    expect(row).not.toHaveProperty("note");
    expect(row).not.toHaveProperty("ownerId");

    await t.mutation(api.adminBilling.affiliateUpdate, { token: TOKEN, id, ownerId: "user_new" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.ownerId).toBe("user_new");
  });

  test("refuses a blank name or a foreign destination, and changes nothing", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane", name: "Jane" });
    await expect(
      t.mutation(api.adminBilling.affiliateUpdate, { token: TOKEN, id, name: " " }),
    ).rejects.toThrow("An affiliate needs a name");
    await expect(
      t.mutation(api.adminBilling.affiliateUpdate, { token: TOKEN, id, destination: "https://evil.example/" }),
    ).rejects.toThrow("A link can only send people to");
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ name: "Jane", destination: DEFAULT_DESTINATION });
  });

  test("an affiliate that was deleted is reported, not written back", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await t.run((ctx) => ctx.db.delete(id));
    await expect(
      t.mutation(api.adminBilling.affiliateUpdate, { token: TOKEN, id, name: "Back" }),
    ).rejects.toThrow("There is no such affiliate.");
    await expect(
      t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id, disabled: true }),
    ).rejects.toThrow("There is no such affiliate.");
  });

  test("disabling stops the link counting and attributing; enabling brings it back; history stays", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane", destination: "https://nootles.com/for/writers" });
    await signUp(t, "user_early", "jane");

    await t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id, disabled: true });
    expect((await t.run((ctx) => ctx.db.get(id)))?.disabledAt).toBe(NOW);
    // A second disable keeps the first date.
    at(NOW + MINUTE);
    await t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id, disabled: true });
    expect((await t.run((ctx) => ctx.db.get(id)))?.disabledAt).toBe(NOW);

    const late = visitor();
    expect(await click(t, "jane", late)).toEqual({ destination: DEFAULT_DESTINATION, counted: false });
    const [row] = await t.query(api.adminBilling.affiliateList, { token: TOKEN });
    expect(row).toMatchObject({ clicks: 1, visitors: 1, signups: 1, disabledAt: NOW });

    await t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id, disabled: false });
    expect(await t.run((ctx) => ctx.db.get(id))).not.toHaveProperty("disabledAt");
    expect(await click(t, "jane", late)).toEqual({ destination: "https://nootles.com/for/writers", counted: true });
    expect((await t.query(api.adminBilling.affiliateList, { token: TOKEN }))[0]).toMatchObject({
      clicks: 2,
      visitors: 2,
    });
  });
});

describe("affiliateList", () => {
  test("counts clicks, unique visitors and signups per link, newest link first, with the owner's address", async () => {
    const t = harness();
    await admin(t, NOW + 7 * DAY);
    await profile(t, "user_jane", "done", "jane@creator.test");
    await create(t, { slug: "jane", name: "Jane", ownerId: "user_jane" });
    at(NOW + 1);
    await create(t, { slug: "john", name: "John" });

    const a = visitor();
    const b = visitor();
    await click(t, "jane", a);
    await click(t, "jane", a);
    at(NOW + DAY);
    await click(t, "jane", a);
    await click(t, "jane", b);
    await signUp(t, "user_new_1", "jane"); // a third visitor, and a click
    at(NOW + 2 * DAY);
    await click(t, "jane", visitor()); // a fourth, opening the day
    await click(t, "jane", b); // b again, on a day already counting
    await click(t, "john", visitor());

    const rows = await t.query(api.adminBilling.affiliateList, { token: TOKEN });
    expect(rows.map((r) => r.slug)).toEqual(["john", "jane"]);
    expect(rows[1]).toEqual({
      _id: expect.any(String),
      slug: "jane",
      name: "Jane",
      destination: DEFAULT_DESTINATION,
      ownerId: "user_jane",
      ownerEmail: "jane@creator.test",
      createdAt: NOW,
      clicks: 7,
      visitors: 4,
      signups: 1,
    });
    expect(rows[0]).toMatchObject({ clicks: 1, visitors: 1, signups: 0 });
    expect(rows[0]).not.toHaveProperty("ownerEmail");

    // The totals agree with the rows they count.
    const visits = await t.run((ctx) => ctx.db.query("affiliateVisits").collect());
    const jane = visits.filter((v) => v.affiliateId === rows[1]._id);
    expect(jane.length).toBe(4);
    expect(jane.reduce((sum, v) => sum + v.clicks, 0)).toBe(7);
  });

  test("an unsigned click counts nowhere", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await t.mutation(api.affiliates.recordClick, {
      slug: "jane",
      visitorId: visitor(),
      signedAt: NOW,
      signature: "0".repeat(64),
    });
    expect((await t.query(api.adminBilling.affiliateList, { token: TOKEN }))[0]).toMatchObject({
      clicks: 0,
      visitors: 0,
      signups: 0,
    });
  });
});

describe("affiliateDetail", () => {
  test("charts the last ninety days, oldest first, quiet days as zeros", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    const v = visitor();
    at(NOW - 90 * DAY); // one day before the window
    await click(t, "jane", v);
    at(NOW - 89 * DAY); // the window's first day
    await click(t, "jane", v);
    await click(t, "jane", visitor());
    at(NOW);
    await click(t, "jane", v);

    const { days, affiliate } = await t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id });
    expect(days).toHaveLength(90);
    expect(days[0]).toEqual({ day: "2026-07-01", clicks: 2, visitors: 2 });
    expect(days[89]).toEqual({ day: "2026-09-28", clicks: 1, visitors: 1 });
    expect(days.slice(1, 89).every((d) => d.clicks === 0 && d.visitors === 0)).toBe(true);
    expect(new Set(days.map((d) => d.day)).size).toBe(90);
    // All-time totals are the link's, window or not.
    expect(affiliate).toMatchObject({ slug: "jane", clicks: 4, visitors: 2 });
  });

  test("the chart ends on the reader's day when told it, however long the cache has held the server's", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await click(t, "jane", visitor());
    const { days } = await t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id, today: "2026-10-05" });
    expect(days).toHaveLength(90);
    expect(days.at(-1)).toEqual({ day: "2026-10-05", clicks: 0, visitors: 0 });
    expect(days.find((d) => d.day === "2026-09-28")).toEqual({ day: "2026-09-28", clicks: 1, visitors: 1 });
    // Anything that is not a day falls back to the server's.
    for (const today of ["tomorrow", "2026-13-45", ""]) {
      const fallback = await t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id, today });
      expect(fallback.days.at(-1)?.day).toBe("2026-09-28");
    }
  });

  test("a link with a long history still charts its latest days", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 400; i++) {
        const day = new Date(NOW - i * DAY).toISOString().slice(0, 10);
        await ctx.db.insert("affiliateDays", { affiliateId: id, day, clicks: i + 1, visitors: 1 });
      }
    });
    const { days } = await t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id });
    expect(days.map((d) => d.clicks)).toEqual(Array.from({ length: 90 }, (_, i) => 90 - i));
  });

  test("lists the accounts it brought, newest first, with how far each got", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await signUp(t, "user_a", "jane");
    await profile(t, "user_a", "done", "a@test");
    await account(t, "user_a", { ...walls, checkoutAt: NOW, ...subscription(MONTHLY, "month") });
    await teamWorkspace(t, "user_a", 3, "canceled"); // bought Team once; it lapsed
    at(NOW + MINUTE);
    await signUp(t, "user_b", "jane");
    await teamWorkspace(t, "user_b", 3);
    await linkCode(t, id, "promo_jane", "JANE10");
    at(NOW + 2 * MINUTE);
    await t.action(internal.billing.attributeCheckout, {
      sessionId: "cs_c",
      promotionCodeIds: ["promo_jane"],
      lookup: false,
      ownerId: "user_c",
      at: NOW + 2 * MINUTE,
    });

    const { accounts } = await t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id });
    expect(accounts).toEqual([
      {
        ownerId: "user_c",
        email: null,
        name: null,
        via: "code",
        attributedAt: NOW + 2 * MINUTE,
        onboarded: false,
        walled: false,
        reachedCheckout: false,
        paying: false,
        team: false,
      },
      {
        ownerId: "user_b",
        email: null,
        name: null,
        via: "link",
        attributedAt: NOW + MINUTE,
        clickedAt: NOW + MINUTE,
        onboarded: false,
        walled: false,
        reachedCheckout: false,
        paying: false,
        team: true,
      },
      {
        ownerId: "user_a",
        email: "a@test",
        name: "user_a",
        via: "link",
        attributedAt: NOW,
        clickedAt: NOW,
        onboarded: true,
        walled: true,
        reachedCheckout: true,
        paying: true,
        team: false,
      },
    ]);
  });

  test("an unknown affiliate is reported", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await t.run((ctx) => ctx.db.delete(id));
    await expect(t.query(api.adminBilling.affiliateDetail, { token: TOKEN, id })).rejects.toThrow(
      "There is no such affiliate.",
    );
  });
});

describe("who bought a Team plan", () => {
  test("the buyer the checkout named outranks whoever last opened a checkout, and survives the log aging out", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await create(t, { slug: "john" });
    await signUp(t, "user_a", "jane");
    await signUp(t, "user_b", "john");
    // A opened checkout and paid; B opened another later and walked away.
    const workspaceId = await teamWorkspace(t, "user_a", 3);
    await t.run((ctx) =>
      ctx.db.insert("auditEvents", {
        workspaceId,
        actorId: "user_b",
        actorKind: "user",
        action: "billing.checkout",
        category: "billing",
        subjectKind: "workspace",
        subjectId: workspaceId,
        at: Date.now() + 1,
      }),
    );
    const teamsBy = async () =>
      (await t.action(api.adminBilling.affiliateStats, { token: TOKEN })).rows.map((r) => [r.slug, r.teamPaying]);
    expect(await teamsBy()).toEqual([["john", 1], ["jane", 0]]);

    await t.mutation(internal.teamBilling.recordBuyer, { orgId: workspaceId, buyerId: "user_a" });
    expect(await teamsBy()).toEqual([["john", 0], ["jane", 1]]);
    // The audit log ages out; the buyer stays.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("auditEvents").collect()) await ctx.db.delete(row._id);
    });
    expect(await teamsBy()).toEqual([["john", 0], ["jane", 1]]);
  });

  test("a buyer for a workspace with no billing row, or no such workspace, is not written", async () => {
    const t = harness();
    await t.mutation(internal.teamBilling.recordBuyer, { orgId: "not-an-id", buyerId: "user_a" });
    const workspaceId = await t.run((ctx) =>
      ctx.db.insert("workspaces", {
        slug: "bare",
        name: "Bare",
        createdBy: "user_c",
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      }),
    );
    await t.mutation(internal.teamBilling.recordBuyer, { orgId: workspaceId, buyerId: "user_a" });
    expect(await t.run((ctx) => ctx.db.query("workspaceBilling").collect())).toEqual([]);
  });
});

describe("affiliateLinkPromotion", () => {
  test("finds the code in Stripe as typed, active or not, and links it; null unlinks", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    stripe.promotionList.mockResolvedValue({ data: [{ id: "promo_jane", code: "JANE10", active: false }] });

    expect(
      await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id, code: " jane10 " }),
    ).toEqual({ promotionCodeId: "promo_jane", promotionCode: "JANE10" });
    expect(stripe.promotionList).toHaveBeenCalledWith({ code: "jane10", limit: 1 });
    expect((await t.query(api.adminBilling.affiliateList, { token: TOKEN }))[0]).toMatchObject({
      promotionCodeId: "promo_jane",
      promotionCode: "JANE10",
    });

    expect(await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id, code: null })).toBeNull();
    const row = await t.run((ctx) => ctx.db.get(id));
    expect(row).not.toHaveProperty("promotionCodeId");
    expect(row).not.toHaveProperty("promotionCode");
    expect(stripe.promotionList).toHaveBeenCalledOnce();
  });

  test("a code Stripe does not have is reported, and nothing is linked", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    stripe.promotionList.mockResolvedValue({ data: [] });
    await expect(
      t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id, code: "NOPE" }),
    ).rejects.toThrow("Stripe has no promotion code “NOPE”.");
    await expect(
      t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id, code: "  " }),
    ).rejects.toThrow("Type the code");
    expect(await t.run((ctx) => ctx.db.get(id))).not.toHaveProperty("promotionCodeId");
  });

  test("a code already another enabled affiliate's is refused; a disabled one's can be taken over", async () => {
    const t = harness();
    await admin(t);
    const jane = await create(t, { slug: "jane", name: "Jane" });
    const john = await create(t, { slug: "john", name: "John" });
    stripe.promotionList.mockResolvedValue({ data: [{ id: "promo_x", code: "SHARED" }] });

    await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id: jane, code: "SHARED" });
    // Relinking the same affiliate is fine.
    await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id: jane, code: "SHARED" });
    await expect(
      t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id: john, code: "SHARED" }),
    ).rejects.toThrow("SHARED is already Jane’s code.");

    await t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id: jane, disabled: true });
    await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id: john, code: "SHARED" });
    expect((await t.run((ctx) => ctx.db.get(john)))?.promotionCodeId).toBe("promo_x");
    // Jane cannot come back holding John's code; without it she can.
    await expect(
      t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id: jane, disabled: false }),
    ).rejects.toThrow("SHARED is already John’s code.");
    await t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id: jane, code: null });
    await t.mutation(api.adminBilling.affiliateSetDisabled, { token: TOKEN, id: jane, disabled: false });
    expect(await t.run((ctx) => ctx.db.get(jane))).not.toHaveProperty("disabledAt");
  });

  test("with no Stripe key on the deployment it says so", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(
      t.action(api.adminBilling.affiliateLinkPromotion, { token: TOKEN, id, code: "JANE10" }),
    ).rejects.toThrow("No Stripe key is set on this deployment.");
  });
});

// ---------------------------------------------------------------------------

/**
 * Jane's link, and everyone it touched, one of each: a visitor who only
 * looked, and new accounts that stopped at every step — plus two paying (one
 * monthly, one yearly), a Team buyer, a code-only buyer, a VIP who was let in
 * for free, and a customer who cancelled. John's link brings one monthly
 * payer, to show the columns stay apart.
 */
async function cast(t: T) {
  await admin(t);
  const jane = await create(t, { slug: "jane", name: "Jane" });
  const john = await create(t, { slug: "john", name: "John" });
  await linkCode(t, jane, "promo_jane", "JANE10");
  stripe.promotionRetrieve.mockImplementation(async (id: string) => ({ id, times_redeemed: 7 }));

  await click(t, "jane", visitor()); // clicked, never signed up

  await signUp(t, "user_signed_up", "jane"); // no profile yet
  await signUp(t, "user_surveying", "jane");
  await profile(t, "user_surveying", "surveying");
  await signUp(t, "user_onboarded", "jane");
  await profile(t, "user_onboarded", "done");
  await signUp(t, "user_skipped", "jane");
  await profile(t, "user_skipped", "skipped");
  await signUp(t, "user_walled", "jane");
  await profile(t, "user_walled", "touring");
  await account(t, "user_walled", walls);
  await signUp(t, "user_checkout", "jane");
  await profile(t, "user_checkout", "done");
  await account(t, "user_checkout", { ...walls, checkoutAt: NOW, checkouts: 1 });
  await signUp(t, "user_monthly", "jane");
  await profile(t, "user_monthly", "done");
  await account(t, "user_monthly", { ...walls, checkoutAt: NOW, ...subscription(MONTHLY, "month") });
  await signUp(t, "user_yearly", "jane");
  await profile(t, "user_yearly", "done");
  await account(t, "user_yearly", { checkoutAt: NOW, ...subscription(ANNUAL, "year") });
  await signUp(t, "user_cancelled", "jane");
  await account(t, "user_cancelled", { checkoutAt: NOW, ...subscription(MONTHLY, "month", "canceled") });
  await signUp(t, "user_vip", "jane");
  await account(t, "user_vip", { vip: true, ...subscription(MONTHLY, "month") });
  await signUp(t, "user_team", "jane");
  await profile(t, "user_team", "done");
  await teamWorkspace(t, "user_team", 4);
  // A workspace that stopped paying counts for nobody, even bought by a referral.
  await teamWorkspace(t, "user_team", 9, "canceled");
  await teamWorkspace(t, "user_checkout", 2, "canceled");

  // Bought with Jane's code without ever clicking her link.
  await t.action(internal.billing.attributeCheckout, {
    sessionId: "cs_code",
    promotionCodeIds: ["promo_jane"],
    lookup: false,
    ownerId: "user_code",
    at: NOW,
  });
  await account(t, "user_code", { checkoutAt: NOW, ...subscription(MONTHLY, "month") });

  await signUp(t, "user_john_payer", "john");
  await account(t, "user_john_payer", subscription(MONTHLY, "month"));

  // Paying, but nobody's referral: counted nowhere here.
  await account(t, "user_organic", subscription(ANNUAL, "year"));
  await teamWorkspace(t, "user_organic", 12);
  return { jane, john };
}

describe("affiliateStats", () => {
  test("derives each link's funnel and prices what it brought as revenue does", async () => {
    const t = harness();
    const { jane, john } = await cast(t);

    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    expect(stats).toEqual({
      rows: [
        {
          id: john,
          slug: "john",
          name: "John",
          clicks: 1,
          visitors: 1,
          signups: 1,
          viaLink: 1,
          viaCode: 0,
          onboarded: 0,
          walled: 0,
          reachedCheckout: 0,
          paying: 1,
          mrr: 1200,
          teamPaying: 0,
          teamMrr: 0,
        },
        {
          id: jane,
          slug: "jane",
          name: "Jane",
          clicks: 12,
          visitors: 12,
          signups: 12,
          viaLink: 11,
          viaCode: 1,
          // done, skipped, touring, done, done, done, done — not surveying, not the profileless.
          onboarded: 7,
          walled: 3,
          reachedCheckout: 5,
          // monthly, yearly, the code buyer — not the cancelled one, not the VIP.
          paying: 3,
          mrr: 1200 + 833 + 1200,
          teamPaying: 1,
          teamMrr: 4 * 800,
          promotionRedemptions: 7,
        },
      ],
      currency: "usd",
      unpriced: 0,
      generatedAt: NOW,
    });
    // Once per price, and once per linked code.
    expect(stripe.priceRetrieve.mock.calls.map(([id]) => id).sort()).toEqual([ANNUAL, MONTHLY, SEAT]);
    expect(stripe.promotionRetrieve).toHaveBeenCalledExactlyOnceWith("promo_jane");
  });

  test("paying is exactly what revenue calls paying", async () => {
    const t = harness();
    await cast(t);
    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    const revenue = await t.action(api.adminBilling.revenue, { token: TOKEN });

    const attributed = new Set(
      (await t.run((ctx) => ctx.db.query("affiliateAttributions").collect())).map((a) => a.ownerId),
    );
    const payingAttributed = revenue.paying.filter((p) => attributed.has(p.ownerId));
    expect(stats.rows.reduce((sum, r) => sum + r.paying, 0)).toBe(payingAttributed.length);
    expect(stats.rows.reduce((sum, r) => sum + r.mrr, 0)).toBe(
      payingAttributed.reduce((sum, p) => sum + (p.monthly ?? 0), 0),
    );
  });

  test("a price Stripe cannot give leaves its payers unpriced rather than failing", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await signUp(t, "user_legacy", "jane");
    await account(t, "user_legacy", subscription("price_retired", "month"));
    await signUp(t, "user_team", "jane");
    await teamWorkspace(t, "user_team", 2);
    vi.stubEnv("STRIPE_PRICE_TEAM_SEAT", "price_seat_gone");

    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    expect(stats).toMatchObject({ currency: null, unpriced: 2 });
    expect(stats.rows[0]).toMatchObject({ paying: 1, mrr: 0, teamPaying: 1, teamMrr: 0 });
    expect(stats.rows[0]).not.toHaveProperty("promotionRedemptions");
  });

  test("an annual Team seat price is counted a twelfth a month", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await signUp(t, "user_team", "jane");
    await teamWorkspace(t, "user_team", 7);
    PRICES[SEAT].interval = "year";
    try {
      const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
      expect(stats.rows[0].teamMrr).toBe(467); // 7 × 800 / 12 = 466.67
    } finally {
      PRICES[SEAT].interval = "month";
    }
  });

  test("a funnel of more accounts than one page is read whole", async () => {
    const t = harness();
    await admin(t);
    const id = await create(t, { slug: "jane" });
    await t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert("affiliateAttributions", {
          ownerId: `user_bulk_${i}`,
          affiliateId: id,
          attributedAt: NOW + i,
          via: i % 10 === 0 ? "code" : "link",
        });
        if (i % 2 === 0) {
          await ctx.db.insert("profiles", { ownerId: `user_bulk_${i}`, status: "done", createdAt: 1 });
        }
      }
    });
    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    expect(stats.rows[0]).toMatchObject({ signups: 230, viaCode: 23, viaLink: 207, onboarded: 115 });
  });

  test("with nothing to price, Stripe is not asked — even with no key", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await signUp(t, "user_free", "jane");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    expect(stats.rows[0]).toMatchObject({ signups: 1, paying: 0, mrr: 0 });
    expect(stripe.priceRetrieve).not.toHaveBeenCalled();
  });

  test("with something to price and no key, it says so", async () => {
    const t = harness();
    await cast(t);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(t.action(api.adminBilling.affiliateStats, { token: TOKEN })).rejects.toThrow(
      "No Stripe key is set on this deployment.",
    );
  });
});

// ---------------------------------------------------------------------------

describe("checkout carries the affiliate into Stripe", () => {
  test("an attributed person's Pro checkout names the affiliate on the subscription, and them as the buyer", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await signUp(t, "user_new", "jane");

    await t.withIdentity({ subject: "user_new" }).action(api.billing.startCheckout, { interval: "month" });
    const session = stripe.createCheckoutSession.mock.calls[0][1];
    expect(session.subscriptionMetadata).toEqual({ userId: "user_new", affiliate: "jane" });
    expect(session.params).toEqual({ allow_promotion_codes: true, client_reference_id: "user_new" });
    expect(session).not.toHaveProperty("metadata");
  });

  test("someone nobody referred gets no affiliate key at all", async () => {
    const t = harness();
    await t.withIdentity({ subject: "user_plain" }).action(api.billing.startCheckout, { interval: "year" });
    const session = stripe.createCheckoutSession.mock.calls[0][1];
    expect(session.subscriptionMetadata).toEqual({ userId: "user_plain" });
    expect(session.priceId).toBe(ANNUAL);
  });

  test("a stand-in still cannot open checkout, and nothing is looked up for them", async () => {
    const t = harness();
    await expect(
      t.withIdentity({ subject: "user_new", act: "ops" }).action(api.billing.startCheckout, { interval: "month" }),
    ).rejects.toThrow("Read-only");
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  async function workspaceAdminedBy(t: T, subject: string) {
    return await t.run(async (ctx) => {
      const workspaceId = await ctx.db.insert("workspaces", {
        slug: "acme",
        name: "Acme",
        createdBy: subject,
        plan: "team",
        settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
        createdAt: 1,
      });
      await ctx.db.insert("workspaceSlugs", { slug: "acme", workspaceId });
      await ctx.db.insert("memberships", {
        workspaceId,
        userId: subject,
        role: "owner",
        status: "active",
        joinedAt: 1,
      });
      return workspaceId;
    });
  }

  test("an attributed admin's Team checkout names the affiliate on session and subscription", async () => {
    const t = harness();
    await admin(t);
    await create(t, { slug: "jane" });
    await signUp(t, "user_boss", "jane");
    const workspaceId = await workspaceAdminedBy(t, "user_boss");

    await t.withIdentity({ subject: "user_boss" }).action(api.billing.startTeamCheckout, { workspaceId });
    const session = stripe.createCheckoutSession.mock.calls[0][1];
    expect(session.metadata).toEqual({ orgId: workspaceId, affiliate: "jane" });
    expect(session.subscriptionMetadata).toEqual({ orgId: workspaceId, affiliate: "jane" });
    expect(session.subscriptionMetadata).not.toHaveProperty("userId");
    expect(session.params).toMatchObject({ allow_promotion_codes: true, client_reference_id: "user_boss" });
  });

  test("an unreferred admin's Team checkout carries only the workspace", async () => {
    const t = harness();
    const workspaceId = await workspaceAdminedBy(t, "user_boss");
    await t.withIdentity({ subject: "user_boss" }).action(api.billing.startTeamCheckout, { workspaceId });
    const session = stripe.createCheckoutSession.mock.calls[0][1];
    expect(session.metadata).toEqual({ orgId: workspaceId });
    expect(session.subscriptionMetadata).toEqual({ orgId: workspaceId });
  });

  test("a stand-in is still refused Team checkout", async () => {
    const t = harness();
    const workspaceId = await workspaceAdminedBy(t, "user_boss");
    await expect(
      t.withIdentity({ subject: "user_boss", act: "ops" }).action(api.billing.startTeamCheckout, { workspaceId }),
    ).rejects.toThrow("Read-only");
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("checkoutDiscountOf", () => {
  test("is null for any other event, and for a checkout with nothing off", () => {
    expect(checkoutDiscountOf({ ...completed({}), type: "customer.subscription.created" })).toBeNull();
    expect(checkoutDiscountOf(completed({}))).toBeNull();
    expect(checkoutDiscountOf(completed({ discounts: null, total_details: null }))).toBeNull();
  });

  test("names the promotion codes the session took, expanded or not", () => {
    expect(
      checkoutDiscountOf(
        completed({
          client_reference_id: "user_buyer",
          discounts: [{ coupon: "co_1", promotion_code: "promo_a" }, { coupon: null, promotion_code: { id: "promo_b" } }],
          total_details: { amount_discount: 300 },
        }),
      ),
    ).toEqual({
      sessionId: "cs_live",
      promotionCodeIds: ["promo_a", "promo_b"],
      lookup: false,
      ownerId: "user_buyer",
      customerId: "cus_me",
      at: Math.floor(NOW / 1000) * 1000,
    });
  });

  test("a coupon applied without a code is nobody's referral", () => {
    expect(
      checkoutDiscountOf(
        completed({ discounts: [{ coupon: "co_1", promotion_code: null }], total_details: { amount_discount: 300 } }),
      ),
    ).toBeNull();
  });

  test("money off with no discounts listed asks for one lookup, and carries a workspace", () => {
    expect(
      checkoutDiscountOf(
        completed({ discounts: [], metadata: { orgId: "ws_1" }, total_details: { amount_discount: 300 } }),
      ),
    ).toMatchObject({ promotionCodeIds: [], lookup: true, orgId: "ws_1" });
  });
});

describe("a checkout's promotion code attributes its buyer", () => {
  async function janeWithCode(t: T) {
    await admin(t);
    const id = await create(t, { slug: "jane", ownerId: "user_jane" });
    await linkCode(t, id, "promo_jane", "JANE10");
    return id;
  }
  const attribute = (t: T, fields: Partial<Parameters<typeof checkoutArgs>[0]> = {}) =>
    t.action(internal.billing.attributeCheckout, checkoutArgs(fields));
  function checkoutArgs(fields: {
    promotionCodeIds?: string[];
    lookup?: boolean;
    ownerId?: string;
    orgId?: string;
    customerId?: string;
    at?: number;
  }) {
    return { sessionId: "cs_live", promotionCodeIds: ["promo_jane"], lookup: false, at: NOW, ...fields };
  }

  test("a new account's checkout with the code is Jane's, via the code", async () => {
    const t = harness();
    const jane = await janeWithCode(t);
    await attribute(t, { ownerId: "user_buyer" });
    expect(await attributionOf(t, "user_buyer")).toMatchObject({ affiliateId: jane, via: "code" });
    expect(stripe.sessionRetrieve).not.toHaveBeenCalled();
  });

  test("someone a link already brought keeps their link", async () => {
    const t = harness();
    await janeWithCode(t);
    const john = await create(t, { slug: "john" });
    await signUp(t, "user_linked", "john");
    await attribute(t, { ownerId: "user_linked" });
    expect(await attributionOf(t, "user_linked")).toMatchObject({ affiliateId: john, via: "link" });
  });

  test("an account older than the window is a customer using a discount, not a referral", async () => {
    const t = harness();
    await janeWithCode(t);
    await profile(t, "user_old", "done");
    at(NOW + 31 * DAY);
    await attribute(t, { ownerId: "user_old", at: NOW + 31 * DAY });
    expect(await attributionOf(t, "user_old")).toBeNull();
  });

  test("a code no affiliate holds, or the affiliate's own purchase, attributes nobody", async () => {
    const t = harness();
    await janeWithCode(t);
    await attribute(t, { ownerId: "user_buyer", promotionCodeIds: ["promo_someone_else"] });
    await attribute(t, { ownerId: "user_jane" });
    expect(await t.run((ctx) => ctx.db.query("affiliateAttributions").collect())).toEqual([]);
  });

  test("of several codes, the first an affiliate holds decides", async () => {
    const t = harness();
    const jane = await janeWithCode(t);
    await attribute(t, { ownerId: "user_buyer", promotionCodeIds: ["promo_other", "promo_jane"] });
    expect(await attributionOf(t, "user_buyer")).toMatchObject({ affiliateId: jane });
  });

  test("a Team checkout's code credits whoever opened it", async () => {
    const t = harness();
    const jane = await janeWithCode(t);
    const workspaceId = await teamWorkspace(t, "user_team_buyer", 3);
    // Opened before checkout named its buyer: the audit log does.
    await attribute(t, { orgId: workspaceId, customerId: "cus_user_team_buyer" });
    expect(await attributionOf(t, "user_team_buyer")).toMatchObject({ affiliateId: jane, via: "code" });
  });

  test("a Pro checkout without a buyer named falls back to the Stripe customer's user", async () => {
    const t = harness();
    const jane = await janeWithCode(t);
    await t.run(async (ctx) => {
      await ctx.runMutation(components.stripe.private.handleCustomerCreated, {
        stripeCustomerId: "cus_pro",
        metadata: { userId: "user_pro" },
      });
    });
    await attribute(t, { customerId: "cus_pro" });
    expect(await attributionOf(t, "user_pro")).toMatchObject({ affiliateId: jane });
    await attribute(t, { customerId: "cus_unknown" });
    expect(await t.run((ctx) => ctx.db.query("affiliateAttributions").collect())).toHaveLength(1);
  });

  test("money off with no discounts listed is read back from Stripe once", async () => {
    const t = harness();
    const jane = await janeWithCode(t);
    stripe.sessionRetrieve.mockResolvedValue({
      id: "cs_live",
      total_details: {
        breakdown: { discounts: [{ amount: 300, discount: { promotion_code: "promo_jane" } }] },
      },
    });
    await attribute(t, { ownerId: "user_buyer", promotionCodeIds: [], lookup: true });
    expect(stripe.sessionRetrieve).toHaveBeenCalledExactlyOnceWith("cs_live", {
      expand: ["total_details.breakdown"],
    });
    expect(await attributionOf(t, "user_buyer")).toMatchObject({ affiliateId: jane });
  });

  test("the code-attributed buyer shows up in the stats as via code", async () => {
    const t = harness();
    await janeWithCode(t);
    await attribute(t, { ownerId: "user_buyer" });
    stripe.promotionRetrieve.mockResolvedValue({ times_redeemed: 1 });
    const stats = await t.action(api.adminBilling.affiliateStats, { token: TOKEN });
    expect(stats.rows[0]).toMatchObject({ signups: 1, viaCode: 1, viaLink: 0, promotionRedemptions: 1 });
    expect((await t.query(api.adminBilling.affiliateList, { token: TOKEN }))[0].signups).toBe(1);
  });
});

describe("the Stripe webhook", () => {
  function fakeCtx(fail?: string) {
    const calls: { kind: "action" | "mutation"; name: string; args: unknown }[] = [];
    const ctx = {
      runAction: vi.fn(async (ref: never, args: unknown) => {
        const name = getFunctionName(ref);
        calls.push({ kind: "action", name, args });
        if (name === fail) throw new Error("boom");
        return null;
      }),
      runMutation: vi.fn(async (ref: never, args: unknown) => {
        const name = getFunctionName(ref);
        calls.push({ kind: "mutation", name, args });
        if (name === fail) throw new Error("boom");
        return null;
      }),
    };
    return { ctx: ctx as unknown as Parameters<typeof onStripeEvent>[0], calls };
  }
  const event = (e: ReturnType<typeof completed>) => e as unknown as Parameters<typeof onStripeEvent>[1];

  test("a checkout with nothing off does exactly what it did before, and asks Stripe nothing", async () => {
    const personal = fakeCtx();
    await onStripeEvent(personal.ctx, event(completed({ metadata: { userId: "user_me" } })));
    expect(personal.calls).toEqual([
      { kind: "mutation", name: "billing:mirrorSubscription", args: { userId: "user_me" } },
    ]);

    const team = fakeCtx();
    await onStripeEvent(team.ctx, event(completed({ metadata: { orgId: "ws_1" }, customer: "cus_ws" })));
    expect(team.calls).toEqual([
      { kind: "action", name: "teamBilling:mirror", args: { orgId: "ws_1", customerId: "cus_ws" } },
    ]);

    const neither = fakeCtx();
    await onStripeEvent(neither.ctx, event(completed({})));
    expect(neither.calls).toEqual([]);
    expect(stripe.sessionRetrieve).not.toHaveBeenCalled();
    expect(stripe.promotionRetrieve).not.toHaveBeenCalled();
  });

  test("a Team checkout that took a code records its buyer and is attributed, then mirrored as before", async () => {
    const { ctx, calls } = fakeCtx();
    await onStripeEvent(
      ctx,
      event(
        completed({
          metadata: { orgId: "ws_1" },
          customer: "cus_ws",
          client_reference_id: "user_boss",
          discounts: [{ coupon: "co", promotion_code: "promo_jane" }],
          total_details: { amount_discount: 500 },
        }),
      ),
    );
    expect(calls).toEqual([
      { kind: "mutation", name: "teamBilling:recordBuyer", args: { orgId: "ws_1", buyerId: "user_boss" } },
      {
        kind: "action",
        name: "billing:attributeCheckout",
        args: {
          sessionId: "cs_live",
          promotionCodeIds: ["promo_jane"],
          lookup: false,
          ownerId: "user_boss",
          orgId: "ws_1",
          customerId: "cus_ws",
          at: Math.floor(NOW / 1000) * 1000,
        },
      },
      { kind: "action", name: "teamBilling:mirror", args: { orgId: "ws_1", customerId: "cus_ws" } },
    ]);
  });

  test("an attribution that fails never fails the delivery or the mirror", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, calls } = fakeCtx("billing:attributeCheckout");
    await expect(
      onStripeEvent(
        ctx,
        event(
          completed({
            metadata: { userId: "user_me" },
            discounts: [{ coupon: "co", promotion_code: "promo_jane" }],
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.name)).toEqual(["billing:attributeCheckout", "billing:mirrorSubscription"]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/cs_live: code not attributed/), expect.any(Error));
  });

  test("a Team checkout with nothing off still records who bought it", async () => {
    const { ctx, calls } = fakeCtx();
    await onStripeEvent(
      ctx,
      event(completed({ metadata: { orgId: "ws_1" }, customer: "cus_ws", client_reference_id: "user_boss" })),
    );
    expect(calls.map((c) => c.name)).toEqual(["teamBilling:recordBuyer", "teamBilling:mirror"]);
    // Only a completed checkout names a buyer.
    const other = fakeCtx();
    await onStripeEvent(
      other.ctx,
      event({ ...completed({ metadata: { orgId: "ws_1" }, customer: "cus_ws", client_reference_id: "user_boss" }), type: "checkout.session.expired" }),
    );
    expect(other.calls.map((c) => c.name)).toEqual(["teamBilling:mirror"]);
  });

  test("a buyer that cannot be recorded still lets the code be attributed", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, calls } = fakeCtx("teamBilling:recordBuyer");
    await onStripeEvent(
      ctx,
      event(
        completed({
          metadata: { orgId: "ws_1" },
          customer: "cus_ws",
          client_reference_id: "user_boss",
          discounts: [{ coupon: "co", promotion_code: "promo_jane" }],
        }),
      ),
    );
    expect(calls.map((c) => c.name)).toEqual([
      "teamBilling:recordBuyer",
      "billing:attributeCheckout",
      "teamBilling:mirror",
    ]);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/cs_live: buyer not recorded/), expect.any(Error));
  });

  test("the code path end to end: a real attribution from the event's own fields", async () => {
    const t = harness();
    await admin(t);
    const jane = await create(t, { slug: "jane" });
    await linkCode(t, jane, "promo_jane", "JANE10");
    const discount = checkoutDiscountOf(
      completed({
        client_reference_id: "user_fresh",
        discounts: [{ coupon: "co", promotion_code: "promo_jane" }],
        total_details: { amount_discount: 500 },
      }),
    )!;
    await t.action(internal.billing.attributeCheckout, discount);
    expect(await attributionOf(t, "user_fresh")).toMatchObject({ affiliateId: jane, via: "code" });
  });
});
