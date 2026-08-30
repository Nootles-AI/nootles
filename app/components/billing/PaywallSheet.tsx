"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Entitlement, Meter } from "@/convex/entitlements";
import type { CodeRefusalReason } from "@/convex/accessCodes";
import {
  armIntent,
  forgetIntent,
  type BillingIntent,
} from "@/app/lib/billing/intent";
import { useWaitingIntent } from "@/app/lib/billing/useWaitingIntent";
import { Allowance, Strip } from "./Allowance";
import "./paywall.css";

/* THESIS: paying is a pause inside the thing you were doing, not a departure
   from it — one sheet carries the refusal, the price, and the way back, and it
   refuses the pricing page you get sent to and then have to find your way home
   from. OWN-WORLD: the app's own paper and graphite — hairline rules, mono for
   anything countable, no hue introduced; the allowance drawn as three strips of
   equal length subdivided 2 / 10 / 100, spent units drawn as deliberately as
   remaining ones. STORY: you are stopped where you stood, shown what you have
   spent and what Pro costs, and handed back to the exact action you were
   taking. FIRST VIEWPORT: the workspace dimmed and still legible behind a
   centred sheet that opens at the size of the sentence that stopped you, grows
   in place to hold the strips and two plans, and closes onto the control you
   pressed. FORM: one continuous surface, candidate 6 of 7, seed 485790f2.
   FINISH: unreviewed and undocumented is unfinished; this build ends with the
   finish review, the verdict, DESIGN.md, and every shipping raster carrying its
   provenance. */

/**
 * How long the way back waits before taking itself, measured from the moment the
 * deployment starts. Interruptible throughout.
 *
 * The mark and the sentence own the first second of that (see the granted
 * ladder in `paywall.css`), so this is deliberately longer than a bare
 * countdown: the person gets a clear ~2.4s with the button in front of them,
 * not a bar that is already half gone by the time it appears.
 */
const RETURN_MS = 3400;

const STOPPED: Record<Meter, { title: string; body: string }> = {
  projects: {
    title: "That's both your free projects",
    body: "Pro lifts the limit. Everything already here stays exactly as it is.",
  },
  completions: {
    title: "You've kept all 100 free completions",
    body: "The editor works as it always did — the suggestions are what stopped. Pro turns them back on for good.",
  },
  chats: {
    title: "That's all ten free conversations",
    body: "The ones you've already started still work. Pro lets you begin as many more as you like.",
  },
};

const CODE_SAID: Record<CodeRefusalReason, string> = {
  unknown: "We don't have a code by that name. Check the spelling?",
  disabled: "That code has been withdrawn.",
  expired: "That code has expired.",
  exhausted: "That code has been used as many times as it allows.",
  already: "You've already used that code.",
};

function refusalOf(error: unknown): string {
  const data = (error as { data?: unknown })?.data;
  if (typeof data === "object" && data !== null) {
    const reason = (data as { reason?: string }).reason;
    if (reason && reason in CODE_SAID)
      return CODE_SAID[reason as CodeRefusalReason];
  }
  if (typeof data === "string" && data.trim()) return data.trim();
  return "That didn't work. Try again?";
}

function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    // Whole-pound prices should not read "£12.00"; a price with pence should.
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

/** The way back, named — so the sheet says what it is about to do, and can be beaten to it. */
function destinationOf(intent: BillingIntent | null): string {
  switch (intent?.kind) {
    case "newProject":
      return "Back to naming your project";
    case "chatSend":
      return "Back to your conversation";
    case "completion":
      return "Back to your page";
    default:
      return "Back to your projects";
  }
}

/**
 * What leaving without paying goes back to.
 *
 * Names the PLACE, where `destinationOf` names the action — and the difference
 * is not pedantry. Dismissing the wall returns you to the screen you were on;
 * it does not open the dialog or send the message, because nothing was bought.
 * Promising the action here would be the one lie the flow cannot afford.
 */
function dismissalOf(intent: BillingIntent | null): string {
  switch (intent?.kind) {
    case "chatSend":
      return "Back to your conversation";
    case "completion":
      return "Back to your page";
    case "newProject":
    default:
      return "Back to your projects";
  }
}

function returningLine(intent: BillingIntent | null): string {
  switch (intent?.kind) {
    case "newProject":
      return "Taking you back to the project you were starting.";
    case "chatSend":
      return "Taking you back to your conversation — the message you wrote will send itself.";
    case "completion":
      return "Taking you back to the page you were writing.";
    default:
      return "Everything is open. Taking you back to your projects.";
  }
}

