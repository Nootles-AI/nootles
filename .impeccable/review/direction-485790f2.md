# Paywall surface — the roll and what was locked

Recorded so the direction is corroborable outside the artifact that was built
from it. 2026-08-30.

- **Seed key:** `485790f2`
- **Scope:** surface (the visual world was already settled — see PRODUCT.md's
  brand commitments; this round chose composition, not identity)
- **Mode:** Persuade
- **Build path:** code-led. No image generation on this machine, so no comps
  were produced and none were approved; the cards carried wireframes and the
  ambition rides in the direction contract at the top of `PaywallSheet.tsx`.
- **Dealt indices:** 6, 1, 7 of the grounded candidate list; index 6 led.

## The hand

| | Card | Outcome |
|---|---|---|
| 6 | **The Gate Stays Open** — one continuous surface; the wall opens into the plans in place and closes back onto the action | **locked** |
| 1 | The Statement — a full plan page read as an account statement, plans as further rows of the same ledger | not taken |
| 7 | The Drawer — the plans rise out of the bottom edge of the workspace | not taken |

The full ranked list also held: the two documents (plans as Nootles page
previews), the counterfoil (ticket + stub as the return path), the specimen
sheet (annotated allowance on leader lines), and the receipt strip.

## Challengers, and what was taken from them

Six catalog challengers were dealt. None could win: PRODUCT.md pins light-mode,
neutral, no introduced hue, and a checkout dressed as a dial-up BBS or a motel
sign costs trust at the exact moment money moves. All were declined on identity
— and three were not spent, each donating the one discipline the assigned
direction lacked. Every donation is visible in the build:

- **seven-segment display** → the allowance is a fixed mask in which spent units
  are drawn as deliberately as remaining ones. Absence is designed, not omitted.
  (`Allowance.tsx`, and the `is-spent` / `is-out` values in `paywall.css`.)
- **Miura deployable fold** → the success moment is one deployment: a single
  event propagating through linked elements. The mark's finish releases the
  sentence, which releases the way back. (`.nt-pw-granted` ladder.)
- **desert neon sign program** → the motion is a numbered timing program written
  down in one place, the way a sign shop numbers lamp banks on the elevation.
  (The `THE CHASE` block at the top of `paywall.css`, which states the delays
  that actually ship.)

The remaining three (Miura aside) — iridescent cloud edge, sukeban dress code,
ANSI BBS — were declined without a donation; their disciplines were either
already present (colour confined to hairline edges) or duplicated a grounded
candidate (leader-line callouts).

## Not verified

- A real Stripe checkout. This deployment sets only `STRIPE_PRICE_MONTHLY`; with
  no `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ANNUAL` or `APP_URL`, `prices` returns
  nulls and `sellable` is false. The plan cards were photographed behind
  temporarily stubbed prices, and no stubbed value ships.
- A real grant. The granted stage was rendered under a two-line probe forcing
  `settled`, rather than by mutating the owner's billing data.
