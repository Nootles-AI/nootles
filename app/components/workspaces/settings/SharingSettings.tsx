"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Check, ChevronsUpDown, Clock, Code, LinkIcon } from "../../Icons";
import { Menu, MenuItem } from "../../Menu";
import { Segmented, type Segment } from "../../Segmented";
import { LIFETIMES, lifetimeLabel } from "../../share/expiry";
import type { WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";

type Switch = "off" | "on";

const LINKS: readonly Segment<Switch>[] = [
  { id: "off", label: "Off", hint: "No project here opens through a link" },
  { id: "on", label: "On", hint: "Owners and admins can share projects by link" },
];

const GUEST_CODE: readonly Segment<Switch>[] = [
  { id: "off", label: "Off", hint: "Guests never get a project’s code as context" },
  { id: "on", label: "On", hint: "A guest can be given a project’s code as context" },
];

type Patch = { linkSharing?: boolean; guestCodeAccess?: boolean; linkTtlDays?: number | null };

/**
 * How this workspace's projects reach people outside it, for its admins: whether
 * they have share links at all, how long a new one lasts, and whether a guest
 * may be let into a project's code.
 *
 * Each choice moves on the press, and a refusal puts it back. Turning links
 * off deletes nothing, which is what makes it safe to do on a press: every
 * link and everyone who came in by one stops at once, and comes back as it was
 * when links are turned on again.
 */
export function SharingSettings({ workspace }: { workspace: WorkspaceContainer }) {
  // The same subscription the workspace's route already holds.
  const live = useQuery(api.workspaces.bySlug, { slug: workspace.slug });
  const update = useMutation(api.workspaces.updateSettings).withOptimisticUpdate(
    (store, { patch }) => {
      const args = { slug: workspace.slug };
      const now = store.getQuery(api.workspaces.bySlug, args);
      if (!now) return;
      const settings = { ...now.workspace.settings };
      if (patch.linkSharing !== undefined) settings.linkSharing = patch.linkSharing;
      if (patch.guestCodeAccess !== undefined) settings.guestCodeAccess = patch.guestCodeAccess;
      if (patch.linkTtlDays !== undefined) settings.linkTtlDays = patch.linkTtlDays ?? undefined;
      store.setQuery(api.workspaces.bySlug, args, {
        ...now,
        workspace: { ...now.workspace, settings },
      });
    },
  );
  const [problem, setProblem] = useState<string | null>(null);
  if (!live) return null;

  const { linkSharing, guestCodeAccess, linkTtlDays } = live.workspace.settings;
  const lifetime = linkTtlDays ?? null;

  const save = (patch: Patch) => {
    setProblem(null);
    update({ workspaceId: workspace.workspaceId, patch }).catch((error) =>
      setProblem(refusal(error, "That didn’t save. Try again in a moment.")),
    );
  };

  return (
    <section className="nt-set-section nt-ws-policy" aria-labelledby="nt-ws-sharing">
      <h2 id="nt-ws-sharing" className="nt-set-label">
        Sharing
      </h2>
      <ul className="nt-set-list">
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <LinkIcon aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Share links</div>
              <p className="nt-set-note">
                {linkSharing
                  ? "Owners and admins can share a project by link, with people who sign in. Turning this off stops every link at once, and whoever came in through one loses access until it’s back on."
                  : `No project in ${workspace.name} opens through a link. Nothing is deleted: turning this back on brings every link back, and the people who came in by one.`}
              </p>
            </div>
            <div className="nt-set-actions">
              <Segmented
                label="Share links"
                segments={LINKS}
                value={linkSharing ? "on" : "off"}
                onChange={(to) => save({ linkSharing: to === "on" })}
                chosenSaidBelow
              />
            </div>
          </div>
        </li>
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <Clock aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Link expiry</div>
              <p className="nt-set-note">
                {lifetime === null
                  ? "New links work until they’re turned off."
                  : `New links stop working ${lifetimeLabel(lifetime)} after they’re made.`}{" "}
                Whoever shares one can change its own; links already made keep theirs.
              </p>
            </div>
            <div className="nt-set-actions">
              <Menu
                label="Link expiry"
                side="bottom"
                align="end"
                trigger={(t) => (
                  <button
                    {...t}
                    aria-label={`Link expiry, ${lifetimeLabel(lifetime)}`}
                    className="nt-row nt-ws-pick gap-1.5 px-2.5"
                  >
                    {lifetimeLabel(lifetime)}
                    <ChevronsUpDown
                      width={14}
                      height={14}
                      aria-hidden="true"
                      className="nt-ws-pick-glyph"
                    />
                  </button>
                )}
              >
                {(close) =>
                  LIFETIMES.map((days) => (
                    <MenuItem
                      key={days ?? "never"}
                      onClick={() => {
                        close();
                        if (days !== lifetime) save({ linkTtlDays: days });
                      }}
                    >
                      <span className="flex-1">{lifetimeLabel(days)}</span>
                      <Check
                        width={14}
                        height={14}
                        aria-hidden="true"
                        className={`nt-menu-check${days === lifetime ? " is-on" : ""}`}
                      />
                    </MenuItem>
                  ))
                }
              </Menu>
            </div>
          </div>
        </li>
        <li>
          <div className="nt-set-row">
            <span className="nt-set-glyph">
              <Code aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Code context for guests</div>
              <p className="nt-set-note">
                {guestCodeAccess
                  ? "Owners and admins can give a guest a project’s linked repositories as context too, one guest at a time, from the project’s share menu."
                  : "Guests get a project’s pages and documents as context, never its linked repositories."}
              </p>
            </div>
            <div className="nt-set-actions">
              <Segmented
                label="Code context for guests"
                segments={GUEST_CODE}
                value={guestCodeAccess ? "on" : "off"}
                onChange={(to) => save({ guestCodeAccess: to === "on" })}
                chosenSaidBelow
              />
            </div>
          </div>
        </li>
      </ul>
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}
