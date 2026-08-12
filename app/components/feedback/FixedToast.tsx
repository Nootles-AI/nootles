"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { track } from "@/app/lib/telemetry";
import { X } from "../Icons";
import "./fixed.css";

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
 * past during a page change was never read.
 */
export function FixedToast() {
  const fixed = useQuery(api.feedback.resolvedForMe);
  const markNotified = useMutation(api.feedback.markNotified);
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);

  const acknowledge = () => {
    if (!fixed?.length) return;
    void markNotified({ ids: fixed.map((f) => f.id) }).catch(() => {});
  };

  const dismiss = () => {
    track("fix_toast_dismissed", { count: fixed?.length ?? 0 });
    acknowledge();
    setGone(true);
  };

  const openDetail = () => {
    track("fix_toast_opened", { count: fixed?.length ?? 0 });
    acknowledge();
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!fixed?.length || (gone && !open)) return null;

  const count = fixed.length;

  return (
    <>
      {!gone && (
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

      {open && (
        <>
          <button
            className="nt-fixed-scrim"
            aria-label="Close"
            onClick={() => {
              setOpen(false);
              setGone(true);
            }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Reports that have been fixed"
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
              <button
                className="nt-fixed-x ml-auto"
                aria-label="Close"
                onClick={() => {
                  setOpen(false);
                  setGone(true);
                }}
              >
                <X width={12} height={12} />
              </button>
            </div>

            <ul className="nt-fixed-list">
              {fixed.map((f) => (
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
                  <span className="nt-fixed-kind">
                    {f.kind === "issue" ? "bug" : "request"}
                  </span>
                </li>
              ))}
            </ul>

            <p className="nt-fixed-foot">
              Reload to pick up the latest build if you have had this tab open a
              while.
            </p>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The mark: a ring that settles, then a check drawn through it. Both run once
 * and stop — this is a moment, not an indicator, and something still moving in
 * the corner would compete with the document forever.
 */
function Mended() {
  return (
    <span className="nt-mended" aria-hidden>
      <svg viewBox="0 0 24 24" width="22" height="22">
        <circle className="nt-mended-ring" cx="12" cy="12" r="9.5" />
        <path className="nt-mended-check" d="M7.4 12.4 10.6 15.6 16.8 8.9" />
      </svg>
    </span>
  );
}
