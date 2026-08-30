# Turning the paywall on

## 0. Existing accounts

Run this once, either side of the deploy:

```
npx convex run migrations:grandfatherChatThreads '{}'
```

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

Prices live there and only there. Nothing in this repo hardcodes an amount;
`/upgrade` reads them through `billing.prices` so the number on the plan card
and the number on the invoice cannot disagree.

## 2. Deployment environment

Set on the **Convex** deployment (`npx convex env set NAME value`), not in
`.env.local` — these are read by Convex functions, not by Next.

| Name | What it is |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…`, then `sk_live_…` when you go live |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` from the webhook endpoint you create in step 3 |
| `STRIPE_PRICE_MONTHLY` | the monthly `price_…` |
| `STRIPE_PRICE_ANNUAL` | the yearly `price_…` |
| `APP_URL` | e.g. `https://nootles.app` — where Stripe returns people to |

`APP_URL` is server-side on purpose: a return URL the browser chose would be an
open redirect sitting in the middle of a payment.

## 3. The webhook

Point a Stripe webhook at `https://<your-deployment>.convex.site/stripe/webhook`
and subscribe it to the `customer.subscription.*` and `checkout.session.*`
events. `convex/http.ts` registers the route; the component verifies the
signature and syncs its own tables, and the handler beside it copies the result
onto `billingAccounts`, which is what `entitlements.ts` reads.

Locally: `stripe listen --forward-to <deployment>.convex.site/stripe/webhook`,
and use the `whsec_` it prints.

## 4. Going live

Swap the key and the price ids for their live-mode equivalents and create a
live webhook endpoint (test and live have separate signing secrets). One real
purchase, immediately refunded, is worth doing before you tell anyone.

## What is where

- **Free allowance** — `FREE_LIMITS` in `convex/entitlements.ts`. Change the
  numbers there; nothing else reads them.
- **Access codes** (free access, no money) — minted in ops → Billing, redeemed
  on `/upgrade`. Ours, not Stripe's: Stripe has no concept of a price of zero.
- **Discount codes** (money still moves, just less) — Stripe promotion codes,
  minted from ops → Billing, typed by the customer on Stripe's own checkout.
- **VIP** — ops → Users → the person → Plan. Outranks everything, including a
  lapsed card.
