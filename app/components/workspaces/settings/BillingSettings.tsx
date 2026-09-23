"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { atLeast } from "@/convex/auth";
import type { Meter } from "@/convex/limits";
import type { PlanName } from "@/convex/plans";
import { settingsPath } from "@/app/lib/containerPaths";
import { Strip } from "../../billing/Allowance";
import { X } from "../../Icons";
import { useStandIn } from "../../StandIn";
import { useContainer, type WorkspaceContainer } from "../ContainerContext";
import { useNaming } from "../people";
import { refusal } from "../refusal";
import { ROLE_LABEL } from "../seats";
import { Avatar, Bone } from "./MembersSettings";
import "../../billing/paywall.css";

type Summary = NonNullable<FunctionReturnType<typeof api.teamBilling.summary>>;
type People = NonNullable<FunctionReturnType<typeof api.members.list>>;

const WHEN = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const DAY = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

const PLAN_LABEL: Record<PlanName, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
};

const METERS: Meter[] = ["projects", "completions", "chats"];

/** One cell a twentieth of the allowance: few enough to count, as the free strips are. */
const USAGE_CELLS = 20;

/** Past this share of the period's spend, what guests spent is worth an admin's attention. */
const GUEST_SHARE_ALERT = 0.25;

/** A Stripe amount, in the currency's smallest unit: whole prices without the pennies. */
function money(amount: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: amount % 100 === 0 ? 0 : 2,
  }).format(amount / 100);
}

