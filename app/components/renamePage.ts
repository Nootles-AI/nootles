"use client";

import { useMutation } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * A rename lands on every copy of the page this client holds at once, so the
 * sidebar and the tab follow the title as it is typed rather than a round
 * trip behind. The args carry no project, so every loaded list is asked.
 */
export function renameLocally(
  store: OptimisticLocalStore,
  { pageId, title }: { pageId: Id<"pages">; title: string },
) {
  const page = store.getQuery(api.pages.get, { pageId });
  if (page) store.setQuery(api.pages.get, { pageId }, { ...page, title });
  for (const { args, value } of store.getAllQueries(api.pages.listByProject)) {
    if (!value?.some((p) => p._id === pageId)) continue;
    store.setQuery(
      api.pages.listByProject,
      args,
      value.map((p) => (p._id === pageId ? { ...p, title } : p)),
    );
  }
}

export function useRenamePage() {
  return useMutation(api.pages.rename).withOptimisticUpdate(renameLocally);
}
