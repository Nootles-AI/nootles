# Turning the paywall on

## 0. Existing accounts

Run this once, either side of the deploy:

```
npx convex run migrations:grandfatherChatThreads '{}' --prod
```

(`convex run` defaults to your dev deployment too — without `--prod` this
stamps the wrong database and your real users stay exposed to the charge.)

It stamps every conversation that already exists as paid for. Without it, the
first message somebody sends in a thread they have been using for weeks spends
one of their ten free slots — charging them, after the fact, for something that
was free when they did it. Idempotent; re-run with the returned `cursor` until
`done` is true.

Nothing else needs backfilling. The completion counter starts at zero for
everybody, so no one arrives already over that limit. Projects ARE counted live,
so an account with five projects is at the projects wall immediately: they keep
and can edit all five, and only *creating a sixth* is refused. If you would
rather early accounts kept making projects, comp them — ops → Users → Plan →
Mark VIP, or mint a code and send it round.


The code ships inert. Until the environment below is set, `/upgrade` says Pro
is not on sale from this deployment and access codes still work — which is the
right posture for a deployment that has no Stripe account attached.

## 1. Stripe, in test mode first

In the Stripe dashboard (test mode), make one **product** — "Nootles Pro" —
with two **prices** against it: one recurring monthly, one recurring yearly.
Copy both price ids (`price_…`).

Prices live there and only there. Nothing in this repo hardcodes an amount —
the two env vars below hold Stripe's opaque `price_…` IDs, and the amount is a
property of the object each one names. `/upgrade` reads them through
`billing.prices`, so the number on the plan card and the number on the invoice
cannot disagree, and changing what you charge is a Stripe edit rather than a
deploy.

## 2. Deployment environment

Set on the **Convex** deployment, not in `.env.local` — these are read by
Convex functions, not by Next.

```
npx convex env set --prod STRIPE_SECRET_KEY sk_test_…
```

`--prod` is not optional. `convex env set` writes to your **dev** deployment by
default, which is not the one the live site talks to — the variables would look
set and `/upgrade` would still say Pro is not on sale. (`convex deploy` defaults
the other way, to production, which is why only this one needs the flag.)

| Name | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…`, then `sk_live_…` when you go live |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint you create in step 3 |
| `STRIPE_PRICE_MONTHLY` | the monthly price's API ID, `price_1Qx…` — a handle, not an amount |
| `STRIPE_PRICE_ANNUAL` | the yearly price's API ID |
| `APP_URL` | `https://app.nootles.com` — where Stripe returns people to |

Confirm with `npx convex env list --prod --names-only`.

`APP_URL` is server-side on purpose: a return URL the browser chose would be an
open redirect sitting in the middle of a payment.

## 3. The webhook

Point a Stripe webhook at
`https://brilliant-buffalo-463.convex.site/stripe/webhook` (production) and
subscribe it to the `customer.subscription.*` and `checkout.session.*` events.
Note `.convex.site`, not `.convex.cloud` — only the `.site` host serves HTTP
endpoints, and a webhook aimed at the other one fails silently. `convex/http.ts` registers the route; the component verifies the
signature and syncs its own tables, and the handler beside it copies the result
onto `billingAccounts`, which is what `entitlements.ts` reads.

Locally: `stripe listen --forward-to quick-cobra-443.convex.site/stripe/webhook`,
and use the `whsec_` it prints — set that one WITHOUT `--prod`, alongside an
`APP_URL` of `http://localhost:3000`.

## 4. Going live

Swap the key and the price ids for their live-mode equivalents and create a
live webhook endpoint (test and live have separate signing secrets). One real
purchase, immediately refunded, is worth doing before you tell anyone.

## 5. Workspaces: the Team plan

A workspace is on its own plan, never a member's. It has Team — unmetered AI,
the audit log — while its subscription is live or an operator has granted it,
and otherwise it is on the free allowance: the same `FREE_LIMITS`, counted once
for the whole workspace. The plan matrix is `PLANS` in `convex/plans.ts`; the
resolver is `workspaceStanding` in `convex/entitlements.ts`.

**Workspaces that exist before this ships** were unlimited, and would drop to
the free allowance on deploy. Keep them on Team, once, right after deploying:

```
npx convex run migrations:grandfatherWorkspaces '{"note":"Made before Team billing"}' --prod
```

Idempotent; re-run with the returned `cursor` until `done` is true.

**An internal tester's workspace**, or one promised something without a card,
gets an override — from ops (`adminBilling.workspaceOverrideSet`), or from
here by its address:

```
npx convex run adminBilling:grantWorkspaceOverride \
  '{"slug":"acme","feature":"plan","value":"team","note":"Internal tester"}' --prod
```

