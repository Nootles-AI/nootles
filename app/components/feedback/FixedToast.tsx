"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { track } from "@/app/lib/telemetry";
import { X } from "../Icons";
import "./fixed.css";

/** Derived from the query rather than restated, so it cannot drift from it. */
export type FixedReport = FunctionReturnType<
  typeof api.feedback.resolvedForMe
>[number];

/**
 * What your reports changed: everything of yours that has been fixed, and
 * which of it you have not been told about yet.
 *
 * One query behind both the toast and the standing list, so acknowledging the
 * one cannot empty the other.
 */
export function useResolved() {
  const all = useQuery(api.feedback.resolvedForMe);
  const markNotified = useMutation(api.feedback.markNotified);
  const fresh = (all ?? []).filter((f) => f.notifiedAt === null);

  const acknowledge = () => {
    if (!fresh.length) return;
    void markNotified({ ids: fresh.map((f) => f.id) }).catch(() => {});
  };

  return { all: all ?? [], fresh, loaded: all !== undefined, acknowledge };
}

/**
 * The answer coming back.
 *
 * A report leaves from the button in the bottom-left corner, so the news that
 * it was fixed arrives in the same corner, just above it. It is the only
 * unprompted good news the app delivers, which is why it is allowed a colour
 * and a little movement where the rest of the surface stays quiet.
 *
 * Said once: acknowledging it — dismissing, or opening the detail — is what
 * records the announcement. Rendering does not, because a toast that flashed
 * past during a page change was never read. What it announced does not go
 * away with it; it stays in the list behind the report button.
 */
export function FixedToast() {
  const { all, fresh, acknowledge } = useResolved();
  // Held from the moment it opens. Acknowledging clears `notifiedAt` server
  // side and the list is reactive, so reading it live would erase the "new"
  // marks out from under the person reading them.
  const [showing, setShowing] = useState<FixedReport[] | null>(null);
  const [gone, setGone] = useState(false);

  const dismiss = () => {
    track("fix_toast_dismissed", { count: fresh.length });
    acknowledge();
    setGone(true);
  };

  const openDetail = () => {
    track("fix_toast_opened", { count: fresh.length });
    setShowing(all);
    acknowledge();
    setGone(true);
  };

  const count = fresh.length;

  return (
    <>
      {count > 0 && !gone && (
        <div className="nt-fixed" role="status">
          <Mended />
          <span className="nt-fixed-said">
            We fixed {count} of your reported {count === 1 ? "issue" : "issues"}.
          </span>
          <button className="nt-fixed-go" onClick={openDetail}>
            View details
          </button>
          <button className="nt-fixed-x" aria-label="Dismiss" onClick={dismiss}>
            <X width={12} height={12} />
          </button>
        </div>
      )}
      {showing && (
        <FixedSheet items={showing} onClose={() => setShowing(null)} />
      )}
    </>
  );
}

/**
 * The list itself. Takes what it shows rather than fetching it, so it renders
 * the same whether it was opened by the toast or from the report panel — and
 * so nothing it is reading can be pulled out from under it.
 */
export function FixedSheet({
  items,
  onClose,
}: {
  items: FixedReport[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const count = items.length;

  return (
    <>
      <button className="nt-fixed-scrim" aria-label="Close" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Reports of yours that have been fixed"
        className="nt-fixed-sheet"
      >
        <div className="nt-fixed-head">
          <Mended />
          <div>
            <p className="nt-fixed-title">
              {count} {count === 1 ? "report" : "reports"} fixed
            </p>
            <p className="nt-fixed-sub">
              Thank you — every one of these came from you.
            </p>
          </div>
          <button className="nt-fixed-x ml-auto" aria-label="Close" onClick={onClose}>
            <X width={12} height={12} />
          </button>
        </div>

        {count === 0 ? (
          <p className="nt-fixed-empty">
            Nothing of yours has been fixed yet. When something is, it shows up
            here.
          </p>
        ) : (
          <ul className="nt-fixed-list">
            {items.map((f) => (
              <li key={f.id} className="nt-fixed-item">
                <span className="nt-fixed-tick" aria-hidden>
                  <svg viewBox="0 0 14 14" width="14" height="14">
                    <path
                      d="M3.4 7.3 6 9.9l4.6-5.4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
                <span className="nt-fixed-text">{f.text}</span>
                {f.notifiedAt === null && (
                  <span className="nt-fixed-new">new</span>
                )}
                <span className="nt-fixed-kind">
                  {f.kind === "issue" ? "bug" : "request"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/**
 * The mark: a ring that settles, then a check drawn through it. Both run once
 * and stop — this is a moment, not an indicator, and something still moving in
 * the corner would compete with the document forever.
 */
export function Mended() {
  return (
    <span className="nt-mended" aria-hidden>
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle className="nt-mended-ring" cx="12" cy="12" r="9.5" />
        <path className="nt-mended-check" d="M7.4 12.4 10.6 15.6 16.8 8.9" />
      </svg>
    </span>
  );
}
