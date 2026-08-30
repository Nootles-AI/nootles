"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { FREE_LIMITS, type Entitlement } from "@/convex/entitlements";
import type { CodeRefusalReason } from "@/convex/accessCodes";
import { Wordmark } from "@/app/components/Brand";
import "./upgrade.css";

/**
 * The plan screen: what this account has, and the three ways to change it —
 * buy monthly, buy annually, or type a code somebody gave you.
 *
 * It is one page rather than a modal because it is also where a subscriber
 * comes back to cancel, and a thing you can only reach by first hitting a wall
 * is a thing that reads as a trap.
 */

/** What a refusal means, said to the person who typed the code. */
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
    if (reason && reason in CODE_SAID) return CODE_SAID[reason as CodeRefusalReason];
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

export function Upgrade({ outcome }: { outcome: string | null }) {
  const plan = useQuery(api.billing.plan, {});
  const prices = useAction(api.billing.prices);
  const startCheckout = useAction(api.billing.startCheckout);
  const manage = useAction(api.billing.manage);
  const redeem = useMutation(api.accessCodes.redeem);

  const [cost, setCost] = useState<{
    month: { amount: number; currency: string } | null;
    year: { amount: number; currency: string } | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const [code, setCode] = useState("");

  // Fetched rather than subscribed: what a plan costs lives in Stripe, and
  // Stripe is not a reactive source. Once per mount is plenty — a price change
  // that lands mid-visit is not a thing anyone needs to see happen.
  useEffect(() => {
    let live = true;
    void prices()
      .then((p) => live && setCost(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [prices]);

  const leave = (what: string, go: Promise<{ url: string }>) => {
    setBusy(what);
    setSaid(null);
    void go
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((error: unknown) => {
        setBusy(null);
        setSaid({ text: refusalOf(error), bad: true });
      });
  };

  const entitlement = (plan?.entitlement ?? null) as Entitlement | null;
  const pro = entitlement?.plan === "pro";

  return (
    <div className="nt-up">
      <div className="nt-up-shell">
        <header className="nt-up-head">
          <Link href="/" aria-label="Nootles">
            <Wordmark height={18} />
          </Link>
          <Link href="/" className="nt-note hover:underline">
            Back to your projects
          </Link>
        </header>

        <h1 className="nt-up-title">{pro ? "You're on Pro" : "Nootles Pro"}</h1>
        <p className="nt-up-lede">
          {pro
            ? "Everything is open — projects, completions and the chat agent, without a limit on any of them."
            : "Unlimited projects, unlimited completions, and the chat agent for as long as you want to talk to it."}
        </p>

        {/* What returning from Stripe is answered with. A cancelled checkout is
            stated plainly and left alone — somebody who backed out does not need
            to be asked again on the same screen. */}
        {outcome === "cancelled" && (
          <p className="nt-up-said">Checkout was cancelled. Nothing was charged.</p>
        )}
        {outcome === "done" && !pro && (
          <p className="nt-up-said">
            Stripe has your payment. This page will open up as soon as it tells
            us — usually a second or two.
          </p>
        )}

        {entitlement === null ? (
          <div className="nt-up-standing" aria-busy />
        ) : (
          <Standing entitlement={entitlement} />
        )}

        {pro ? (
          plan?.manageable && (
            <p className="nt-up-said">
              <button
                type="button"
                className="hover:underline"
                disabled={busy !== null}
                onClick={() => leave("manage", manage())}
              >
                {busy === "manage" ? "Opening Stripe…" : "Manage billing or cancel"}
              </button>
            </p>
          )
        ) : plan?.sellable === false ? (
          <p className="nt-up-said">
            Pro is not on sale from this deployment yet. A code still works.
          </p>
        ) : (
          <div className="nt-up-plans">
            <Plan
              name="Monthly"
              cost={cost?.month ?? null}
              per="per month"
              busy={busy}
              which="month"
              onBuy={() => leave("month", startCheckout({ interval: "month" }))}
            />
            <Plan
              name="Annual"
              cost={cost?.year ?? null}
              per="per year"
              note={
                cost?.month && cost.year
                  ? `${money(Math.round(cost.year.amount / 12), cost.year.currency)} a month`
                  : undefined
              }
              busy={busy}
              which="year"
              onBuy={() => leave("year", startCheckout({ interval: "year" }))}
            />
          </div>
        )}

        <hr className="nt-up-rule" />

        <form
          className="nt-up-code"
          onSubmit={(e) => {
            e.preventDefault();
            if (!code.trim()) return;
            setBusy("code");
            setSaid(null);
            void redeem({ code })
              .then((granted) => {
                setCode("");
                setSaid({
                  text: granted.expiresAt
                    ? `Done — Pro until ${WHEN.format(granted.expiresAt)}.`
                    : "Done — you're on Pro.",
                  bad: false,
                });
              })
              .catch((error: unknown) =>
                setSaid({ text: refusalOf(error), bad: true }),
              )
              .finally(() => setBusy(null));
          }}
        >
          <label className="flex-1">
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
          <button type="submit" disabled={busy !== null || !code.trim()}>
            {busy === "code" ? "…" : "Redeem"}
          </button>
        </form>

        {said && (
          <p className={`nt-up-said${said.bad ? " is-bad" : ""}`} role="status">
            {said.text}
          </p>
        )}
      </div>
    </div>
  );
}

/** Where this account stands — how it got Pro, or what is left of the free run. */
function Standing({ entitlement }: { entitlement: Entitlement }) {
  const { left, source, expiresAt, cancelAtPeriodEnd } = entitlement;

  if (left === null) {
    return (
      <div className="nt-up-standing">
        <p className="text-[length:var(--text-ui)]">
          {source === "vip"
            ? "Your account has a standing pass — nothing here is metered."
            : source === "code"
              ? "Redeemed with a code."
              : "Subscribed."}
          {expiresAt && (
            <span className="nt-note">
              {" "}
              {cancelAtPeriodEnd ? "Ends" : "Renews"} {WHEN.format(expiresAt)}
            </span>
          )}
        </p>
      </div>
    );
  }

  // Said as what is left rather than what is used: the number that matters is
  // the one you are about to spend. The free run does not refill, and the
  // sentence below says so once rather than each line implying it.
  return (
    <div className="nt-up-standing">
      <p className="nt-note">Your free run — it does not reset</p>
      <div className="nt-up-meters">
        <Meter label="Projects" left={left.projects} of={FREE_LIMITS.projects} />
        <Meter
          label="Completions kept"
          left={left.completions}
          of={FREE_LIMITS.completions}
        />
        <Meter label="Conversations" left={left.chats} of={FREE_LIMITS.chats} />
      </div>
    </div>
  );
}

function Meter({ label, left, of }: { label: string; left: number; of: number }) {
  return (
    <p className={`nt-up-meter${left === 0 ? " is-out" : ""}`}>
      <span>{label}</span>
      <span>{left === 0 ? "all used" : `${left} of ${of} left`}</span>
    </p>
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
    <div className="nt-up-plan">
      <p className="nt-up-plan-name">{name}</p>
      {/* An em-dash while the price is still arriving, never a placeholder
          number: a figure that turns out to be "still loading" is a lie about
          what it costs. */}
      <p className="nt-up-price" aria-busy={cost === null}>
        {cost ? money(cost.amount, cost.currency) : "—"}
        <small>{per}</small>
      </p>
      {note && <p className="nt-note">{note}</p>}
      <button type="button" disabled={busy !== null || cost === null} onClick={onBuy}>
        {busy === which ? "Opening Stripe…" : `Choose ${name.toLowerCase()}`}
      </button>
    </div>
  );
}
