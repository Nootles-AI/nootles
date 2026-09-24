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
import { Problem, Said } from "./parts";

type Switch = "off" | "on";

const LINKS: readonly Segment<Switch>[] = [
  { id: "off", label: "Off", hint: "Every link stops, and guests lose access until it’s back on" },
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
              <Said open={linkSharing}>
                Owners and admins can share projects by link with anyone who signs in. Turning
                this off pauses every link and locks out everyone who joined by one. Nothing is
                deleted.
              </Said>
              <Said open={!linkSharing}>
                No project in {workspace.name} can be opened by link right now. Turn this back on
                to restore every link and the people who joined through them.
              </Said>
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
          {/* With links off there is nothing for it to govern, so it rests, and says why. */}
          <div className={`nt-set-row nt-ws-rests${linkSharing ? "" : " is-resting"}`}>
            <span className="nt-set-glyph">
              <Clock aria-hidden="true" />
            </span>
            <div className="nt-set-body-col">
              <div className="nt-set-name">Link expiry</div>
              <p className="nt-set-note">
                <span key={lifetime ?? "never"} className="nt-ws-swap">
                  {lifetime === null
                    ? "New links never expire."
                    : `New links expire ${lifetimeLabel(lifetime)} after they’re made.`}
                </span>{" "}
                {linkSharing
                  ? "Existing links keep their own, and whoever shares a link can change it."
                  : "It applies once share links are back on."}
              </p>
            </div>
            <div className="nt-set-actions">
              <Menu
                label="Link expiry"
                side="bottom"
                align="end"
                className="nt-ws-choices"
                trigger={(t) => (
                  <button
                    {...t}
                    disabled={!linkSharing}
                    aria-label={`Link expiry, ${lifetimeLabel(lifetime)}`}
                    // Its glyph on the segmented controls' edge; the hover
                    // wash pads out past it.
                    className="nt-row nt-ws-pick -mr-2 gap-1.5 px-2"
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
                      className="nt-ws-choice"
                      onClick={() => {
                        close();
                        if (days !== lifetime) save({ linkTtlDays: days });
                      }}
                    >
                      <span className="nt-ws-choice-text">
                        <span>{lifetimeLabel(days)}</span>
                        <span className="nt-ws-choice-hint">
                          {days === null
                            ? "Links last until they’re turned off"
                            : `Links expire ${lifetimeLabel(days)} after they’re made`}
                        </span>
                      </span>
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
              <Said open={guestCodeAccess}>
                Owners and admins can give a guest a project’s linked repositories as context too,
                one guest at a time, from the project’s share menu.
              </Said>
              <Said open={!guestCodeAccess}>
                Guests get a project’s pages and documents as context, never its linked
                repositories.
              </Said>
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
      <Problem text={problem} />
    </section>
  );
}
