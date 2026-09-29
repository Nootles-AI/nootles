# Affiliate links — implementation plan

Status: **in progress, NT-119** (2026-09-28). The backend core — schema, `recordClick`,
`attribute`, `attributeByCode`, `convex/affiliateRules.ts` — is the first PR; admin functions
and checkout, the `/r` route, ops and the privacy copy follow. Defaults below may still change.

## Operator decisions (2026-09-28)

These replace the plan text below where the two disagree.

1. **New-account rule.** An account is attributed when its earliest server-side trace — the
   `_creationTime` of its first `identities`, `profiles`, `billingAccounts`, `codeRedemptions`
   or owned `projects` row — is no earlier than `NEW_ACCOUNT_TOLERANCE_MS` (10 minutes) before
   the visitor's first recorded click for that affiliate (`affiliateVisits.firstAt`), or when
   it has no trace at all. Someone who arrives through a share link still counts, though
   `share.claim` writes their profile before the claim effect runs. The click's time always
   comes from the `affiliateVisits` row, never from the cookie.
2. **Full phase 2.** Each affiliate may carry a Stripe promotion code; ops shows its
   `times_redeemed`, and a buyer whose completed checkout used that code is attributed
   `via: "code"` (`affiliates.attributeByCode`) — only when not already attributed and first
   seen no more than 30 days before the checkout. A link attribution always wins.
3. **Secrets split.** `AFFILIATE_CLICK_SECRET` is generated once and set on Convex (dev and
   prod) by the coordinator; the operator sets the same value on Vercel (preview and
   production). Unset on Convex, clicks still redirect and are not counted.

Influencers promote Nootles with a personal link. We track what each link produces, from
click to paying customer. Payouts and affiliate billing are out of scope: this is
measurement only.

## What is tracked, per affiliate

Clicks, unique visitors, signups, onboarded accounts, paywall hits, checkouts reached,
paying customers, and their attributed MRR — plus the conversion rate between each step.

## Where it lives

Convex is the source of truth and the ops console is where it is read, beside the existing
paywall funnel and revenue (`adminBilling.ts`, ops `/billing`). PostHog only receives a tag
so product funnels can be sliced by affiliate. `nootles-site` stays static: no code change.

## Defaults

| Decision | Default |
|---|---|
| Attribution window | 30 days, last click wins |
| Link destination | The marketing site (configurable per affiliate: an audience page or sign-in) |
| Who can be attributed | New accounts only — never re-attribute an existing user |
| Team subscriptions | An attributed person's Team purchase counts, reported in its own column |

## The link

`https://app.nootles.com/r/<slug>`

1. `app/r/[slug]/route.ts`, a public route (added to `isPublic` in `proxy.ts`):
   - reads or mints a visitor id;
   - records the click in Convex;
   - sets a first-party cookie `nt_ref = slug.visitorId.clickedAt` (Secure, SameSite=Lax,
     30-day max-age);
   - redirects to the affiliate's destination.

   The cookie lives on `app.nootles.com`, so it is still there when the visitor reaches the
   app through the site's CTA.
2. Click recording must not be an open mutation anyone can inflate. The route signs the
   call with a new `AFFILIATE_CLICK_SECRET`, following the `AI_LEDGER_SECRET` pattern
   (`convex/ai/callSignature.ts`), and Convex verifies it. An unknown or disabled slug still
   redirects to the default destination and records nothing.

## Data model (`convex/schema.ts`)

| Table | Fields | Purpose |
|---|---|---|
| `affiliates` | `slug` (unique, normalized like `normalizeCode`), `name`, `note`, `destination`, `ownerId?`, `promotionCodeId?`, `createdAt`, `disabledAt?` | One per influencer. Disabling stops new attribution and keeps history. |
| `affiliateVisits` | `affiliateId`, `visitorId`, `firstAt`, `lastAt`, `clicks` | One per visitor per affiliate: clicks and uniques. |
| `affiliateDays` | `affiliateId`, `day`, `clicks`, `visitors` | Daily rollup for charts, so stats never scan visits. `visitors` counts distinct visitors that UTC day, so days do not sum to the link's uniques (the count of `affiliateVisits` rows). |
| `affiliateAttributions` | `ownerId` (unique), `affiliateId`, `visitorId`, `clickedAt`, `attributedAt`, `via: "link" \| "code"` | One affiliate per account, written once. |

