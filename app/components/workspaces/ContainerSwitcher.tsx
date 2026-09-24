"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth, useUser } from "@clerk/nextjs";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { homePath, joinPath, settingsPath } from "@/app/lib/containerPaths";
import { rememberWorkspace } from "@/app/lib/projectsCache";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { ChevronsUpDown, PersonPlus, Plus, Settings } from "../Icons";
import { Menu, MenuItem, MenuLink } from "../Menu";
import { useStandIn } from "../StandIn";
import { useContainer } from "./ContainerContext";
import { NewWorkspace } from "./NewWorkspace";
import { Place, Tile, YouTile } from "./places";
import { ROLE_LABEL } from "./seats";
import { TitleTile } from "./WorkspaceIcon";
import "./workspaces.css";

/**
 * The title the last switcher drew. Each place's home is its own route, so the
 * switcher is drawn anew on each; this is how the new one knows the place changed.
 */
let lastTitle: string | null = null;

/**
 * The projects home's title — and, for anyone with somewhere else to be, the
 * way between their own projects and each workspace they sit in, the doors
 * open to them, and a new workspace.
 *
 * Someone with no seat, no open door and no access to the rollout sees the
 * title they always saw and nothing else: the menu is there only once there
 * is somewhere for it to lead. Its glyph arriving later than the title moves
 * nothing (`.nt-ws-switch`), so the wait for that answer is never seen.
 *
 * Every workspace it lists is told to this browser's cache as it answers, so
 * whichever one is picked draws at once, as a home already visited does,
 * rather than waiting to be told what its address is (`ContainerRoute`).
 */
export function ContainerSwitcher({
  onProblem,
  onInvite,
}: {
  onProblem: (text: string) => void;
  /** Opens the palette on its invite page. */
  onInvite: () => void;
}) {
  const router = useRouter();
  const here = useContainer();
  const { user } = useUser();
  const { userId } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const standIn = useStandIn();
  const ask = isAuthenticated ? {} : "skip";
  const workspaces = useQuery(api.workspaces.listMine, ask);
  // Walking through one is a write, which an operator standing in is refused.
  const doors = useQuery(api.members.joinable, isAuthenticated && !standIn ? {} : "skip");
  const canCreate = useQuery(api.workspaces.canCreate, ask);
  const joinByDomain = useMutation(api.members.joinByDomain);
  const [making, setMaking] = useState(false);
  const [joining, setJoining] = useState<Id<"workspaces"> | null>(null);
  const phone = useMediaQuery("(max-width: 36rem)");
  const trigger = useRef<{ focus: () => void }>(null);

  useEffect(() => {
    if (!userId || !workspaces) return;
    for (const { workspaceId, slug, name, role, icon } of workspaces) {
      rememberWorkspace(userId, slug, { kind: "workspace", workspaceId, slug, name, role, icon });
    }
  }, [userId, workspaces]);

  const title = here.kind === "workspace" ? here.name : "My Nootles";
  // Another place picked: the name arrives rather than being there in a frame.
  // Only once it has changed — the page arriving is not the title changing.
  const [shown, setShown] = useState(() => ({
    title,
    swapped: lastTitle !== null && lastTitle !== title,
  }));
  if (shown.title !== title) setShown({ title, swapped: true });
  useEffect(() => {
    lastTitle = title;
  }, [title]);
  const elsewhere =
    here.kind === "workspace" || !!workspaces?.length || !!doors?.length || canCreate === true;
  if (!elsewhere) return <h1 className="nt-front-title">{title}</h1>;

  const email = user?.primaryEmailAddress?.emailAddress;
  const domain = email?.split("@")[1];
  // Guests were let into projects, not into the workspace, so its settings
  // are not theirs to open (`SettingsFrame`).
  const settings = here.kind === "workspace" && here.role !== "guest" ? here : null;
  const invites = !standIn && (settings?.role === "owner" || settings?.role === "admin");

  // A door walked through by domain is a round trip before anywhere to go:
  // the menu stays up, its row saying so, until the new home replaces it.
  const join = (workspaceId: Id<"workspaces">, name: string, close: () => void) => {
    setJoining(workspaceId);
    joinByDomain({ workspaceId }).then(
      (joined) => {
        if (userId) rememberWorkspace(userId, joined.slug, { kind: "workspace", ...joined });
        router.push(homePath(joined.slug));
      },
      () => {
        setJoining(null);
        close();
        onProblem(`Couldn’t join ${name}. Ask someone there for an invitation.`);
      },
    );
  };

  return (
    <h1 className="nt-front-title">
      {here.kind === "workspace" && <TitleTile workspace={here} onProblem={onProblem} />}
      <Menu
        label="Your workspaces"
        side="bottom"
        align="center"
        className="nt-ws-switcher"
        focusRef={trigger}
        trigger={(t) => (
          <button {...t} className="nt-ws-switch">
            <span
              key={title}
              className={`nt-ws-switch-name${shown.swapped ? " is-swapped" : ""}`}
            >
              {title}
            </span>
            <ChevronsUpDown aria-hidden="true" className="nt-ws-switch-glyph" />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuLink
              href={homePath(null)}
              onClick={() => close()}
              current={here.kind === "account"}
            >
              <Place
                tile={<YouTile name={user?.fullName || email} />}
                name="My Nootles"
                current={here.kind === "account"}
              />
            </MenuLink>
            {workspaces?.map((w) => {
              const current = here.kind === "workspace" && here.workspaceId === w.workspaceId;
              return (
                <MenuLink
                  key={w.workspaceId}
                  href={homePath(w.slug)}
                  onClick={() => close()}
                  current={current}
                >
                  <Place
                    tile={<Tile name={w.name} icon={w.icon} />}
                    name={w.name}
                    meta={ROLE_LABEL[w.role]}
                    current={current}
                  />
                </MenuLink>
              );
            })}

            {!!doors?.length && <div className="nt-menu-sep" />}
            {doors?.map((door) =>
              door.token ? (
                <MenuLink key={door.workspaceId} href={joinPath(door.token)} onClick={() => close()}>
                  <Tile name={door.name} icon={door.icon} />
                  <span className="nt-ws-menu-name">Join {door.name}</span>
                  <span className="nt-ws-menu-meta">Invited</span>
                </MenuLink>
              ) : (
                <MenuItem
                  key={door.workspaceId}
                  disabled={joining !== null}
                  onClick={() => join(door.workspaceId, door.name, close)}
                >
                  <Tile name={door.name} icon={door.icon} />
                  <span className="nt-ws-menu-name">Join {door.name}</span>
                  {joining === door.workspaceId ? (
                    <span role="status" className="nt-ws-menu-meta">
                      Joining…
                    </span>
                  ) : (
                    domain && <span className="nt-ws-menu-meta">@{domain}</span>
                  )}
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
            {/* A phone's header has no room for Invite; the way to it is here. */}
            {settings && invites && phone && (
              <MenuItem
                onClick={() => {
                  close();
                  onInvite();
                }}
              >
                <span className="nt-ws-slot">
                  <PersonPlus className="nt-menu-icon" />
                </span>
                Invite people
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
      {making && (
        <NewWorkspace
          onClose={() => {
            setMaking(false);
            trigger.current?.focus();
          }}
        />
      )}
    </h1>
  );
}
