"use client";

import { useRef, useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { X } from "../../Icons";
import { initial, type Named } from "../people";

type Member = NonNullable<FunctionReturnType<typeof api.members.list>>["members"][number];

/**
 * Room taken and given back over time (`.nt-fold`): open, it holds what it
 * wraps; shut, it keeps drawing it while it closes, and goes inert so nothing
 * in it can be reached. `arriving` opens it as it mounts.
 */
export function Fold({
  open = true,
  arriving,
  className = "",
  children,
}: {
  open?: boolean;
  arriving?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`nt-fold${arriving ? " is-arriving" : ""}${className ? ` ${className}` : ""}`}
      data-open={open}
      inert={!open}
    >
      <div className="nt-fold-body">{children}</div>
    </div>
  );
}

/**
 * One of a row's two sentences, folded open while it is the true one: the
 * other shuts as it opens, so the card changes height once, over time.
 */
export function Said({ open, children }: { open: boolean; children: ReactNode }) {
  return (
    <Fold open={open}>
      <p className="nt-set-note">{children}</p>
    </Fold>
  );
}

/**
 * A refusal, folding open as it arrives and settling into place, so what is
 * under it is moved rather than thrown; it folds shut again once it is
 * cleared, still saying what it said. A new sentence settles in again. Drawn
 * as a settings section's problem line unless `className` says otherwise.
 */
export function Problem({
  text,
  id,
  className = "nt-set-problem nt-settle",
}: {
  text: string | null;
  id?: string;
  className?: string;
}) {
  const [said, setSaid] = useState(text);
  if (text && text !== said) setSaid(text);
  if (!said) return null;
  return (
    <Fold arriving open={!!text}>
      <p key={said} id={id} role="alert" className={className}>
        {said}
      </p>
    </Fold>
  );
}

/**
 * How a round trip ended, said in the row it is about until it is dismissed.
 * Dismissed, it folds shut before it goes, so the card shortens rather than
 * snapping, and focus waits on its row. Without `onDismiss` it stays.
 */
export function Outcome({
  text,
  problem = false,
  onDismiss,
}: {
  text: string;
  problem?: boolean;
  onDismiss?: (() => void) | null;
}) {
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
      className="nt-fold"
      data-open={!leaving}
      inert={leaving}
      onTransitionEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.propertyName === "grid-template-rows") {
          onDismiss?.();
        }
      }}
    >
      <div className="nt-fold-body">
        <div
          key={text}
          role={problem ? "alert" : "status"}
          className={`nt-set-outcome ${problem ? "nt-set-problem" : "nt-set-note"}`}
        >
          <span>{text}</span>
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

/** A bar in the line box of the 13px text it stands for. */
export function Bone({ bar, className = "" }: { bar: string; className?: string }) {
  return (
    <div className={`nt-ws-bone flex h-[19.5px] items-center ${className}`}>
      <div className={`nt-skeleton ${bar}`} />
    </div>
  );
}

/**
 * You as your monogram, as everywhere you see yourself; everyone else as their
 * photo. The monogram is the first letter of what the row calls them, which
 * is what the home's pile draws too.
 */
export function Avatar({ member, named }: { member: Member; named: Named }) {
  if (member.imageUrl && !member.isMe) {
    return (
      // Not next/image: Clerk's avatar hosts are not the optimizer's to fetch.
      // eslint-disable-next-line @next/next/no-img-element
      <img src={member.imageUrl} alt="" className="h-8 w-8 shrink-0 rounded-full" />
    );
  }
  return (
    <span className="nt-monogram is-lg shrink-0" aria-hidden="true">
      {initial(named.name)}
    </span>
  );
}
