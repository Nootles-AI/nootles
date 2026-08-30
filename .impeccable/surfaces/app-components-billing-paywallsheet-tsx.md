---
version: 1
slug: "app-components-billing-paywallsheet-tsx"
primary_target: "app/components/billing/PaywallSheet.tsx"
related_targets: ["app/components/billing/paywall.css","app/components/billing/Allowance.tsx","app/components/billing/PlanWall.tsx","app/components/billing/Upgrade.tsx","app/lib/billing/intent.ts"]
---

# Paywall surface

**Scope:** the whole payment flow as one surface — the wall raised at each of the
three meters, the plan screen at `/upgrade`, and the moment after paying.
`PaywallSheet` serves all of it in two modes (`overlay`, `page`).

**Visitor mode:** Persuade. This is the one Persuade surface in an otherwise
Operate app, and it gets composition, scale and motion the app's chrome never
uses — inside the locked palette. No new hue, amber still means AI only, green
still means brand identity only, `--nt-select` is not used here.

## Who, and what they are doing

Someone mid-thought who has just been stopped: two free projects, a hundred kept
completions, or ten conversations, none of which refill. They did not come to
this surface; it arrived in front of them.

**The task:** understand what ran out, decide, and get back to what they were
doing. Not "compare plans" — there are two, and the choice is a small one.

## Chosen direction — "The Gate Stays Open" (seed 485790f2)

One continuous surface. The wall is not a dialog that links to a pricing page;
it is the paywall opened at the sentence that stopped you, and it grows in place
into the plans. Nothing navigates in-app. See
`.impeccable/review/direction-485790f2.md` for the roll and the challengers.

**The memorable moment:** paying hands you back to the exact action, named out
loud — "Back to naming your project" — and the New Project dialog opens itself.

## Rules this surface holds

- **The allowance is a fixed mask, not a bar.** Every unit has a place; spent
  ones are drawn as deliberately as remaining ones. The 100-grain folds to two
  rows of fifty at every width, because a hundred cells on one line fuse into
  the filled bar the drawing exists to refuse.
- **Motion lives in CSS, and its program is written down.** The `THE CHASE`
  block in `paywall.css` states the delays that actually ship. This is not a
  style preference: the sheet opens over live page previews, and JS-driven
  animation is starved by them — measured, the reveal stalled for seconds. Any
  future animation here belongs in a composited keyframe.
- **Intent is two-phase.** The wall *remembers* where you stood; only a grant
  *arms* it. A dismissed wall must never leave a live instruction behind. The
  take is scoped by kind and consumes on read — for `chatSend`, firing twice is
  two model calls and two charges.
- **Name the place on the way out, the action on the way back.** `dismissalOf`
  and `destinationOf` are separate because dismissing buys nothing, and
  promising the action there would be false.
- **Never claim what the deployment cannot do.** An em-dash while a price is
  loading, never a placeholder number; "not on sale from this deployment yet"
  when unconfigured; "Stripe has your payment" rather than the success mark
  until the entitlement itself agrees.

## Unresolved

- No real Stripe checkout has been exercised. The dev deployment sets only
  `STRIPE_PRICE_MONTHLY`; `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ANNUAL` and
  `APP_URL` are unset, so `sellable` is false and prices return null. Every plan
  card capture to date used disclosed synthetic figures.
- The granted stage has only been seen under a temporary probe forcing
  `settled`, never through a genuine grant.