Later milestones — onboarded, paywall, checkout, paying, MRR — are **derived at read time**
from `profiles`, `billingAccounts` and the `revenue` price lookup, not copied onto the
attribution row, so they cannot drift from billing (the same reasoning as `billingRoster`).

## Attribution (`convex/affiliates.ts`)

`affiliates.attribute({ ref })`, idempotent:

- Called from a small client effect near `ConvexClientProvider` whenever an `nt_ref` cookie
  exists; the cookie is cleared afterwards. Not in `FirstRun`, because someone who arrives
  through a share link may never see the welcome screen.
- Attributes only a **new** account — see operator decision 1 above (this replaced "no
  `profiles` row and no `billingAccounts` row yet", which a share-link arrival fails).
- Last click within the window wins; expired or disabled links are ignored.
- Refused for operator stand-ins (`act` claim — the existing write gates) and for
  self-referral (`affiliates.ownerId`).

Also:

- `billing.startCheckout` and `startTeamCheckout` add `affiliate: slug` to
  `subscriptionMetadata`, so Stripe's dashboard shows it too.
- PostHog: `$set_once: { affiliate }` on the person. No new taxonomy event.

**Phase 2 (decided in, see decision 2):** `affiliates.promotionCodeId` links a Stripe promotion code made with
the existing `discountCreate`; ops shows its `times_redeemed` beside the link stats.
Attributing code-only arrivals (`via: "code"`) needs the checkout session's discounts read
back, and is worth building only if influencers mostly share codes rather than links.

## Ops

Admin functions go in `adminBilling.ts` under an "Affiliates" section, so the ops contract
files stay the same three:

- `affiliateList`, `affiliateCreate`, `affiliateUpdate`, `affiliateSetDisabled`
- `affiliateStats` — an action, because MRR needs Stripe prices. Factor the price lookup out
  of `revenue` into a shared helper.
- `affiliateDetail` — daily clicks and the attributed accounts, using `who()` and each
  account's billing state.

`nootles-ops` gets `/affiliates` (stats table, create/disable, copy link) and
`/affiliates/[id]`, mirrored in `lib/api.ts`. Instants in milliseconds; new result fields
read as optional so either repo can deploy first.

## Other repositories and legal

- `nootles-site`: no code, but review `content/legal.ts` — an attribution cookie and a
  stored referral are new data-use facts.
- Runbook: add `AFFILIATE_CLICK_SECRET` for preview and production.

## Order of work

1. **Backend** — schema, `affiliates.ts` (`recordClick`, `attribute`), admin functions,
   convex-test coverage: window expiry, existing account not re-attributed, stand-in
   refused, disabled link ignored, idempotent claim, bad signature rejected.
2. **App** — `/r/[slug]`, the `proxy.ts` entry, the claim effect, checkout metadata, the
   PostHog tag. End-to-end on a throwaway local backend: click → sign in → attributed →
   checkout reached.
3. **Ops** — `/affiliates` screens and the `lib/api.ts` mirror; `lint`, `tsc`, `build`.
4. **Site** — privacy copy.

The schema change only adds tables and indexes; it ships with the normal Vercel merge.

## Wiki updates when implemented

`data-and-auth.md` (tables, attribution rules, derive-at-read decision),
`cross-repo-contracts.md` (new admin functions + matrix row), `repositories/nootles-ops.md`
(`/affiliates`), `repositories/nootles.md` (`/r` route, public proxy entry),
`operations/runbook.md` (secret), `glossary.md` (affiliate vs access code vs discount code),
and a `change-log.md` entry.
