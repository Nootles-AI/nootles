"use client";

import { useSyncExternalStore } from "react";
import type { PageProgress } from "@/app/lib/notion/importRun";
import "./notion.css";

/**
 * The two pieces an import's progress is drawn with, kept apart from the
 * wizard so the link-follow menu can say the same things in the same voice.
 */

/**
 * A 2px bar. Determinate when it has a value; without one the track is held
 * as a dashed line, a state told by shape rather than by motion.
 */
export function ProgressBar({ value, label }: { value?: number; label: string }) {
  const percent =
    value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      className="nt-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      data-indeterminate={percent === undefined ? true : undefined}
    >
      <span
        className="nt-progress-fill"
        style={percent === undefined ? undefined : { transform: `scaleX(${percent / 100})` }}
      />
    </div>
  );
}

/** The step a page is on, with how long it has been on it once that is worth saying. */
export function PageStep({ page }: { page: PageProgress }) {
  const active = page.state === "fetching" || page.state === "copying" || page.state === "writing";
  const now = useClock(active);
  const elapsed = active && page.startedAt ? now - page.startedAt : 0;
  return (
    <span className="nt-notion-step">
      <span>{stepLabel(page)}</span>
      {elapsed >= SHOW_ELAPSED_AFTER && (
        <span className="nt-notion-step-time">{clock(elapsed)}</span>
      )}
    </span>
  );
}

export function stepLabel(page: PageProgress): string {
  switch (page.state) {
    case "waiting":
      return "Waiting";
    case "fetching":
      return "Reading Notion";
    case "copying":
      return page.files ? `Copying files ${page.files.done} / ${page.files.total}` : "Copying files";
    case "writing":
      return "Writing";
    case "done":
      return `Done · ${page.blocks ?? 0} ${page.blocks === 1 ? "block" : "blocks"}`;
    case "failed":
      return page.error ? `Failed · ${page.error}` : "Failed";
    case "removed":
      return "Removed";
  }
}

/** A short step says nothing about time; only one that has run a while does. */
const SHOW_ELAPSED_AFTER = 5000;

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// The clock is an external source the component subscribes to, not state
// derived from props — hence useSyncExternalStore rather than an effect.
let now = Date.now();
let ticker: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!ticker) {
    now = Date.now();
    ticker = setInterval(() => {
      now = Date.now();
      listeners.forEach((l) => l());
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}
const read = () => now;
const still = () => 0;
const never = () => () => {};

function useClock(active: boolean): number {
  return useSyncExternalStore(active ? subscribe : never, active ? read : still, still);
}
