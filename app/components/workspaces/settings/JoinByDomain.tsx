"use client";

import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { domainOf } from "@/convex/auth";
import { isPersonalDomain } from "@/convex/joinDomains";
import { AtSign } from "../../Icons";
import { Segmented, type Segment } from "../../Segmented";
import type { WorkspaceContainer } from "../ContainerContext";
import { refusal } from "../refusal";

type Door = "off" | "on";

const DOOR: readonly Segment<Door>[] = [
  { id: "off", label: "Off", hint: "People on these domains need an invitation, like anyone else" },
  { id: "on", label: "On", hint: "People on these domains can join as members without one" },
];

/**
 * Opening a workspace to everyone on an email domain, for its admins.
 *
 * A domain lets anyone signed in on it walk in, so the one an admin can add is
 * their own address's — holding it is the proof — and never a domain anybody
 * can sign up on. Both refusals are said up front, where the button would be,
 * rather than on pressing it. Domains already on the list stay, and any of
 * them can come off.
 *
 * Adding the first one turns joining on with it, since that is what adding it
 * is for; the switch then pauses the door without forgetting the domains.
 */
export function JoinByDomain({ workspace }: { workspace: WorkspaceContainer }) {
  const { user } = useUser();
  // The same subscription the workspace's route already holds.
  const live = useQuery(api.workspaces.bySlug, { slug: workspace.slug });
  // The switch and the list move on the press; a refusal puts them back.
  const update = useMutation(api.workspaces.updateSettings).withOptimisticUpdate(
    (store, { patch }) => {
      const args = { slug: workspace.slug };
      const now = store.getQuery(api.workspaces.bySlug, args);
      if (!now) return;
      const settings = { ...now.workspace.settings };
      if (patch.joinDomains) settings.joinDomains = patch.joinDomains;
      if (patch.autoJoin !== undefined) settings.autoJoin = patch.autoJoin;
      store.setQuery(api.workspaces.bySlug, args, {
        ...now,
        workspace: { ...now.workspace, settings },
      });
    },
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!live) return null;

  const { joinDomains: domains, autoJoin } = live.workspace.settings;
  const address = user?.primaryEmailAddress;
  const mine = address ? domainOf(address.emailAddress.toLowerCase()) : null;
  const verified = address?.verification?.status === "verified";
  const personal = !!mine && isPersonalDomain(mine);
  const offer = mine && verified && !personal && !domains.includes(mine) ? mine : null;

  const save = async (patch: { joinDomains?: string[]; autoJoin?: boolean }) => {
    setBusy(true);
    setProblem(null);
    try {
      await update({ workspaceId: workspace.workspaceId, patch });
    } catch (error) {
      setProblem(refusal(error, "That didn’t save. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  };

  // Why the only domain that could be offered is not.
  const unoffered =
    !mine || domains.includes(mine)
      ? null
      : personal
        ? `Your address is on ${mine}, which anyone can sign up for, so it can’t be a way in.`
        : !verified
          ? "Your email address isn’t verified, so its domain can’t be added."
          : null;

  return (
    <section className="nt-set-section" aria-labelledby="nt-ws-domains">
      <div className="nt-ws-set-head">
        <h2 id="nt-ws-domains" className="nt-set-label">
          Join by email domain
        </h2>
        {domains.length > 0 && (
          <Segmented
            label="Join by email domain"
            segments={DOOR}
            value={autoJoin ? "on" : "off"}
            onChange={(door) => void save({ autoJoin: door === "on" })}
          />
        )}
      </div>
      <ul className="nt-set-list">
        {domains.map((domain) => (
          <li key={domain}>
            <div className="nt-set-row">
              <span className="nt-set-glyph">
                <AtSign aria-hidden="true" />
              </span>
              <div className="nt-set-body-col">
                <div className="nt-set-name">{domain}</div>
                <p className="nt-set-note">
                  {autoJoin
                    ? `Anyone signed in with a verified @${domain} address can join as a member, from their workspace menu.`
                    : `Paused. People on ${domain} need an invitation, like anyone else.`}
                </p>
              </div>
              <div className="nt-set-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save({ joinDomains: domains.filter((d) => d !== domain) })}
                  aria-label={`Remove ${domain}`}
                  className="nt-row px-2.5"
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        ))}
        {offer && (
          <li>
            <div className="nt-set-row">
              <span className="nt-set-glyph">
                <AtSign aria-hidden="true" />
              </span>
              <div className="nt-set-body-col">
                <div className="nt-set-name">{offer}</div>
                <p className="nt-set-note">
                  Let anyone signed in with a verified @{offer} address join as a member,
                  without an invitation. Yours is the only domain you can add: being on it is
                  the proof it’s your team’s.
                </p>
              </div>
              <div className="nt-set-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void save({
                      joinDomains: [...domains, offer],
                      ...(domains.length ? {} : { autoJoin: true }),
                    })
                  }
                  className="nt-row nt-solid px-3 font-medium"
                >
                  Add
                </button>
              </div>
            </div>
          </li>
        )}
        {!offer && domains.length === 0 && (
          <li>
            <div className="nt-set-row">
              <span className="nt-set-glyph">
                <AtSign aria-hidden="true" />
              </span>
              <div className="nt-set-body-col">
                <p className="nt-set-note">
                  {unoffered ??
                    "Let colleagues join without an invitation, by the domain of their work address."}{" "}
                  A domain can only be added by an admin signed in with an address on it.
                </p>
              </div>
            </div>
          </li>
        )}
      </ul>
      {unoffered && domains.length > 0 && <p className="nt-set-note mt-2">{unoffered}</p>}
      {problem && (
        <p role="alert" className="nt-set-problem">
          {problem}
        </p>
      )}
    </section>
  );
}
