"use client";

import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { settingsPath } from "@/app/lib/containerPaths";
import { Face } from "../presence/Facepile";
import type { WorkspaceContainer } from "./ContainerContext";
import { useNaming } from "./people";
import "./workspaces.css";

/** Faces before the rest become a count. */
const SHOWN = 4;
/** A tooltip is a list, not a roster; past this it says "and N more". */
const NAMED = 12;

/**
 * Who is in the workspace, drawn the way the presence pile draws who is on a
 * page, and the way to the full list of them. You appear as your monogram, as
 * everywhere else you see yourself; everyone else as their photo.
 *
 * Absent for a guest — `members.list` tells guests nothing about who else is
 * here. Until it answers, the first face's seat is held, so the faces land in
 * room already made for them.
 */
export function MembersPile({ workspace }: { workspace: WorkspaceContainer }) {
  const { isAuthenticated } = useConvexAuth();
  const naming = useNaming();
  const people = useQuery(
    api.members.list,
    isAuthenticated ? { workspaceId: workspace.workspaceId } : "skip",
  );
  if (people === undefined) return <span className="nt-ws-pile is-waiting" aria-hidden="true" />;
  if (!people) return null;

  const { members } = people;
  const name = (m: (typeof members)[number]) => naming(m).name;
  // "+1" would take the very seat the next face fits in; show the face.
  const shown = members.length <= SHOWN + 1 ? members : members.slice(0, SHOWN);
  const rest = members.slice(shown.length);
  const restNames = rest.slice(0, NAMED).map(name);
  if (rest.length > NAMED) restNames.push(`and ${rest.length - NAMED} more`);

  return (
    <Link
      href={settingsPath(workspace.slug, "members")}
      aria-label={`Members of ${workspace.name}: ${members.length}`}
      className="nt-ws-pile"
    >
      <span className="nt-facepile">
        {shown.map((m) => (
          <Face key={m.userId} user={{ name: name(m), imageUrl: m.isMe ? null : m.imageUrl }} />
        ))}
        {rest.length > 0 && (
          <span className="nt-face is-count" title={restNames.join("\n")}>
            +{rest.length}
          </span>
        )}
      </span>
    </Link>
  );
}
