import { ConvexError, v } from "convex/values";
import StripeSDK from "stripe";
import { StripeSubscriptions } from "@convex-dev/stripe";
import { api, components, internal } from "./_generated/api";
import { action, internalMutation, query } from "./_generated/server";
import { ensureAccount, isLiveStatus, type Entitlement } from "./entitlements";
import { isTeamPrice, teamBillingConfigured, teamPrices } from "./teamBilling";

/**
 * Paying, and stopping paying.
 *
 * Stripe holds the money and the component holds a synced copy of what Stripe
 * says; neither decides what anyone may DO. That is `entitlements.ts`, for
 * which a subscription is one of four inputs and the last that can say yes.
 * Keeping it that way is what makes an operator's VIP flag outrank a lapsed
 * card, and what would make swapping Stripe for a merchant of record a change
 * to this file and nothing else.
 *
 * Prices live in the Stripe dashboard, named here only by env var, so what
 * Nootles costs can change without a deploy.
 */

const stripe = new StripeSubscriptions(components.stripe);

export type Interval = "month" | "year";

/** Which Stripe price each interval buys. Set on the deployment, not in code. */
function priceFor(interval: Interval): string {
  const id =
    interval === "year"
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;
  if (!id) {
    throw new ConvexError(
      `No Stripe price is configured for the ${interval}ly plan.`,
    );
  }
  return id;
}

/**
 * Where Stripe sends people back to. Server-side deliberately: a return URL
 * the client chose is an open redirect standing in the middle of a payment.
 */
function appUrl(): string {
  const url = process.env.APP_URL;
  if (!url) throw new ConvexError("APP_URL is not set on this deployment.");
  return url.replace(/\/$/, "");
}

const price = v.object({
  /** In the currency's smallest unit, as Stripe reports it. */
  amount: v.number(),
  currency: v.string(),
});

/**
 * What the two plans cost, read from Stripe rather than held anywhere here.
 *
 * A price written into the app is a second place to change it and a second
 * place to get it wrong — and the one that is wrong is always the one the
 * customer read before being charged the other. So the plan screen asks Stripe,
 * which is also the thing that will do the charging.
 */
export const prices = action({
  args: {},
  returns: v.object({
    month: v.union(price, v.null()),
    year: v.union(price, v.null()),
  }),
  handler: async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) return { month: null, year: null };
    const stripeSdk = new StripeSDK(key);
    const read = async (id: string | undefined) => {
      if (!id) return null;
      const found = await stripeSdk.prices.retrieve(id);
      return found.unit_amount === null
        ? null
        : { amount: found.unit_amount, currency: found.currency };
    };
    return {
      month: await read(process.env.STRIPE_PRICE_MONTHLY),
      year: await read(process.env.STRIPE_PRICE_ANNUAL),
    };
  },
});

/**
 * What a Team seat costs, read from Stripe as {@link prices} reads the
 * personal plans: the admin reads the number before checkout does.
 */
export const teamSeatPrice = action({
  args: {},
  returns: v.union(price, v.null()),
  handler: async () => {
    const key = process.env.STRIPE_SECRET_KEY;
    const id = teamPrices()?.seat;
    if (!key || !id) return null;
    const found = await new StripeSDK(key).prices.retrieve(id);
    return found.unit_amount === null
      ? null
      : { amount: found.unit_amount, currency: found.currency };
  },
});

/**
 * Opens checkout. Returns the URL to send the browser to.
 *
 * `allow_promotion_codes` is what makes discount codes work at all — the field
 * where one is typed is Stripe's, on its own checkout page, and the codes
 * themselves are Stripe promotion codes. Nootles' own `accessCodes` are a
 * different thing entirely: those grant access for nothing, which is not a
 * discount and never reaches this flow.
 */
