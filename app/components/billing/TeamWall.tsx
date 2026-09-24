"use client";

import { useEffect, useRef, useState, type AnimationEvent } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { atLeast } from "@/convex/auth";
import { FREE_LIMITS, type Meter } from "@/convex/limits";
import { settingsPath } from "@/app/lib/containerPaths";
import { useModalFocus } from "../Dialog";
import { useStandIn } from "../StandIn";
import { Strip } from "./Allowance";
import "./paywall.css";

type Seat = NonNullable<FunctionReturnType<typeof api.workspaces.listMine>>[number];

/** What stopped them, said of the workspace whose allowance it was. */
export function stopped(meter: Meter, name: string): { title: string; body: string } {
  switch (meter) {
    case "projects":
      return {
        title: `${name} has used both its free projects`,
        body: "Everything already here stays exactly as it is.",
      };
    case "completions":
      return {
        title: `${name} has kept all ${FREE_LIMITS.completions} of its free completions`,
        body: "The editor works as it always did — the suggestions are what stopped.",
      };
    case "chats":
      return {
        title: `${name} has used its ${FREE_LIMITS.chats} free chats`,
        body: "The ones already started still work.",
      };
  }
}

type WallProps = {
  meter: Meter;
  workspaceId: Id<"workspaces">;
  name: string;
  /** The dismissal, named after the place it returns to. */
  back: string;
  onClose: () => void;
};

/**
 * The wall in a workspace: the paywall's sheet and voice, at the sentence that
 * stopped them, but about the workspace's allowance rather than their own —
 * nothing here is for sale to one person. Whoever can start the Team plan is
 * taken to the workspace's billing; another member to its people, where the
 * owners and admins who can are named; a guest, who can see neither, to
 * whoever shared the project.
 *
 * Drawn once their seat is known, as `PlanWall` waits on the standing: the
 * sentence and the button that takes focus both depend on it, and neither may
 * change after the sheet has arrived.
 */
export function TeamWall(props: WallProps) {
  const seat = useSeat(props.workspaceId);
  if (seat === undefined) return null;
  return <Sheet {...props} seat={seat} />;
}

/** Your seat in the workspace — null for a guest, undefined until it is known. */
function useSeat(workspaceId: Id<"workspaces">): Seat | null | undefined {
  const seats = useQuery(api.workspaces.listMine, {});
  if (seats === undefined) return undefined;
  return seats?.find((s) => s.workspaceId === workspaceId) ?? null;
}

/** Why the Team plan is the way on, said to whoever can or cannot start it. */
function lede(starts: boolean, seat: Seat | null): string {
  return starts
    ? "The Team plan lifts the limit for everyone in this workspace."
    : seat
      ? "Only an owner or an admin can start the Team plan, which lifts the limit for everyone in this workspace."
      : "This project belongs to that workspace. The person who shared it with you can ask one of its owners or admins to start the Team plan, which lifts the limit.";
}

/** Where the way on goes: the plan, for whoever can start it; the people who can, for anyone else. */
function wayOn(seat: Seat, starts: boolean) {
  return {
    href: settingsPath(seat.slug, starts ? "billing" : "members"),
    label: starts ? "See the Team plan" : "See who can start it",
  };
}

/**
 * The wall where a form is still being written — the palette's side, beside a
 * New project whose workspace has no projects left: the same sentence, strip
 * and way on as the sheet, standing where the picture of what would be made
 * was, so nobody writes a project out only to be stopped at its Create.
 */
export function TeamWallPane({
  meter,
  workspaceId,
  name,
}: {
  meter: Meter;
  workspaceId: Id<"workspaces">;
  name: string;
}) {
  const seat = useSeat(workspaceId);
  const standIn = useStandIn();
  if (seat === undefined) return null;
  const starts = !standIn && seat !== null && atLeast(seat.role, "admin");
  const said = stopped(meter, name);
  const on = seat && wayOn(seat, starts);
  return (
    <div className="nt-pw-pane">
      <p className="nt-pw-title">{said.title}</p>
      <p className="nt-pw-lede">
        {said.body} {lede(starts, seat)}
      </p>
      <div className="mt-5">
        <Strip meter={meter} left={0} />
      </div>
      {on && (
        <div className="nt-pw-answers">
          <Link href={on.href} className="nt-pw-btn is-solid">
            {on.label}
          </Link>
        </div>
      )}
    </div>
  );
}

function Sheet({ meter, name, back, onClose, seat }: WallProps & { seat: Seat | null }) {
  const standIn = useStandIn();
  const starts = !standIn && seat !== null && atLeast(seat.role, "admin");
  const said = stopped(meter, name);
  const on = seat && wayOn(seat, starts);

  const sheet = useRef<HTMLDivElement>(null);
  const go = useRef<HTMLAnchorElement>(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    // Without motion no animation ends, so there is nothing to wait for.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) onClose();
    else setClosing(true);
  };
  const gone = (e: AnimationEvent<HTMLDivElement>) => {
    if (closing && e.target === e.currentTarget) onClose();
  };

  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    // Heard first and kept, as the paywall's own: an Escape closes the wall
    // and leaves whatever it was raised over as it was.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  // A link is not autofocused by React, and the way on is the one to land on.
  // Before the modal's own focus, which would otherwise take the sheet.
  useEffect(() => {
    go.current?.focus();
  }, []);
  const keepFocus = useModalFocus(sheet);

  return createPortal(
    <>
      <button
        aria-label="Close"
        onClick={close}
        className={`nt-pw-scrim${closing ? " is-closing" : ""}`}
        // The modal layer, as the holder: on a phone the wall rises from the
        // chat drawer, which sits there too, and a later sibling paints over it.
        style={{ zIndex: "var(--z-modal)" }}
      />
      <div className="nt-pw-holder" style={{ zIndex: "var(--z-modal)" }}>
        <div
          ref={sheet}
          className={`nt-pw-sheet${closing ? " is-closing" : ""}`}
          role="dialog"
          aria-modal
          aria-label={said.title}
          tabIndex={-1}
          inert={closing}
          onKeyDown={keepFocus}
          onAnimationEnd={gone}
        >
          <div className="nt-pw-field">
            <p className="nt-pw-title">{said.title}</p>
            <p className="nt-pw-lede">
              {said.body} {lede(starts, seat)}
            </p>
            <div className="mt-5">
              <Strip meter={meter} left={0} />
            </div>
            <div className="nt-pw-answers">
              <button type="button" autoFocus={!seat} onClick={close} className="nt-pw-btn">
                {back}
              </button>
              {on && (
                <Link ref={go} href={on.href} className="nt-pw-btn is-solid">
                  {on.label}
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