type Stage = "stopped" | "plans" | "granted";

export function PaywallSheet({
  mode,
  meter = null,
  outcome = null,
  onDismiss,
  onResume,
}: {
  mode: "overlay" | "page";
  /** What ran out. Opens the sheet on the sentence rather than on the price. */
  meter?: Meter | null;
  /** `?checkout=` as Stripe left it. */
  outcome?: string | null;
  onDismiss?: () => void;
  /** Overlay only: access granted in place — close and do the thing. */
  onResume?: () => void;
}) {
  const router = useRouter();
  const plan = useQuery(api.billing.plan, {});
  const prices = useAction(api.billing.prices);
  const startCheckout = useAction(api.billing.startCheckout);
  const manage = useAction(api.billing.manage);
  const redeem = useMutation(api.accessCodes.redeem);
  const sawWall = useMutation(api.entitlements.sawWall);

  const [stage, setStage] = useState<Stage>(
    outcome === "done" ? "granted" : meter ? "stopped" : "plans",
  );
  const [cost, setCost] = useState<{
    month: { amount: number; currency: string } | null;
    year: { amount: number; currency: string } | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Carries WHERE it belongs as well as what it says. A checkout refusal
  // reported under the code form is a refusal read after scrolling past the
  // button that caused it, which is how the old screen lost its own errors.
  const [said, setSaid] = useState<{
    text: string;
    bad: boolean;
    where: "plans" | "code";
  } | null>(null);
  const [code, setCode] = useState("");

  const entitlement = (plan?.entitlement ?? null) as Entitlement | null;
  const pro = entitlement?.plan === "pro";
  const waiting = useWaitingIntent()?.intent ?? null;

  // Reported as it is DRAWN, not where it was refused: the server says no in
  // several places and the person is shown one sheet. Swallowed on failure — a
  // paywall that errors because it could not log itself is worse than not
  // knowing.
  useEffect(() => {
    if (!meter) return;
    void sawWall({ meter }).catch(() => {});
  }, [sawWall, meter]);

  // Fetched rather than subscribed: what a plan costs lives in Stripe, which is
  // not a reactive source. Once per mount is plenty.
  useEffect(() => {
    let live = true;
    void prices()
      .then((p) => live && setCost(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prices]);

  const dismiss = () => {
    // The note of where we were standing dies with the refusal. Left behind, it
    // would replay an action nobody bought anything for.
    forgetIntent();
    onDismiss?.();
  };

  const dismissRef = useRef(dismiss);
  useEffect(() => {
    dismissRef.current = dismiss;
  });

  useEffect(() => {
    if (mode !== "overlay") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      dismissRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode]);

  /** The deployment has landed and the entitlement agrees: go. */
  const settled = stage === "granted" && pro;

  /**
   * The way back. In overlay mode nothing navigates at all — the sheet closes
   * onto the control that raised it and the parent performs the action. In page
   * mode the note becomes an instruction and the screen we land on replays it.
   */
  const goBack = useRef<() => void>(() => {});
  useEffect(() => {
    goBack.current = () => {
      if (mode === "overlay") {
        onResume?.();
        return;
      }
      const armed = armIntent();
      router.push(armed?.from ?? "/");
    };
  });

  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => goBack.current(), RETURN_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  const leave = (what: string, go: Promise<{ url: string }>) => {
    setBusy(what);
    setSaid(null);
    void go
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((error: unknown) => {
        setBusy(null);
        setSaid({ text: refusalOf(error), bad: true, where: "plans" });
      });
  };

  const onRedeem = (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy("code");
    setSaid(null);
    void redeem({ code })
      .then(() => {
        setCode("");
        setSaid(null);
        setStage("granted");
      })
      .catch((error: unknown) =>
        setSaid({ text: refusalOf(error), bad: true, where: "code" }),
      )
      .finally(() => setBusy(null));
  };

  const sheet = (
    <div
      className={`nt-pw-sheet${stage === "plans" ? " is-wide" : ""}`}
      role={mode === "overlay" ? "dialog" : undefined}
      aria-modal={mode === "overlay" ? true : undefined}
      aria-label={meter ? STOPPED[meter].title : "Nootles Pro"}
      style={mode === "overlay" ? { zIndex: "var(--z-modal)" } : undefined}
    >
      {/* No `AnimatePresence`, and no cross-fade between stages.
          `mode="wait"` holds the incoming stage until the outgoing one's exit
          animation resolves — and that exit runs on the main thread, which on
          this screen belongs to a grid of rendering page previews. Measured: the
          sheet widened to the plans and then sat on the previous stage, half
          faded, for seconds. Gating what you can SEE on an animation completing
          is the bug; the stage swaps immediately and the CSS chase gives the new
          one its entrance. */}
      <div
        key={stage}
        className={`nt-pw-field${stage === "granted" ? " nt-pw-granted" : ""}`}
      >
        {stage === "stopped" && meter && (
          <>
            <p className="nt-pw-title">{STOPPED[meter].title}</p>
            <p className="nt-pw-lede">{STOPPED[meter].body}</p>
            <div className="mt-5">
              <Strip meter={meter} left={0} />
            </div>
            <div className="nt-pw-answers">
              <button type="button" onClick={dismiss} className="nt-pw-btn">
                {dismissalOf(waiting)}
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => setStage("plans")}
                className="nt-pw-btn is-solid"
              >
                See what Pro costs
              </button>
            </div>
          </>
        )}

        {stage === "plans" && (
          <>
            <p className="nt-pw-title">
              {pro ? "You're on Pro" : "Nootles Pro"}
            </p>
            <p className="nt-pw-lede">
              {pro
                ? "Projects, completions and the chat agent — none of them counted."
                : "Unlimited projects, unlimited completions, and the chat agent for as long as you want to talk to it."}
            </p>

            {outcome === "cancelled" && (
              <p className="nt-pw-said">
                Checkout was cancelled. Nothing was charged.
              </p>
            )}

            <div className="mt-5">
              {entitlement === null ? (
                <div className="nt-pw-standing" aria-busy />
              ) : entitlement.left ? (
                <Allowance left={entitlement.left} emphasis={meter} />
              ) : (
                <Standing entitlement={entitlement} />
              )}
            </div>

            {!pro && plan?.sellable === false ? (
              <p className="nt-pw-said">
                Pro is not on sale from this deployment yet. A code still works.
              </p>
            ) : !pro ? (
              <div className="nt-pw-plans">
                <Plan
                  name="Monthly"
                  cost={cost?.month ?? null}
                  per="a month"
                  // The annual card derives a per-month figure in this slot,
                  // and leaving monthly's empty left a void the eye reads as a
                  // missing number — worst on a phone, where the cards stack.
                  // This is the fact a monthly buyer actually wants in its
                  // place, and it is true: the Stripe portal behind "Manage
                  // billing or cancel" ends the subscription.
                  note="Cancel any time"
                  busy={busy}
                  which="month"
                  onBuy={() =>
                    leave("month", startCheckout({ interval: "month" }))
                  }
                />
                <Plan
                  name="Annual"
                  cost={cost?.year ?? null}
                  per="a year"
                  note={
                    cost?.month && cost.year
                      ? `${money(Math.round(cost.year.amount / 12), cost.year.currency)} a month`
                      : undefined
                  }
                  busy={busy}
                  which="year"
                  onBuy={() =>
                    leave("year", startCheckout({ interval: "year" }))
                  }
                />
              </div>
            ) : plan?.manageable ? (
              <p className="nt-pw-said">
                <button
                  type="button"
                  className="hover:underline"
                  disabled={busy !== null}
                  onClick={() => leave("manage", manage())}
                >
                  {busy === "manage"
                    ? "Opening Stripe…"
                    : "Manage billing or cancel"}
                </button>
              </p>
            ) : (
              /* Pro without a Stripe customer — a code or a standing pass.
                 There is nothing to manage, and the branch that used to render
                 nothing here left the sheet stopping mid-sentence. */
              <p className="nt-pw-said">
                Nothing to manage — this was granted rather than billed.
              </p>
            )}

            {said?.where === "plans" && (
              <p
                className={`nt-pw-said${said.bad ? " is-bad" : ""}`}
                role="status"
              >
                {said.text}
              </p>
            )}

            {!pro && (
              <>
                <hr className="nt-pw-rule" />
                <form className="nt-pw-code" onSubmit={onRedeem}>
                  <label>
                    <span className="nt-field-label">Have a code?</span>
                    <input
                      className="nt-input"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="NOOTLES2026"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="Access code"
                    />
                  </label>
                  <button
                    type="submit"
                    className="nt-pw-btn is-outline"
                    disabled={busy !== null || !code.trim()}
                  >
                    {busy === "code" ? "…" : "Redeem"}
                  </button>
                </form>
                {said?.where === "code" && (
                  <p
                    className={`nt-pw-said${said.bad ? " is-bad" : ""}`}
                    role="status"
                  >
                    {said.text}
                  </p>
                )}
              </>
            )}

            {mode === "overlay" && (
              <div className="nt-pw-answers">
                <button type="button" onClick={dismiss} className="nt-pw-btn">
                  {dismissalOf(waiting)}
                </button>
              </div>
            )}
          </>
        )}

        {stage === "granted" &&
          (settled ? (
            <Deployment intent={waiting} onGo={() => goBack.current()} />
          ) : (
            <Settling />
          ))}
      </div>
    </div>
  );

  if (mode === "page") return sheet;

  return (
    <>
      <button
        aria-label="Close"
        onClick={dismiss}
        className="nt-pw-scrim"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div className="nt-pw-holder" style={{ zIndex: "var(--z-modal)" }}>
        {sheet}
      </div>
    </>
  );
}

/**
 * Paid, and the webhook has not said so yet.
 *
 * Named honestly rather than dressed as success: the money has moved and the
 * deployment has not been told. Showing the mark here and taking it back if the
 * entitlement disagreed would be the one lie this surface cannot afford.
 */
function Settling() {
  return (
    <>
      <div className="nt-pw-spinner" />
      <p className="nt-pw-title">Stripe has your payment</p>
      <p className="nt-pw-lede">
        This opens up the moment Stripe tells us — usually a second or two.
      </p>
    </>
  );
}

/**
 * One pull opening a linked field: the mark draws, its finishing moves the
 * sentence, and the sentence moves the way back. Three entrances that each had
 * their own idea would read as three things happening; this reads as one.
 */
function Deployment({
  intent,
  onGo,
}: {
  intent: BillingIntent | null;
  onGo: () => void;
}) {
  // A fragment, not a wrapper: these are the direct children of `.nt-pw-field`,
  // so the same CSS chase that opens every other stage carries this one — the
  // mark first, then the sentence, then the way back. Motion is kept for the
  // two things a stylesheet cannot do, the drawn stroke and the timer.
  return (
    <>
      <svg className="nt-pw-mark" viewBox="0 0 44 44" aria-hidden>
        <circle cx="22" cy="22" r="20" />
        <path d="M14 22.5 L19.5 28 L29.5 17.5" />
      </svg>
      <p className="nt-pw-title">You&rsquo;re on Pro</p>
      <p className="nt-pw-lede">{returningLine(intent)}</p>
      <button type="button" autoFocus className="nt-pw-back" onClick={onGo}>
        {destinationOf(intent)}
        <Arrow />
      </button>
      <div
        className="nt-pw-timer"
        aria-hidden
        style={{ "--return": `${RETURN_MS}ms` } as CSSProperties}
      >
        <span />
      </div>
    </>
  );
}

function Arrow() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 8h9M8.5 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** How a pro account got there, and when it lapses. */
function Standing({ entitlement }: { entitlement: Entitlement }) {
  const { source, expiresAt, cancelAtPeriodEnd } = entitlement;
  return (
    <div className="nt-pw-standing">
      <p className="nt-pw-standing-line">
        {source === "vip"
          ? "Your account has a standing pass — nothing here is metered."
          : source === "code"
            ? "Redeemed with a code."
            : "Subscribed."}
        {expiresAt !== undefined && (
          <span className="nt-pw-standing-when">
            {" "}
            {cancelAtPeriodEnd ? "Ends" : "Renews"} {WHEN.format(expiresAt)}
          </span>
        )}
      </p>
    </div>
  );
}

function Plan({
  name,
  cost,
  per,
  note,
  busy,
  which,
  onBuy,
}: {
  name: string;
  cost: { amount: number; currency: string } | null;
  per: string;
  note?: string;
  busy: string | null;
  which: string;
  onBuy: () => void;
}) {
  return (
    <button
      type="button"
      className="nt-pw-plan"
      disabled={busy !== null || cost === null}
      onClick={onBuy}
    >
      <span className="nt-pw-label">{name}</span>
      {/* An em-dash while the price is still arriving, never a placeholder
          number: a figure that turns out to be "still loading" is a lie about
          what it costs. */}
      <span className="nt-pw-plan-price" aria-busy={cost === null}>
        {cost ? money(cost.amount, cost.currency) : "—"}
        <small>{per}</small>
      </span>
      {/* Rendered only when there is one. A blank line held open to keep the
          two cards level is invisible side by side and an obvious hole once
          they stack on a phone — and the grid already levels them, because
          the action below is pushed down by its own `margin-top: auto`. */}
      {note && <span className="nt-pw-plan-note">{note}</span>}
      <span className="nt-pw-plan-go">
        {busy === which ? "Opening Stripe…" : `Choose ${name.toLowerCase()}`}
      </span>
    </button>
  );
}
