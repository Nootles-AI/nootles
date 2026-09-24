"use client";

import { useEffect, useState } from "react";
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
/** Workspaces whose people have been drawn arriving in this tab already. */
const met = new Set<string>();

/**
 * Who else is in the workspace, drawn the way the presence pile draws who is
 * on a page, and the way to the full list of them. You are left out, as the
 * presence pile leaves you out: you are already at the head of the header, as
 * the account's monogram, and a workspace with only you in it has nobody to
 * show — so it shows nothing.
 *
 * Absent for a guest — `members.list` tells guests nothing about who else is
 * here. Until it answers, the first face's seat is held, so the faces land in
 * room already made for them; with nobody to put in it, the seat folds away.
 * The faces arrive one by one the first time a workspace opens, and are
 * simply there when you come back to it.
 */
export function MembersPile({ workspace }: { workspace: WorkspaceContainer }) {
  const { isAuthenticated } = useConvexAuth();
  const naming = useNaming();
  const people = useQuery(
    api.members.list,
    isAuthenticated ? { workspaceId: workspace.workspaceId } : "skip",
  );
  const id = workspace.workspaceId;
  const [first, setFirst] = useState(() => ({ id, fresh: !met.has(id) }));
  if (first.id !== id) setFirst({ id, fresh: !met.has(id) });
  const others = people?.members.filter((m) => !m.isMe) ?? [];
  const drawn = others.length > 0;
  useEffect(() => {
    if (drawn) met.add(id);
  }, [drawn, id]);

  if (!drawn) {
    const gone = people !== undefined;
    return <span className={`nt-ws-pile is-waiting${gone ? " is-gone" : ""}`} aria-hidden="true" />;
  }
  const name = (m: (typeof others)[number]) => naming(m).name;
  // "+1" would take the very seat the next face fits in; show the face.
  const shown = others.length <= SHOWN + 1 ? others : others.slice(0, SHOWN);
  const rest = others.slice(shown.length);
  const restNames = rest.slice(0, NAMED).map(name);
  if (rest.length > NAMED) restNames.push(`and ${rest.length - NAMED} more`);

  return (
    <Link
      href={settingsPath(workspace.slug, "members")}
      aria-label={`Members of ${workspace.name}: ${people?.members.length}`}
      className={`nt-ws-pile${first.fresh ? "" : " is-known"}`}
    >
      <span className="nt-facepile">
        {shown.map((m) => (
          <Face key={m.userId} user={{ name: name(m), imageUrl: m.imageUrl }} />
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
