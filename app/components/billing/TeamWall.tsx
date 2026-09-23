"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { atLeast } from "@/convex/auth";
import { FREE_LIMITS, type Meter } from "@/convex/limits";
import { settingsPath } from "@/app/lib/containerPaths";
import { useStandIn } from "../StandIn";
import { Strip } from "./Allowance";
import "./paywall.css";

/** What stopped them, said of the workspace whose allowance it was. */
function stopped(meter: Meter, name: string): { title: string; body: string } {
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

/**
 * The wall in a workspace: the paywall's sheet and voice, at the sentence that
 * stopped them, but about the workspace's allowance rather than their own —
 * nothing here is for sale to one person. Whoever can start the Team plan is
 * taken to the workspace's billing; anyone else is told who can.
 */
export function TeamWall({
  meter,
  workspaceId,
  name,
  back,
  onClose,
}: {
  meter: Meter;
  workspaceId: Id<"workspaces">;
  name: string;
  /** The dismissal, named after the place it returns to. */
  back: string;
  onClose: () => void;
}) {
  const standIn = useStandIn();
  const seats = useQuery(api.workspaces.listMine, {});
  const seat = seats?.find((s) => s.workspaceId === workspaceId) ?? null;
  const starts = !standIn && seat !== null && atLeast(seat.role, "admin");
  const said = stopped(meter, name);

  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
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

  return createPortal(
    <>
      <button
        aria-label="Close"
        onClick={onClose}
        className="nt-pw-scrim"
        style={{ zIndex: "var(--z-overlay)" }}
      />
      <div className="nt-pw-holder" style={{ zIndex: "var(--z-modal)" }}>
        <div className="nt-pw-sheet" role="dialog" aria-modal aria-label={said.title}>
          <div className="nt-pw-field">
            <p className="nt-pw-title">{said.title}</p>
            <p className="nt-pw-lede">
              {said.body}{" "}
              {starts
                ? `The Team plan lifts the limit for everyone in ${name}.`
                : seat
                  ? `An owner or an admin of ${name} can start the Team plan, which lifts it for everyone.`
                  : `Whoever runs ${name} can start the Team plan, which lifts it for everyone.`}
            </p>
            <div className="mt-5">
              <Strip meter={meter} left={0} />
            </div>
            <div className="nt-pw-answers">
              <button
                type="button"
                autoFocus={!starts}
                onClick={onClose}
                className="nt-pw-btn"
              >
                {back}
              </button>
              {starts && seat && (
                <Link
                  href={settingsPath(seat.slug, "billing")}
                  autoFocus
                  className="nt-pw-btn is-solid"
                >
                  Start the Team plan
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