export const startCheckout = action({
  args: { interval: v.union(v.literal("month"), v.literal("year")) },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not signed in");
    // An operator standing in for someone must not be able to buy anything in
    // their name. The claim is the same one `auth.ts` refuses writes on.
    if (typeof identity.act === "string") {
      throw new ConvexError("Read-only: this session is an operator standing in for you.");
    }

    let { customerId } = await stripe.getOrCreateCustomer(ctx, {
      userId: identity.subject,
      email: identity.email,
      name: identity.name,
    });
    // `getOrCreateCustomer` falls back to a match by email, and a workspace's
    // customer can carry the address of whoever bought its Team plan. Their
    // own plan is never the workspace's to pay.
    if (
      await ctx.runQuery(internal.teamBilling.isWorkspaceCustomer, {
        stripeCustomerId: customerId,
      })
    ) {
      ({ customerId } = await stripe.createCustomer(ctx, {
        email: identity.email,
        name: identity.name,
        metadata: { userId: identity.subject },
        idempotencyKey: identity.subject,
      }));
    }
    await ctx.runMutation(internal.billing.rememberCustomer, {
      userId: identity.subject,
      stripeCustomerId: customerId,
    });

    const session = await stripe.createCheckoutSession(ctx, {
      priceId: priceFor(args.interval),
      customerId,
      mode: "subscription",
      successUrl: `${appUrl()}/upgrade?checkout=done`,
      cancelUrl: `${appUrl()}/upgrade?checkout=cancelled`,
      // How the webhook knows whose subscription this is — the component reads
      // the same field to link its own rows.
      subscriptionMetadata: { userId: identity.subject },
      params: { allow_promotion_codes: true },
    });
    if (!session.url) throw new ConvexError("Stripe returned no checkout URL.");
    return { url: session.url };
  },
});

/**
 * Stripe's own billing portal — change card, change plan, cancel, get invoices.
 *
 * Deliberately not rebuilt in Nootles: every one of those screens is a place to
 * get somebody's money wrong, and Stripe's are already legally and locally
 * correct in every country it sells in.
 */
export const manage = action({
  args: {},
  returns: v.object({ url: v.string() }),
  handler: async (ctx): Promise<{ url: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Not signed in");

    const customer = await ctx.runQuery(
      components.stripe.public.getCustomerByUserId,
      { userId: identity.subject },
    );
    if (!customer) throw new ConvexError("There is no billing to manage yet.");

    const session = await stripe.createCustomerPortalSession(ctx, {
      customerId: customer.stripeCustomerId,
      returnUrl: `${appUrl()}/upgrade`,
    });
    return { url: session.url };
  },
});

/**
 * Opens checkout for a workspace's Team plan. Returns the URL to send the
 * browser to. An owner's or admin's to press, never a stand-in's
 * (`teamBilling.desk`).
 *
 * The workspace gets a Stripe customer of its own the first time, made with
 * `metadata.orgId` under an idempotency key per workspace — never
 * `getOrCreateCustomer`, which matches by email and would hand back the
 * buyer's own. Made with no email for the same reason: Checkout asks for the
 * address the invoices go to. The subscription carries the workspace too, and
 * no `userId`, so the personal mirror never mistakes it for anyone's Pro.
 *
 * Two line items: the seats, at the count of paid seats right now, and the
 * metered usage, which has no quantity — its meter says what it bills.
 */
export const startTeamCheckout = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const prices = teamPrices();
    if (!prices || !teamBillingConfigured()) {
      throw new ConvexError("The Team plan isn’t available yet.");
    }
    const desk = await ctx.runQuery(internal.teamBilling.desk, args);
    if (desk.live) throw new ConvexError(`${desk.name} is already on the Team plan.`);
    // Stripe still bills an unpaid or paused subscription's seats; a second
    // one beside it would bill them twice.
    if (desk.open) {
      throw new ConvexError(
        `${desk.name} already has a subscription in Stripe that needs attention. Fix it in Manage billing.`,
      );
    }

    const orgId = args.workspaceId;
    let customerId = desk.customerId;
    if (!customerId) {
      const created = await stripe.createCustomer(ctx, {
        name: desk.name,
        metadata: { orgId },
        idempotencyKey: `workspace_${orgId}`,
      });
      customerId = await ctx.runMutation(internal.teamBilling.rememberCustomer, {
        workspaceId: args.workspaceId,
        stripeCustomerId: created.customerId,
      });
    }

    const back = `${appUrl()}/w/${desk.slug}/settings/billing`;
    const session = await stripe.createCheckoutSession(ctx, {
      priceId: prices.seat,
      customerId,
      mode: "subscription",
      successUrl: `${back}?checkout=done`,
      cancelUrl: `${back}?checkout=cancelled`,
      metadata: { orgId },
      subscriptionMetadata: { orgId },
      params: {
        line_items: [{ price: prices.seat, quantity: desk.seats }, { price: prices.usage }],
        allow_promotion_codes: true,
      },
    });
    if (!session.url) throw new ConvexError("Couldn’t open checkout. Try again in a moment.");
    return { url: session.url };
  },
});

