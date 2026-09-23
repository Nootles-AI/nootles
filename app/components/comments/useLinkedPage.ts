"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { PAGE_PARAM } from "@/app/lib/comments/link";

/**
 * Opens the page a link names — a comment notice's (`commentHref`) — through
 * the caller's own `open`, then gives the param up so the address stops
 * claiming a page the reader has since left. Anything else in the query (the
 * thread) is left for whoever reads it.
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
    url.searchParams.delete(PAGE_PARAM);
    window.history.replaceState(null, "", url);
  }, [requested]);
}