function usd(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * What a workspace is on, who it pays for, and what its AI has cost this
 * period.
 *
 * Owners and admins start the Team plan here and manage it in Stripe's
 * portal; members read the same page with nothing to press. Every figure is
 * the server's (`teamBilling.summary`) — the page only draws it.
 */
export function BillingSettings({ outcome }: { outcome: string | null }) {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <Billing workspace={container} outcome={outcome} />;
}

function Billing({ workspace, outcome }: { workspace: WorkspaceContainer; outcome: string | null }) {
  const router = useRouter();
  const standIn = useStandIn();
  const args = { workspaceId: workspace.workspaceId };
  const summary = useQuery(api.teamBilling.summary, args);
  const standing = useQuery(api.entitlements.forContainer, args);
  const people = useQuery(api.members.list, args);
  const [told, setTold] = useState(outcome === "done" || outcome === "cancelled");

  // Every section's shape depends on both answers, so the page is drawn once
  // it has them rather than growing a section at a time.
  if (summary === undefined || standing === undefined) return <Loading />;
  // A guest, or a seat that has just gone: the frame moves them on.
  if (summary === null) return null;
  const acts = !standIn && summary.canManage;
  // Back from a paid checkout the mirror has not caught up with: Stripe has
  // the payment and the page must not say Free, or offer a second checkout.
  const settling = told && outcome === "done";

  const dismiss = () => {
    setTold(false);
    // The cue has been said; a reload should not say it again.
    router.replace(settingsPath(workspace.slug, "billing"), { scroll: false });
  };

  return (
    <>
      <PlanSection
        workspace={workspace}
        summary={summary}
        acts={acts}
        outcome={told ? outcome : null}
        onDismiss={dismiss}
      />
      <Period
        workspace={workspace}
        summary={summary}
        acts={acts}
        left={settling && !summary.subscription?.live ? null : (standing?.entitlement.left ?? null)}
        guestCap={standing?.features.guestDailyAiUsd ?? null}
      />
      <SeatsSection summary={summary} people={people ?? null} />
    </>
  );
}

// ---- The plan ----------------------------------------------------------------

type Price = { amount: number; currency: string };

function PlanSection({
  workspace,
  summary,
  acts,
  outcome,
  onDismiss,
}: {
  workspace: WorkspaceContainer;
  summary: Summary;
  acts: boolean;
  /** `?checkout=` as Stripe left it, until it has been dismissed. */
  outcome: string | null;
  onDismiss: () => void;
}) {
  const startCheckout = useAction(api.billing.startTeamCheckout);
  const manage = useAction(api.billing.manageTeam);
  const seatPrice = useAction(api.billing.teamSeatPrice);
  const [busy, setBusy] = useState<"start" | "manage" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [cost, setCost] = useState<Price | null | undefined>(undefined);

  const { subscription, plan, source } = summary;
  const live = subscription?.live ?? false;
  const paid = source !== "none";
  const settling = outcome === "done" && !live;
  const starts = !paid && !summary.unsettled && summary.configured && outcome !== "done";
  const priced = !paid && !summary.unsettled && summary.configured && !settling;

  // Fetched rather than subscribed, as the personal plans' prices are: what a
  // seat costs lives in Stripe, which is not a reactive source.
  useEffect(() => {
    if (!priced) return;
    let on = true;
    void seatPrice()
      .then((p) => on && setCost(p))
      .catch(() => on && setCost(null));
    return () => {
      on = false;
    };
  }, [seatPrice, priced]);

  const leave = (what: "start" | "manage", go: Promise<{ url: string }>, fallback: string) => {
    setBusy(what);
    setProblem(null);
    void go
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((error: unknown) => {
        setBusy(null);
        setProblem(refusal(error, fallback));
      });
  };

  // Stripe's return is only the cue: what is said follows the mirror, so a
  // payment the webhook has not reported yet is named as exactly that — and
  // cannot be dismissed, since that would offer checkout again.
  const line =
    outcome === "cancelled"
      ? "Checkout was cancelled. Nothing was charged."
      : outcome === "done"
        ? live
          ? `${workspace.name} is on the Team plan. Everything is open.`
          : `Payment received. ${workspace.name} moves to the Team plan as soon as Stripe confirms it, ` +
            "usually within a few seconds. If it hasn’t after a minute, reload this page."
        : null;
  const note = settling ? null : planNote(workspace, summary, acts);

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-plan">
      <h2 id="nt-ws-plan" className="nt-set-label">
        Plan
      </h2>
      <ul className="nt-set-list">
        <li className="nt-set-row" tabIndex={-1}>
          <div className="nt-set-body-col">
            <p className="nt-set-name">{PLAN_LABEL[plan]}</p>
            <p className="nt-set-meta">{settling ? "Confirming payment…" : standingLine(summary)}</p>
            {note && <p className="nt-set-note">{note}</p>}
            {priced && cost !== undefined && (
              <div className="nt-ws-fold is-arriving">
                <div className="nt-ws-fold-body">
                  <p className="nt-set-note">{priceNote(summary, cost)}</p>
                </div>
              </div>
            )}
            {!acts && !paid && summary.configured && (
              <p className="nt-set-note">
                {summary.unsettled
                  ? `Only an owner or an admin can fix ${workspace.name}’s billing.`
                  : "Only an owner or an admin can start the Team plan."}
              </p>
            )}
            {line && <Outcome line={line} onDismiss={settling ? null : onDismiss} />}
            {problem && (
              <p role="alert" className="nt-set-problem">
                {problem}
              </p>
            )}
          </div>
          {acts && (
            <div className="nt-set-actions">
              {summary.manageable && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    leave(
                      "manage",
                      manage({ workspaceId: workspace.workspaceId }),
                      "Couldn’t open billing. Try again in a moment.",
                    )
                  }
                  className="nt-row px-2.5"
                >
                  {busy === "manage" ? "Opening Stripe…" : "Manage billing"}
                </button>
              )}
              {starts && (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    leave(
                      "start",
                      startCheckout({ workspaceId: workspace.workspaceId }),
                      "Couldn’t open checkout. Try again in a moment.",
                    )
                  }
                  className="nt-row nt-solid px-3 font-medium"
                >
                  {busy === "start" ? "Opening Stripe…" : "Start the Team plan"}
                </button>
              )}
            </div>
          )}
        </li>
      </ul>
    </section>
  );
}

/**
 * The checkout's outcome line. A new sentence settles in again rather than
 * changing in place; dismissed, it folds shut before it goes, so the card
 * shortens rather than snapping, and focus waits on its row.
 */
