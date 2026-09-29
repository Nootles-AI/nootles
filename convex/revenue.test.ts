/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

/**
 * `revenue` as ops reads it: who pays, what each pays a month, and the total.
 * Stripe's prices are replaced; what is checked is the report built from them,
 * to the byte, so the price lookup it shares with the affiliate stats cannot
 * quietly change it.
 */

const stripe = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock("stripe", () => ({
  default: class {
    prices = { retrieve: stripe.retrieve };
  },
}));

const modules = import.meta.glob("./**/*.ts");

const NOW = Date.UTC(2026, 8, 28, 12);
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "admin-token";

const PRICES: Record<string, { unit_amount: number | null; currency: string }> = {
  price_monthly: { unit_amount: 1200, currency: "usd" },
  price_annual: { unit_amount: 9900, currency: "usd" },
  price_metered: { unit_amount: null, currency: "usd" },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_revenue");
  stripe.retrieve.mockImplementation(async (id: string) => {
    const price = PRICES[id];
    if (!price) throw new Error(`No such price: '${id}'`);
    return { id, ...price };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

type Sub = { priceId: string; interval: "month" | "year"; status?: string };

async function world() {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("adminSessions", { token: TOKEN, createdAt: 1, expiresAt: NOW + DAY });
    const person = async (ownerId: string, email: string, sub?: Sub, extra = {}) => {
      await ctx.db.insert("profiles", { ownerId, email, name: email, status: "done", createdAt: 1 });
      await ctx.db.insert("billingAccounts", {
        ownerId,
        acceptedCompletions: 0,
        chatConversations: 0,
        createdAt: 1,
        ...extra,
        ...(sub
          ? {
              subscription: {
                status: sub.status ?? "active",
                interval: sub.interval,
                currentPeriodEnd: Math.floor((NOW + 20 * DAY) / 1000),
                cancelAtPeriodEnd: false,
                priceId: sub.priceId,
                subscriptionId: `sub_${ownerId}`,
                updatedAt: 1,
              },
            }
          : {}),
      });
    };
    await person("user_monthly", "m@test", { priceId: "price_monthly", interval: "month" });
    await person("user_annual", "a@test", { priceId: "price_annual", interval: "year" });
    await person("user_gone", "g@test", { priceId: "price_retired", interval: "month" });
    await person("user_metered", "x@test", { priceId: "price_metered", interval: "month" });
    await person("user_lapsed", "l@test", {
      priceId: "price_monthly",
      interval: "month",
      status: "canceled",
    });
    await person("user_vip", "v@test", { priceId: "price_monthly", interval: "month" }, { vip: true });
    await person("user_free", "f@test");
  });
  return t;
}

describe("revenue", () => {
  test("reports each paying customer's monthly amount, the total, and the unpriced", async () => {
    const t = await world();
    const report = await t.action(api.adminBilling.revenue, { token: TOKEN });

    const periodEnd = Math.floor((NOW + 20 * DAY) / 1000) * 1000;
    const row = (ownerId: string, email: string, interval: string, amount: number | null, monthly: number | null) => ({
      ownerId,
      email,
      name: email,
      interval,
      status: "active",
      cancelAtPeriodEnd: false,
      currentPeriodEnd: periodEnd,
      amount,
      currency: amount === null ? null : "usd",
      monthly,
    });
    expect(report).toEqual({
      paying: [
        row("user_monthly", "m@test", "month", 1200, 1200),
        row("user_annual", "a@test", "year", 9900, 825),
        row("user_gone", "g@test", "month", null, null),
        row("user_metered", "x@test", "month", null, null),
      ],
      mrr: 2025,
      currency: "usd",
      unpriced: 2,
    });
    // To the byte, as captured before the price lookup was shared.
    expect(JSON.stringify(report)).toBe(
      '{"currency":"usd","mrr":2025,"paying":[' +
        '{"amount":1200,"cancelAtPeriodEnd":false,"currency":"usd","currentPeriodEnd":1792324800000,"email":"m@test","interval":"month","monthly":1200,"name":"m@test","ownerId":"user_monthly","status":"active"},' +
        '{"amount":9900,"cancelAtPeriodEnd":false,"currency":"usd","currentPeriodEnd":1792324800000,"email":"a@test","interval":"year","monthly":825,"name":"a@test","ownerId":"user_annual","status":"active"},' +
        '{"amount":null,"cancelAtPeriodEnd":false,"currency":null,"currentPeriodEnd":1792324800000,"email":"g@test","interval":"month","monthly":null,"name":"g@test","ownerId":"user_gone","status":"active"},' +
        '{"amount":null,"cancelAtPeriodEnd":false,"currency":null,"currentPeriodEnd":1792324800000,"email":"x@test","interval":"month","monthly":null,"name":"x@test","ownerId":"user_metered","status":"active"}' +
        '],"unpriced":2}',
    );
    // Once per distinct price on a subscription, the VIP's and the lapsed one's included.
    expect(stripe.retrieve.mock.calls.map(([id]) => id).sort()).toEqual([
      "price_annual",
      "price_metered",
      "price_monthly",
      "price_retired",
    ]);
  });

  test("with nobody on a subscription, Stripe is never asked", async () => {
    const t = convexTest(schema, modules);
    await t.run((ctx) =>
      ctx.db.insert("adminSessions", { token: TOKEN, createdAt: 1, expiresAt: NOW + DAY }),
    );
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(await t.action(api.adminBilling.revenue, { token: TOKEN })).toEqual({
      paying: [],
      mrr: 0,
      currency: null,
      unpriced: 0,
    });
    expect(stripe.retrieve).not.toHaveBeenCalled();
  });

  test("refuses a token that is not an admin session, or has expired", async () => {
    const t = await world();
    await expect(t.action(api.adminBilling.revenue, { token: "nope" })).rejects.toThrow(
      "Not authorized",
    );
    vi.setSystemTime(NOW + 2 * DAY);
    await expect(t.action(api.adminBilling.revenue, { token: TOKEN })).rejects.toThrow(
      "Not authorized",
    );
  });
});
