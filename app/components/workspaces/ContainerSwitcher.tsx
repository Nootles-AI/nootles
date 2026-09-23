"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { WorkspaceRole } from "@/convex/auth";
import { homePath, joinPath, settingsPath } from "@/app/lib/containerPaths";
import { Check, ChevronsUpDown, Plus, Settings } from "../Icons";
import { Menu, MenuItem, MenuLink } from "../Menu";
import { useContainer } from "./ContainerContext";
import { NewWorkspace } from "./NewWorkspace";
import "./workspaces.css";

const ROLE: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  guest: "Guest",
};

/** By code point, so a name that starts with an emoji keeps it whole. */
const initial = (name: string | null | undefined) =>
  (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();

/**
 * The projects home's title — and, for anyone with somewhere else to be, the
 * way between their own projects and each workspace they sit in, the doors
 * open to them, and a new workspace.
 *
 * Someone with no seat, no open door and no access to the rollout sees the
 * title they always saw and nothing else: the menu is there only once there
 * is somewhere for it to lead. Its glyph arriving later than the title moves
 * nothing (`.nt-ws-switch`), so the wait for that answer is never seen.
 */
export function ContainerSwitcher({ onProblem }: { onProblem: (text: string) => void }) {
  const router = useRouter();
  const here = useContainer();
  const { user } = useUser();
  const { isAuthenticated } = useConvexAuth();
  const ask = isAuthenticated ? {} : "skip";
  const workspaces = useQuery(api.workspaces.listMine, ask);
  const doors = useQuery(api.members.joinable, ask);
  const canCreate = useQuery(api.workspaces.canCreate, ask);
  const joinByDomain = useMutation(api.members.joinByDomain);
  const [making, setMaking] = useState(false);

  const title = here.kind === "workspace" ? here.name : "My Nootles";
  const elsewhere =
    here.kind === "workspace" || !!workspaces?.length || !!doors?.length || canCreate === true;
  if (!elsewhere) return <h1 className="nt-front-title">{title}</h1>;

  const email = user?.primaryEmailAddress?.emailAddress;
  const domain = email?.split("@")[1];
  // Guests were let into projects, not into the workspace, so its settings
  // are not theirs to open (`SettingsFrame`).
  const settings = here.kind === "workspace" && here.role !== "guest" ? here : null;

  const join = (workspaceId: Id<"workspaces">, name: string) =>
    joinByDomain({ workspaceId }).then(
      ({ slug }) => router.push(homePath(slug)),
      () => onProblem(`Couldn’t join ${name}. Ask someone there for an invitation.`),
    );

  return (
    <h1 className="nt-front-title">
      <Menu
        label="Your workspaces"
        side="bottom"
        align="center"
        className="nt-ws-switcher"
        trigger={(t) => (
          <button {...t} className="nt-ws-switch">
            <span className="nt-ws-switch-name">{title}</span>
            <ChevronsUpDown aria-hidden="true" className="nt-ws-switch-glyph" />
          </button>
        )}
      >
        {(close) => (
          <>
            <Place
              href={homePath(null)}
              name="My Nootles"
              tile={
                <span className="nt-monogram nt-ws-tile" aria-hidden="true">
                  {initial(user?.fullName || email)}
                </span>
              }
              current={here.kind === "account"}
              close={close}
            />
            {workspaces?.map((w) => (
              <Place
                key={w.workspaceId}
                href={homePath(w.slug)}
                name={w.name}
                meta={ROLE[w.role]}
                tile={<Tile name={w.name} />}
                current={here.kind === "workspace" && here.workspaceId === w.workspaceId}
                close={close}
              />
            ))}

            {!!doors?.length && <div className="nt-menu-sep" />}
            {doors?.map((door) =>
              door.token ? (
                <MenuLink key={door.workspaceId} href={joinPath(door.token)} onClick={() => close()}>
                  <Tile name={door.name} />
                  <span className="nt-ws-menu-name">Join {door.name}</span>
                  <span className="nt-ws-menu-meta">Invited</span>
                </MenuLink>
              ) : (
                <MenuItem
                  key={door.workspaceId}
                  onClick={() => {
                    close();
                    void join(door.workspaceId, door.name);
                  }}
                >
                  <Tile name={door.name} />
                  <span className="nt-ws-menu-name">Join {door.name}</span>
                  {domain && <span className="nt-ws-menu-meta">@{domain}</span>}
                </MenuItem>
              ),
            )}

            {(canCreate || settings) && <div className="nt-menu-sep" />}
            {canCreate && (
              <MenuItem
                onClick={() => {
                  // The dialog's name field takes focus as it opens; handed
                  // back to the trigger, it would be taken straight away.
                  close({ restoreFocus: false });
                  setMaking(true);
                }}
              >
                <span className="nt-ws-slot">
                  <Plus className="nt-menu-icon" />
                </span>
                New workspace…
              </MenuItem>
            )}
            {settings && (
              <MenuLink href={settingsPath(settings.slug)} onClick={() => close()}>
                <span className="nt-ws-slot">
                  <Settings className="nt-menu-icon" />
                </span>
                Workspace settings
              </MenuLink>
            )}
          </>
        )}
      </Menu>
      {making && <NewWorkspace onClose={() => setMaking(false)} />}
    </h1>
  );
}

/** A workspace's token: its initial, in a square where a person's is round. */
function Tile({ name }: { name: string }) {
  return (
    <span className="nt-monogram nt-ws-tile is-square" aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/** One place to be, ticked when it is where you are. */
function Place({
  href,
  name,
  meta,
  tile,
  current,
  close,
}: {
  href: string;
  name: string;
  meta?: string;
  tile: ReactNode;
  current: boolean;
  close: () => void;
}) {
  return (
    <MenuLink href={href} onClick={() => close()} current={current}>
      {tile}
      <span className="nt-ws-menu-name">{name}</span>
      {meta && <span className="nt-ws-menu-meta">{meta}</span>}
      <Check
        width={14}
        height={14}
        aria-hidden="true"
        className={`nt-menu-check${current ? " is-on" : ""}`}
      />
    </MenuLink>
  );
}
