"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Account } from "@/convex/github/account";
import { useContainer } from "../workspaces/ContainerContext";

/**
 * Which GitHub a project's repositories come from, for every picker that
 * offers them (docs/github-app.md).
 *
 * A personal project's are its person's own, read with their connection. A
 * workspace project's are the workspace's GitHub App installations' — and,
 * where the workspace allows personal connections, the person's own beside
 * them, or instead of them until an admin installs the App. Where it allows
 * neither, the door is shut, and says who can open it.
 */
export type GitHubDoor =
  | { via: "loading" }
  | {
      via: "app";
      workspaceId: Id<"workspaces">;
      /** The person's own connection also lists and looks up, for what the App doesn’t reach. */
      personal: boolean;
    }
  | {
      via: "personal";
      ready: boolean;
      blocker: string;
      account: Account | null;
      /** A workspace project read with a member's own connection, for want of the App. */
      forWorkspace: boolean;
    }
  | {
      via: "shut";
      workspaceId: Id<"workspaces">;
      canInstall: boolean;
      /** An owner or admin, who can turn personal connections back on. */
      manages: boolean;
      /** This deployment has no GitHub App to install. */
      unconfigured: boolean;
    };

export function useGitHubDoor(workspaceId: Id<"workspaces"> | undefined, active = true): GitHubDoor {
  const personal = useQuery(api.github.account.status, active ? {} : "skip");
  const app = useQuery(api.github.app.status, active && workspaceId ? { workspaceId } : "skip");

  if (workspaceId) {
    if (app === undefined) return { via: "loading" };
    // Null is not a member — a guest, or someone in by link — whose link
    // the server refuses whatever this offers; the personal door says least.
    if (app) {
      const installed = app.installations.some((i) => i.removedAt === undefined && i.suspendedAt === undefined);
      if (installed) {
        if (!app.allowPersonalTokens) return { via: "app", workspaceId, personal: false };
        if (personal === undefined) return { via: "loading" };
        const connected = !!personal.account && !personal.account.invalidAt;
        return { via: "app", workspaceId, personal: connected };
      }
      if (!app.allowPersonalTokens) {
        return {
          via: "shut",
          workspaceId,
          canInstall: app.canManage && app.ready,
          manages: app.canManage,
          unconfigured: !app.ready,
        };
      }
    }
  }
  if (personal === undefined) return { via: "loading" };
  return {
    via: "personal",
    ready: personal.ready,
    blocker: personal.blocker,
    account: personal.account,
    forWorkspace: !!workspaceId,
  };
}

/** Whether the door opens on a list to search, rather than on a way in. */
export function searchable(door: GitHubDoor): boolean {
  return door.via === "app" || (door.via === "personal" && !!door.account && !door.account.invalidAt);
}

/** The integrations page of the workspace being viewed, where its door is set; null for any other. */
export function useIntegrationsPath(workspaceId: Id<"workspaces">): string | null {
  const here = useContainer();
  return here.kind === "workspace" && here.workspaceId === workspaceId
    ? `/w/${here.slug}/settings/integrations`
    : null;
}

/**
 * Where a member who cannot open the door finds who can: the workspace's
 * people, owners and admins first. Null outside that workspace.
 */
export function useMembersPath(workspaceId: Id<"workspaces">): string | null {
  const here = useContainer();
  return here.kind === "workspace" && here.workspaceId === workspaceId
    ? `/w/${here.slug}/settings/members`
    : null;
}

export function installPath(workspaceId: Id<"workspaces">): string {
  return `/api/github/app/install?workspace=${workspaceId}`;
}

/** What the search field over a door's list says it searches. */
export function repoPlaceholder(door: GitHubDoor): string {
  if (door.via !== "app") return "Search your repositories, or type owner/name…";
  return door.personal
    ? "Search the workspace’s and your repositories, or type owner/name…"
    : "Search the workspace’s repositories…";
}