function Outcome({ line, onDismiss }: { line: string; onDismiss: (() => void) | null }) {
  const [leaving, setLeaving] = useState(false);
  const fold = useRef<HTMLDivElement>(null);
  const leave = () => {
    if (!onDismiss) return;
    // Before the fold goes inert, which would drop focus to the page.
    fold.current?.closest<HTMLElement>(".nt-set-row")?.focus();
    // Without motion no transition ends, so there is nothing to wait for.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onDismiss();
    else setLeaving(true);
  };
  return (
    <div
      ref={fold}
      className="nt-ws-fold"
      data-open={!leaving}
      inert={leaving}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.propertyName === "grid-template-rows") {
          onDismiss?.();
        }
      }}
    >
      <div className="nt-ws-fold-body">
        <div key={line} role="status" className="nt-set-outcome nt-set-note">
          <span>{line}</span>
          {onDismiss && (
            <button type="button" onClick={leave} aria-label="Dismiss" className="nt-icon-btn is-sm">
              <X />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The plan's state in one mono line: how it stands and until when. */
function standingLine({ source, subscription, unsettled, configured }: Summary): string {
  if (source === "override") return "Granted";
  if (!subscription) return configured ? "Not started" : "Not available yet";
  if (unsettled) return subscription.status === "paused" ? "Paused" : "Unpaid";
  const until = WHEN.format(subscription.periodEnd);
  if (!subscription.live) return `Ended ${until}`;
  if (subscription.status === "past_due") return "Payment past due";
  if (subscription.cancelAtPeriodEnd) return `Ends ${until}`;
  if (subscription.status === "trialing") return `Trial · ends ${until}`;
  return `Renews ${until}`;
}

function planNote(workspace: WorkspaceContainer, summary: Summary, acts: boolean): string {
  const { source, subscription, unsettled } = summary;
  if (source === "override") return "Nootles granted this plan. Nothing here is billed.";
  if (unsettled) {
    return (
      `${workspace.name}’s subscription needs attention in Stripe, so everyone is back on the ` +
      "free allowance." +
      (acts ? " Add or update the card in Manage billing to restore the Team plan." : "")
    );
  }
  if (subscription?.live && subscription.status === "past_due") {
    return (
      "Stripe couldn’t take the last payment and is trying the card again. " +
      "Nothing is locked while it does." +
      (acts ? " Update the card in Manage billing to keep the Team plan." : "")
    );
  }
  if (subscription?.live) {
    const { seats } = subscription;
    return (
      `${seats === 1 ? "Its seat includes" : `Each of its ${seats} seats includes`} ` +
      `${usd(summary.allowancePerSeatUsd)} of AI a month. ` +
      "AI past that is added to the next invoice."
    );
  }
  return `Everyone in ${workspace.name} shares one free allowance.`;
}

/** What the Team plan would cost, in Stripe's own figure once Stripe has said it. */
function priceNote(summary: Summary, cost: Price | null): string {
  const ai = `${usd(summary.allowancePerSeatUsd)} of AI included per seat`;
  if (!cost) return `The Team plan is billed monthly per seat, with ${ai}.`;
  const seats = Math.max(1, summary.seatsInUse);
  return (
    `The Team plan is ${money(cost.amount, cost.currency)} a seat each month, with ${ai} — ` +
    `${money(cost.amount * seats, cost.currency)} a month for ${seats} ${seats === 1 ? "seat" : "seats"}.`
  );
}

// ---- This period's AI ----------------------------------------------------------

/**
 * The period's section: what the plan's AI has cost, or the free allowance
 * while there is no plan. Whichever replaces the one the page opened with —
 * the plan landing while the page is open — rises in rather than appearing.
 */
function Period({
  workspace,
  summary,
  acts,
  left,
  guestCap,
}: {
  workspace: WorkspaceContainer;
  summary: Summary;
  acts: boolean;
  left: Record<Meter, number> | null;
  guestCap: number | null;
}) {
  const kind = summary.usage ? "usage" : left ? "free" : null;
  const [first] = useState(kind);
  const arriving = kind !== first;
  if (summary.usage) {
    return (
      <UsageSection
        workspace={workspace}
        summary={summary}
        usage={summary.usage}
        acts={acts}
        guestCap={guestCap}
        arriving={arriving}
      />
    );
  }
  return left && <FreeSection workspace={workspace} left={left} arriving={arriving} />;
}

function UsageSection({
  workspace,
  summary,
  usage,
  acts,
  guestCap,
  arriving,
}: {
  workspace: WorkspaceContainer;
  summary: Summary;
  usage: NonNullable<Summary["usage"]>;
  acts: boolean;
  guestCap: number | null;
  arriving: boolean;
}) {
  const { allowanceUsd, spentUsd, guestUsd } = usage;
  const over = Math.max(0, spentUsd - allowanceUsd);
  // Rounded up, so a sliver still left is a cell still lit: "all used" is
  // said only when it is so.
  const left = Math.max(0, allowanceUsd - spentUsd);
  const lit = allowanceUsd > 0 ? Math.ceil((left / allowanceUsd) * USAGE_CELLS) : 0;
  // The overage at the same grain as the allowance, so a cell means the same
  // amount in both strips; past a whole allowance over, the strip is full.
  const overCells =
    allowanceUsd > 0 ? Math.min(USAGE_CELLS, Math.ceil((over / allowanceUsd) * USAGE_CELLS)) : USAGE_CELLS;
  const said =
    over > 0 ? `${usd(spentUsd)} used · ${usd(over)} over` : `${usd(spentUsd)} used · ${usd(left)} left`;
  const guestShare = spentUsd > 0 ? guestUsd / spentUsd : 0;
  const period = summary.subscription
    ? `${DAY.format(summary.subscription.periodStart)} – ${DAY.format(summary.subscription.periodEnd)}`
    : null;
  const mask = { "--cells": USAGE_CELLS, "--cell-gap": "3px", "--step": "18ms" } as CSSProperties;

  return (
    <section
      className={`nt-set-section${arriving ? " nt-ws-arrive" : ""}`}
      aria-labelledby="nt-ws-usage"
    >
      <h2 id="nt-ws-usage" className="nt-set-label nt-ws-label">
        AI this period
        {period && <span className="nt-field-note">{period}</span>}
      </h2>
      <div className="nt-ws-card">
        <div className="nt-pw-strips">
          <div className={`nt-pw-strip${over > 0 || lit === 0 ? " is-out" : ""}`}>
            <div className="nt-pw-strip-head">
              <span className="nt-pw-strip-name">Included AI</span>
              <span className="nt-pw-strip-count">{said}</span>
            </div>
            <div
              className="nt-pw-mask is-arriving"
              style={mask}
              role="img"
              aria-label={`AI spent this period: ${said}`}
            >
              {Array.from({ length: USAGE_CELLS }, (_, i) => (
                <span
                  key={i}
                  className={`nt-pw-cell${i < lit ? "" : " is-spent"}`}
                  style={{ "--i": i } as CSSProperties}
                />
              ))}
            </div>
          </div>
          {over > 0 && (
            <div className="nt-pw-strip">
              <div className="nt-pw-strip-head">
                <span className="nt-pw-strip-name">Over, on the next invoice</span>
                <span className="nt-pw-strip-count">{usd(over)}</span>
              </div>
              <div
                className="nt-pw-mask is-arriving"
                style={mask}
                role="img"
                aria-label={`AI over the included amount: ${usd(over)}`}
              >
                {Array.from({ length: overCells }, (_, i) => (
                  <span key={i} className="nt-pw-cell" style={{ "--i": i + USAGE_CELLS } as CSSProperties} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="nt-ws-notes">
          {over > 0 && (
            <p className="nt-set-note">
              {usd(over)} over the included {usd(allowanceUsd)}. It’s added to the next invoice.
            </p>
          )}
          <p className="nt-set-note">
            {guestUsd > 0 ? `Guests spent ${usd(guestUsd)} of it.` : "Guests have spent nothing of it."}
            {guestCap !== null && ` Each guest can use up to ${usd(guestCap)} of AI a day.`}
          </p>
          {acts && guestShare > GUEST_SHARE_ALERT && (
            <p className="nt-set-note nt-ws-heed">
              Guests used {Math.round(guestShare * 100)}% of this period’s AI.{" "}
              <Link href={settingsPath(workspace.slug, "members")} className="nt-ws-aside-link">
                Review who has guest access
              </Link>
              .
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** An unpaid workspace's allowance, in the paywall's strips — shared by everyone in it. */
function FreeSection({
  workspace,
  left,
  arriving,
}: {
  workspace: WorkspaceContainer;
  left: Record<Meter, number>;
  arriving: boolean;
}) {
  return (
    <section
      className={`nt-set-section${arriving ? " nt-ws-arrive" : ""}`}
      aria-labelledby="nt-ws-free"
    >
      <h2 id="nt-ws-free" className="nt-set-label">
        Free allowance
      </h2>
      <div className="nt-ws-card">
        <div className="nt-pw-strips">
          {METERS.map((meter) => (
            <Strip key={meter} meter={meter} left={left[meter]} />
          ))}
        </div>
        <p className="nt-ws-notes nt-set-note">
          Shared by everyone in {workspace.name}, and it does not reset.
        </p>
      </div>
    </section>
  );
}

// ---- Seats -----------------------------------------------------------------------

function SeatsSection({ summary, people }: { summary: Summary; people: People | null }) {
  const naming = useNaming();
  const counted = people?.members.filter((m) => atLeast(m.role, "member")) ?? null;
  const guests = people ? people.members.length - (counted?.length ?? 0) : 0;
  const billed = summary.subscription?.live ? summary.subscription.seats : null;

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-seats">
      <h2 id="nt-ws-seats" className="nt-set-label nt-ws-label">
        Seats
        <span className="nt-field-note">{summary.seatsInUse} in use</span>
      </h2>
      <div className="nt-ws-table">
        <div className="nt-list-head" aria-hidden="true">
          <span className="flex-1">Who counts</span>
          <span className="nt-ws-col-role">Role</span>
        </div>
        <ul className="nt-ws-rows" aria-label="Seats in use" aria-busy={counted === null || undefined}>
          {counted === null
            ? [0, 1].map((i) => (
                <li key={i} className="nt-ws-person">
                  <span className="nt-skeleton h-8 w-8 shrink-0 rounded-full" />
                  <span className="nt-skeleton h-3.5 w-40" />
                </li>
              ))
            : counted.map((member, i) => {
                const named = naming(member);
                return (
                  <li
                    key={member.userId}
                    style={{ "--i": i } as CSSProperties}
                    className="nt-list-row nt-ws-person"
                  >
                    <Avatar member={member} named={named} />
                    <div className="nt-ws-who">
                      <span className="nt-ws-who-name">{named.name}</span>
                      {named.mail && <span className="nt-ws-who-mail">{named.mail}</span>}
                    </div>
                    <span className="nt-ws-col-role">{ROLE_LABEL[member.role]}</span>
                  </li>
                );
              })}
        </ul>
        <div className="nt-ws-notes">
          <p className="nt-set-note">
            Owners, admins and members each take a seat, and an invitation takes one once it is
            accepted. Guests don’t — they were let into projects, not the workspace.
            {guests > 0 && ` ${guests === 1 ? "The guest here is" : `The ${guests} guests here are`} not counted.`}
          </p>
          {billed !== null && billed !== summary.seatsInUse && (
            <p className="nt-set-note">
              Stripe is billing for {billed} {billed === 1 ? "seat" : "seats"}; it catches up within a
              minute of a change.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

// ---- Loading -------------------------------------------------------------------

/**
 * The page's shape while it is on its way — the plan's row, an allowance card
 * and the seats table — so nothing lands below a section that is not there
 * yet. Each bar sits in the line box of the text it stands for.
 */
function Loading() {
  return (
    <>
      <section className="nt-set-section" aria-busy="true" aria-label="Plan">
        <Bone bar="h-3.5 w-12" className="mb-2" />
        <ul className="nt-set-list">
          <li className="nt-set-row">
            <div className="nt-set-body-col">
              <div className="flex h-5 items-center">
                <div className="nt-skeleton h-3.5 w-16" />
              </div>
              <div className="mt-0.5 flex h-[18px] items-center">
                <div className="nt-skeleton h-3 w-28" />
              </div>
              <Bone bar="h-3 w-[88%]" className="mt-0.5" />
              <Bone bar="h-3 w-3/5" />
            </div>
          </li>
        </ul>
      </section>
      <section className="nt-set-section" aria-hidden="true">
        <Bone bar="h-3.5 w-28" className="mb-2" />
        <div className="nt-ws-card">
          <div className="nt-pw-strips">
            {[0, 1, 2].map((i) => (
              <div key={i}>
                <div className="mb-1.5 flex h-[19.5px] items-center justify-between">
                  <div className="nt-skeleton h-3.5 w-24" />
                  <div className="nt-skeleton h-3 w-10" />
                </div>
                <div className="nt-skeleton h-2.5" />
              </div>
            ))}
          </div>
          <Bone bar="h-3 w-3/5" className="mt-3" />
        </div>
      </section>
      <section className="nt-set-section" aria-hidden="true">
        <Bone bar="h-3.5 w-14" className="mb-2" />
        <div className="nt-ws-table">
          <div className="nt-list-head" />
          <ul className="nt-ws-rows">
            {[0, 1].map((i) => (
              <li key={i} className="nt-ws-person">
                <span className="nt-skeleton h-8 w-8 shrink-0 rounded-full" />
                <span className="nt-skeleton h-3.5 w-40" />
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
