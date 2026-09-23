"use client";

import { useState, type CSSProperties } from "react";
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
import { Avatar } from "./MembersSettings";
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
  const standIn = useStandIn();
  const args = { workspaceId: workspace.workspaceId };
  const summary = useQuery(api.teamBilling.summary, args);
  const standing = useQuery(api.entitlements.forContainer, args);
  const people = useQuery(api.members.list, args);

  if (summary === undefined) return <Loading />;
  // A guest, or a seat that has just gone: the frame moves them on.
  if (summary === null) return null;
  const acts = !standIn && summary.canManage;

  return (
    <>
      <PlanSection workspace={workspace} summary={summary} acts={acts} outcome={outcome} />
      {summary.usage ? (
        <UsageSection
          summary={summary}
          usage={summary.usage}
          guestCap={standing?.features.guestDailyAiUsd ?? null}
        />
      ) : (
        standing?.entitlement.left && (
          <FreeSection workspace={workspace} left={standing.entitlement.left} />
        )
      )}
      <SeatsSection summary={summary} people={people ?? null} />
    </>
  );
}

// ---- The plan ----------------------------------------------------------------

function PlanSection({
  workspace,
  summary,
  acts,
  outcome,
}: {
  workspace: WorkspaceContainer;
  summary: Summary;
  acts: boolean;
  outcome: string | null;
}) {
  const router = useRouter();
  const startCheckout = useAction(api.billing.startTeamCheckout);
  const manage = useAction(api.billing.manageTeam);
  const [busy, setBusy] = useState<"start" | "manage" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [told, setTold] = useState(outcome === "done" || outcome === "cancelled");

  const { subscription, plan, source } = summary;
  const live = subscription?.live ?? false;
  const paid = source !== "none";
  const starts = !paid && !summary.unsettled && summary.configured;

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

  const dismiss = () => {
    setTold(false);
    // The cue has been said; a reload should not say it again.
    router.replace(settingsPath(workspace.slug, "billing"), { scroll: false });
  };

  // Stripe's return is only the cue: what is said follows the mirror, so a
  // payment the webhook has not reported yet is named as exactly that.
  const line =
    told && outcome === "cancelled"
      ? "Checkout was cancelled. Nothing was charged."
      : told && outcome === "done"
        ? live
          ? `${workspace.name} is on the Team plan. Everything is open.`
          : "Stripe has your payment. This opens up the moment Stripe tells us — usually a second or two."
        : null;

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-plan">
      <h2 id="nt-ws-plan" className="nt-set-label">
        Plan
      </h2>
      <ul className="nt-set-list">
        <li className="nt-set-row">
          <div className="nt-set-body-col">
            <p className="nt-set-name">{PLAN_LABEL[plan]}</p>
            <p className="nt-set-meta">{standingLine(summary)}</p>
            <p className="nt-set-note">{planNote(workspace, summary)}</p>
            {!paid && !summary.configured && (
              <p className="nt-set-note">Team billing isn’t set up on this deployment.</p>
            )}
            {line && (
              <div role="status" className="nt-set-outcome nt-set-note">
                <span>{line}</span>
                <button type="button" onClick={dismiss} aria-label="Dismiss" className="nt-icon-btn is-sm">
                  <X />
                </button>
              </div>
            )}
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
      {!acts && !paid && summary.configured && (
        <p className="nt-ws-notes nt-set-note">
          {summary.unsettled
            ? "Only an owner or an admin can settle its billing."
            : "Only an owner or an admin can start the Team plan."}
        </p>
      )}
    </section>
  );
}

/** The plan's state in one mono line: how it stands and until when. */
function standingLine({ source, subscription, unsettled }: Summary): string {
  if (source === "override") return "Granted";
  if (!subscription) return "Not started";
  if (unsettled) return subscription.status === "paused" ? "Paused" : "Unpaid";
  const until = WHEN.format(subscription.periodEnd);
  if (!subscription.live) return `Ended ${until}`;
  if (subscription.status === "past_due") return "Payment past due";
  if (subscription.cancelAtPeriodEnd) return `Ends ${until}`;
  if (subscription.status === "trialing") return `Trial · ends ${until}`;
  return `Renews ${until}`;
}