`feature` is `plan` (a plan's name) or a key of `Features` — `unmetered`,
`auditLog`, `guestDailyAiUsd` (dollars a guest may spend of the workspace's AI
in a UTC day; 1 by default, 0 for none). Add `"expiresAt": <ms>` for one that
lapses. A plan override outranks the subscription, so clear it
(`adminBilling.workspaceOverrideClear`) once the workspace pays.

## 6. The AI ledger's secret

Usage is billed from `aiCalls`, whose writer anyone signed in can call. Only
rows the Next server signed count toward a bill or a guest's cap; the rest are
kept, unsigned. Set the same secret on **both** sides:

```
openssl rand -hex 32
npx convex env set --prod AI_LEDGER_SECRET <it>
```

and `AI_LEDGER_SECRET=<it>` in the Next deployment's environment (Vercel).
Without it on either side every row is unsigned — nothing breaks, and nothing
is billed. With two different values every row is refused, and the Convex logs
say "That ledger row’s signature doesn’t hold": fix the pair before switching
usage billing on.

## 7. Team billing in Stripe

A workspace on Team pays for two things on one monthly subscription: a
**seat** for every owner, admin and member (guests are free), and **AI usage**
past what its seats include — `TEAM_AI_ALLOWANCE_USD` per seat per period,
billed in cents through a Stripe Billing Meter. The code is
`convex/teamBilling.ts`, plus `billing.startTeamCheckout` and
`billing.manageTeam`.

### One-time setup, in test mode first

1. **The meter.** Billing → Meters → Create meter. Event name
   `nootles_team_ai_cents` (any name; it goes in `STRIPE_TEAM_METER_EVENT`),
   aggregation **Sum**, and leave the payload keys at their defaults:
   `stripe_customer_id` for the customer, `value` for the amount. One unit is
   one cent of overage.
2. **The product and its two prices.** Make a product, "Nootles Team", with:
   - a **seat** price: recurring, monthly, per unit — what one seat costs;
   - a **usage** price: recurring, monthly, usage-based, on the meter from
     step 1, at **$0.01 per unit**.

   Same currency and interval for both: they are two items on one
   subscription.
3. **The customer portal** (Settings → Billing → Customer portal). Let
   customers update payment methods, see invoices and cancel. Do **not** let
   them change quantities or switch plans on Nootles Team: seats follow the
   members list, and a quantity changed in the portal is put back by the next
   sync.
4. **The webhook** from section 3 already covers it. A workspace's events
   carry `metadata.orgId` and go to `teamBilling.mirror`; a person's carry
   `userId` and go to `billing.mirrorSubscription`, as before.

### Environment

On the **Convex** deployment, `--prod` as in section 2:

| Name | What it is |
|---|---|
| `STRIPE_PRICE_TEAM_SEAT` | the seat price's API ID, `price_…` |
| `STRIPE_PRICE_TEAM_USAGE` | the usage price's API ID |
| `STRIPE_TEAM_METER_EVENT` | the meter's event name, e.g. `nootles_team_ai_cents` |
| `TEAM_AI_ALLOWANCE_USD` | dollars of AI each seat includes per period; optional, 10 if unset |
| `AI_LEDGER_SECRET` | section 6 — on Convex **and** Next. Usage is billed from signed ledger rows only, so without it Team bills seats and never usage |

`APP_URL` and `STRIPE_SECRET_KEY` are shared with personal billing. Until the
two prices, the meter event and `APP_URL` are all set, a workspace's billing
screen says Team billing isn't set up on this deployment and checkout refuses.

### How it runs

- **Checkout** makes the workspace a Stripe customer of its own
  (`metadata.orgId`, no email — the component matches a person's customer by
  email, and must never find this one), then a subscription carrying
  `metadata.orgId` with both items: seats at the current count, and usage.
- **The mirror** re-reads the customer's subscriptions from Stripe on every
  workspace event and finds the two items by price, into `workspaceBilling`.
  A person's mirror ignores any subscription that names a workspace or is on
  a Team price, so paying for a workspace never makes its buyer Pro.
- **Seats**: joining, leaving, removal and role changes schedule a sync a
  minute later — one for a burst of changes — which sets the seat item's
  quantity, prorated. Deleting a workspace sets its subscription to end with
  the period already paid for.
- **Usage**: every night at 07:00 UTC (`crons.ts`) each live Team workspace's
  signed AI spend since the last report is added up, and what the period owes
  past its allowance goes to the meter as one event, in whole cents. Its
  identifier, `<workspace>:<periodStart>:<through>`, is fixed before sending,
  so a send that fails is retried as the same event rather than a second
  charge. The same run re-syncs any seat count Stripe was not told.
- Spend in the hours before a renewal is reported the night after it, onto the
  new period's invoice, counted against the old period's allowance. Spend in
  the last day of a subscription that ends is not billed.

To check it end to end in test mode: buy Team with a test card from a
workspace's billing screen, confirm its `workspaceBilling` row has a
`seatItemId` and a `usageItemId`, add a member and watch the seat quantity
change in the dashboard a minute later.

## What is where

- **Free allowance** — `FREE_LIMITS` in `convex/entitlements.ts`. Change the
  numbers there; nothing else reads them.
- **Access codes** (free access, no money) — minted in ops → Billing, redeemed
  on `/upgrade`. Ours, not Stripe's: Stripe has no concept of a price of zero.
- **Discount codes** (money still moves, just less) — Stripe promotion codes,
  minted from ops → Billing, typed by the customer on Stripe's own checkout.
- **VIP** — ops → Users → the person → Plan. Outranks everything, including a
  lapsed card.
- **Workspace plans** — `PLANS` in `convex/plans.ts`, and one workspace's
  exceptions in `workspaceEntitlements` (section 5).
- **Team subscriptions, seats and usage** — `convex/teamBilling.ts`, mirrored
  into `workspaceBilling` (section 7).