/** Stripe's billing portal for a workspace's customer — {@link manage}, for Team. */
export const manageTeam = action({
  args: { workspaceId: v.id("workspaces") },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, args): Promise<{ url: string }> => {
    const desk = await ctx.runQuery(internal.teamBilling.desk, args);
    if (!desk.customerId) throw new ConvexError("Nothing has been billed yet, so there’s nothing to manage.");
    const session = await stripe.createCustomerPortalSession(ctx, {
      customerId: desk.customerId,
      returnUrl: `${appUrl()}/w/${desk.slug}/settings/billing`,
    });
    return { url: session.url };
  },
});

/**
 * Re-reads one account's subscription from the component and writes it onto
 * `billingAccounts`, which is where `entitlementOf` looks.
 *
 * Called by the webhook for every event that names a user. Idempotent by
 * construction — it derives the whole field from the component's current rows
 * rather than applying a delta — so Stripe replaying an event is harmless and
 * a retry after a failure is the repair.
 */
export const mirrorSubscription = internalMutation({
  args: { userId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // A workspace's subscription is never a person's, whoever bought it: it
    // names its workspace, and it is on Team's prices. Filtered by what Team
    // is rather than by what Pro is, so someone left on a Pro price since
    // retired keeps what they pay for.
    const rows = (
      await ctx.runQuery(components.stripe.public.listSubscriptionsByUserId, {
        userId: args.userId,
      })
    ).filter((row) => !row.orgId && !isTeamPrice(row.priceId));
    // The one that decides the answer. An account that resubscribed after
    // cancelling has two rows, and the dead one must not be the one that speaks
    // — even when its period reaches further, as it does whenever an annual
    // plan ended early: Stripe leaves a subscription cancelled outright, or
    // ended by failed renewals, holding the period it died in. So any live row
    // outranks every dead one, and the furthest-reaching period end only
    // decides between rows that are alike in that.
    const best = rows.reduce<(typeof rows)[number] | null>((winner, row) => {
      if (!winner) return row;
      const live = isLiveStatus(row.status);
      if (live !== isLiveStatus(winner.status)) return live ? row : winner;
      return row.currentPeriodEnd > winner.currentPeriodEnd ? row : winner;
    }, null);

    const account = await ensureAccount(ctx, args.userId);
    await ctx.db.patch(account._id, {
      subscription: best
        ? {
            status: best.status,
            // Stripe reports the price's interval; ours only has two, and the
            // annual price is the only one that is not monthly.
            interval: best.priceId === process.env.STRIPE_PRICE_ANNUAL ? "year" : "month",
            currentPeriodEnd: best.currentPeriodEnd,
            cancelAtPeriodEnd: best.cancelAtPeriodEnd,
            priceId: best.priceId,
            subscriptionId: best.stripeSubscriptionId,
            updatedAt: Date.now(),
          }
        : undefined,
      stripeCustomerId: best?.stripeCustomerId ?? account.stripeCustomerId,
    });
    return null;
  },
});

/**
 * Written on the way OUT to Stripe, before anything is paid.
 *
 * Two facts, both recorded here because this is the last moment the deployment
 * sees somebody who is about to be asked for money: the customer id, so ops can
 * reach their billing even if they never finish, and the fact that they got as
 * far as looking at the price. An account with a checkout and no subscription
 * is the single most informative row on the billing dashboard.
 */
export const rememberCustomer = internalMutation({
  args: { userId: v.string(), stripeCustomerId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ensureAccount(ctx, args.userId);
    await ctx.db.patch(account._id, {
      stripeCustomerId: args.stripeCustomerId,
      checkoutAt: Date.now(),
      checkouts: (account.checkouts ?? 0) + 1,
    });
    return null;
  },
});

/**
 * What the plan screen needs beyond the entitlement itself: whether there is a
 * Stripe customer to send to the portal, and whether prices are configured at
 * all — an unconfigured deployment should say so rather than offer a button
 * that fails when pressed.
 */
export const plan = query({
  args: {},
  returns: v.object({
    entitlement: v.any(),
    manageable: v.boolean(),
    sellable: v.boolean(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    entitlement: Entitlement | null;
    manageable: boolean;
    sellable: boolean;
  }> => {
    const entitlement = await ctx.runQuery(api.entitlements.mine, {});
    const identity = await ctx.auth.getUserIdentity();
    const customer = identity
      ? await ctx.runQuery(components.stripe.public.getCustomerByUserId, {
          userId: identity.subject,
        })
      : null;
    return {
      entitlement,
      manageable: !!customer,
      sellable: !!process.env.STRIPE_PRICE_MONTHLY && !!process.env.APP_URL,
    };
  },
});
