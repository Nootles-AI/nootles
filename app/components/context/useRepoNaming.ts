"use client";

import { useEffect, useRef } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Asks for a repository's concerns to be named once its index lands.
 *
 * The model call lives in Next, with the keys and the ledger, and something has
 * to ask for it; the linker's own workspace is where the index was asked for,
 * so it is the one that asks. The server's claim makes this safe to call from
 * every tab — one of them wins and the rest are told there is nothing to do.
 * Owner-only by construction: the repo list answers empty to anyone else.
 */
export function useRepoNaming(projectId: Id<"projects">) {
  const repos = useQuery(api.github.repos.listForProject, { projectId });
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const repo of repos ?? []) {
      if (repo.index?.state !== "naming" || asked.current.has(repo._id)) continue;
      asked.current.add(repo._id);
      void fetch("/api/context/name", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repoId: repo._id }),
      }).catch(() => {
        // Asked again on the next visit; the directory names stand meanwhile.
        asked.current.delete(repo._id);
      });
    }
  }, [repos]);
}
