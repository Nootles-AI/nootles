"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { PAGE_PARAM, THREAD_PARAM } from "@/app/lib/comments/link";

/**
 * Opens the page a link names — a comment notice's (`commentHref`) — through
 * the caller's own `open`, then gives the param up so the address stops
 * claiming a page the reader has since left — unless the link also names a
 * thread, whose pane gives up both once it has it.
 *
 * Asked on every navigation, not once: a notice followed from inside the
 * project it belongs to changes only the query, and the workspace stays
 * mounted through it.
 */
export function useLinkedPage(open: (pageId: Id<"pages">) => void): void {
  const requested = useSearchParams()?.get(PAGE_PARAM) ?? null;
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (!requested) return;
    openRef.current(requested as Id<"pages">);
    const url = new URL(window.location.href);
    // A thread link keeps naming its page until that page's pane has taken
    // the thread (`CommentsLayer`), so no other pane mistakes it for its own.
    if (url.searchParams.has(THREAD_PARAM)) return;
    url.searchParams.delete(PAGE_PARAM);
    window.history.replaceState(null, "", url);
  }, [requested]);
}
