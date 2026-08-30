"use client";

import type { CSSProperties } from "react";
// From `limits.ts`, not `entitlements.ts`: these are needed as VALUES, and
// importing them from the module that registers Convex functions evaluates
// those registrations in the browser.
import { FREE_LIMITS, type Meter } from "@/convex/limits";

/**
 * The free run, drawn as a fixed mask.
 *
 * Every unit the account was given has a place on the strip, and the spent ones
 * are drawn as deliberately as the ones left — an inventory you can count,
 * rather than a bar measuring how far along you are toward being stopped. The
 * question the person is actually asking is "how many", and a length does not
 * answer that; a hundred marks do.
 *
 * All three strips are the same length and differ only in subdivision — 2, 10,
 * 100 — so the account reads as one instrument with three scales.
 */

const SAID: Record<Meter, string> = {
  projects: "Projects",
  completions: "Completions kept",
  chats: "Conversations",
};

/**
 * One height for all three, so the strips read as one instrument. Only the gap
 * changes, and it changes so that the subdivision survives the count: at a
 * hundred units a tight gap fuses the marks into a single filled bar, which is
 * the exact reading this drawing exists to refuse.
 */
const GRAIN: Record<Meter, { gap: string; step: string }> = {
  projects: { gap: "4px", step: "40ms" },
  completions: { gap: "2px", step: "4ms" },
  chats: { gap: "3px", step: "18ms" },
};

const ORDER: Meter[] = ["projects", "completions", "chats"];

export function Allowance({
  left,
  /** Draws the chase once, on arrival. Off when the strips are already up. */
  arriving = true,
  /** Reads first and loudest — the one that stopped them. */
  emphasis,
}: {
  left: Record<Meter, number>;
  arriving?: boolean;
  emphasis?: Meter | null;
}) {
  const meters = emphasis
    ? [emphasis, ...ORDER.filter((m) => m !== emphasis)]
    : ORDER;

  return (
    <div className="nt-pw-standing">
      {/* Said once, above all three, rather than implied by each line. The free
          run not refilling is the single fact that decides what these numbers
          mean, and it is not a footnote. */}
      <p className="nt-pw-label">Your free run — it does not reset</p>
      <div className="nt-pw-strips">
        {meters.map((meter) => (
          <Strip
            key={meter}
            meter={meter}
            left={left[meter]}
            arriving={arriving}
          />
        ))}
      </div>
    </div>
  );
}

export function Strip({
  meter,
  left,
  arriving = true,
}: {
  meter: Meter;
  left: number;
  arriving?: boolean;
}) {
  const of = FREE_LIMITS[meter];
  // Clamped both ways: a meter can saturate past its limit in a race, and a
  // strip cannot draw a negative number of cells.
  const remaining = Math.max(0, Math.min(of, left));
  const out = remaining === 0;
  const { gap, step } = GRAIN[meter];

  return (
    <div className={`nt-pw-strip${out ? " is-out" : ""}`}>
      <div className="nt-pw-strip-head">
        <span className="nt-pw-strip-name">{SAID[meter]}</span>
        <span className="nt-pw-strip-count">
          {out ? "all used" : `${remaining} of ${of} left`}
        </span>
      </div>
      <div
        className={`nt-pw-mask${arriving ? " is-arriving" : ""}${of > 50 ? " is-fine" : ""}`}
        style={
          {
            "--cells": of,
            "--cell-gap": gap,
            "--step": step,
          } as CSSProperties
        }
        role="img"
        aria-label={
          out
            ? `${SAID[meter]}: all ${of} used`
            : `${SAID[meter]}: ${remaining} of ${of} left`
        }
      >
        {Array.from({ length: of }, (_, i) => (
          <span
            key={i}
            className={`nt-pw-cell${i < remaining ? "" : " is-spent"}`}
            style={{ "--i": i } as CSSProperties}
          />
        ))}
      </div>
    </div>
  );
}