function planNote(
  workspace: WorkspaceContainer,
  { source, subscription, unsettled }: Summary,
): string {
  if (source === "override") return "Nootles granted this plan. Nothing here is billed.";
  if (unsettled) {
    return (
      `${workspace.name}’s subscription is still open in Stripe, but not paid up, ` +
      "so everyone shares the free allowance. Manage billing settles it."
    );
  }
  if (subscription?.live && subscription.status === "past_due") {
    return (
      "Stripe couldn’t take the last payment and is trying the card again. " +
      "Nothing is locked while it does."
    );
  }
  if (subscription?.live) {
    return "Billed monthly for each seat, and each seat brings its share of AI. Spend past it is billed as usage.";
  }
  return (
    `Everyone in ${workspace.name} shares one free allowance. ` +
    "The Team plan lifts it, for a monthly price per seat."
  );
}

// ---- This period's AI ----------------------------------------------------------

function UsageSection({
  summary,
  usage,
  guestCap,
}: {
  summary: Summary;
  usage: NonNullable<Summary["usage"]>;
  guestCap: number | null;
}) {
  const { allowanceUsd, spentUsd, guestUsd } = usage;
  const over = spentUsd > allowanceUsd;
  // Rounded up, so a sliver still left is a cell still lit: "all used" is
  // said only when it is so.
  const left = Math.max(0, allowanceUsd - spentUsd);
  const lit = allowanceUsd > 0 ? Math.ceil((left / allowanceUsd) * USAGE_CELLS) : 0;
  const said = over
    ? `${usd(spentUsd)} · ${usd(spentUsd - allowanceUsd)} past it`
    : `${usd(spentUsd)} of ${usd(allowanceUsd)}`;
  const guestShare = spentUsd > 0 ? guestUsd / spentUsd : 0;
  const period = summary.subscription
    ? `${DAY.format(summary.subscription.periodStart)} – ${DAY.format(summary.subscription.periodEnd)}`
    : null;

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-usage">
      <h2 id="nt-ws-usage" className="nt-set-label nt-ws-label">
        AI this period
        {period && <span className="nt-field-note">{period}</span>}
      </h2>
      <div className="nt-ws-card">
        <div className={`nt-pw-strip${over || lit === 0 ? " is-out" : ""}`}>
          <div className="nt-pw-strip-head">
            <span className="nt-pw-strip-name">Included with the seats</span>
            <span className="nt-pw-strip-count">{said}</span>
          </div>
          <div
            className="nt-pw-mask is-arriving"
            style={
              { "--cells": USAGE_CELLS, "--cell-gap": "3px", "--step": "18ms" } as CSSProperties
            }
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
        <div className="nt-ws-notes">
          <p className="nt-set-note">
            {usd(summary.allowancePerSeatUsd)} a seat each period.{" "}
            {over
              ? "What is past it is billed as usage, reported to Stripe each night."
              : "Past it, spend is billed as usage."}
          </p>
          <p className="nt-set-note">
            {guestUsd > 0 ? `Guests spent ${usd(guestUsd)} of it.` : "Guests have spent nothing of it."}
            {guestCap !== null && ` Each is held to ${usd(guestCap)} a day.`}
          </p>
          {guestShare > GUEST_SHARE_ALERT && (
            <p role="status" className="nt-set-problem">
              Guests are {Math.round(guestShare * 100)}% of this period’s spend — more than a quarter
              of it on people who hold no seat.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/** An unpaid workspace's allowance, in the paywall's strips — shared by everyone in it. */
function FreeSection({ workspace, left }: { workspace: WorkspaceContainer; left: Record<Meter, number> }) {
  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-free">
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
      </div>
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
    </section>
  );
}

// ---- Loading -------------------------------------------------------------------

function Loading() {
  return (
    <section className="nt-set-section" aria-busy="true" aria-label="Plan">
      <div className="nt-ws-bone mb-2 flex h-[19.5px] items-center">
        <div className="nt-skeleton h-3.5 w-12" />
      </div>
      <div className="nt-ws-card">
        <div className="nt-skeleton h-3.5 w-16" />
        <div className="nt-skeleton mt-2 h-3 w-28" />
        <div className="nt-skeleton mt-3 h-3 w-[80%]" />
      </div>
    </section>
  );
}
