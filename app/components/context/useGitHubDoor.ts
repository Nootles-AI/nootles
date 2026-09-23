"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Account } from "@/convex/github/account";

/**
 * Which GitHub a project's repositories come from, for every picker that
 * offers them (docs/github-app.md).
 *
 * A personal project's are its person's own, read with their connection. A
 * workspace project's are the workspace's GitHub App installations' — and
 * until an admin installs it, the person's own where the workspace allows
 * that. Where it does not, the door is shut, and says who can open it.
 */
export type GitHubDoor =
  | { via: "loading" }
  | { via: "app"; workspaceId: Id<"workspaces"> }
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
      if (installed) return { via: "app", workspaceId };
      if (!app.allowPersonalTokens) {
        return {
          via: "shut",
          workspaceId,
          canInstall: app.canManage && app.ready,
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

export function installPath(workspaceId: Id<"workspaces">): string {
  return `/api/github/app/install?workspace=${workspaceId}`;
}

/** What the search field over a door's list says it searches. */
export function repoPlaceholder(door: GitHubDoor): string {
  return door.via === "app"
    ? "Search the workspace’s repositories…"
    : "Search your repositories, or type owner/name…";
}
