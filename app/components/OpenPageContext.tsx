"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";

type OpenPage = {
  /** The page last chosen — by the sidebar, or by the agent's `open_page`. */
  selected: Id<"pages"> | null;
  /** Deliberate navigation — the sidebar, the agent. Dismisses any trail. */
  open: (pageId: Id<"pages">) => void;
  /**
   * A chip followed somewhere — the one way of leaving a page that needs a way
   * home, so it is the one that writes the trail. `from` is the page being
   * left, needed while `selected` is still null (the implicit first page of a
   * fresh load); after any explicit choice the provider knows on its own.
   */
  follow: (pageId: Id<"pages">, from?: Id<"pages"> | null) => void;
  /** Return to the page the last `follow` left. */
  back: () => void;
  canGoBack: boolean;
};

const OpenPageContext = createContext<OpenPage | null>(null);

/**
 * Which page the surface is showing.
 *
 * Held above the workspace rather than inside it so the agent opens a page
 * through the same selection the sidebar writes to — one selection, one code
 * path. It stays a request rather than an answer: the workspace still resolves
 * it against the project's pages during render, so an id that is stale or
 * belongs elsewhere falls back to the first page instead of blanking the
 * surface — including a trail entry whose page has since been deleted.
 */
export function OpenPageProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Id<"pages"> | null>(null);
  const [trail, setTrail] = useState<Id<"pages">[]>([]);

  const value = useMemo<OpenPage>(() => {
    // Choosing a page outright ends the excursion the trail was recording:
    // "back" after a sidebar click would mean somewhere you have already
    // deliberately left, and the button would simply never go away.
    const open = (pageId: Id<"pages">) => {
      setTrail([]);
      setSelected(pageId);
    };
    const follow = (pageId: Id<"pages">, from: Id<"pages"> | null = null) => {
      const origin = selected ?? from;
      if (origin && origin !== pageId) setTrail((t) => [...t, origin]);
      setSelected(pageId);
    };
    const back = () => {
      const prev = trail[trail.length - 1];
      if (prev === undefined) return;
      setTrail(trail.slice(0, -1));
      setSelected(prev);
    };
    return { selected, open, follow, back, canGoBack: trail.length > 0 };
  }, [selected, trail]);

  return <OpenPageContext value={value}>{children}</OpenPageContext>;
}

export function useOpenPage(): OpenPage {
  const value = useContext(OpenPageContext);
  if (!value) throw new Error("Missing <OpenPageProvider>");
  return value;
}

/** For surfaces that may render outside the workspace (the share route). */
export function useOpenPageOptional(): OpenPage | null {
  return useContext(OpenPageContext);
}

/**
 * The page the surrounding surface is showing — what a mention chip passes to
 * `open` as `from`. Its own context rather than a prop through the editor
 * tree: the chips render at arbitrary depth, inside ProseMirror node views.
 */
const CurrentPageContext = createContext<Id<"pages"> | null>(null);

export function CurrentPageProvider({
  pageId,
  children,
}: {
  pageId: Id<"pages">;
  children: ReactNode;
}) {
  return <CurrentPageContext value={pageId}>{children}</CurrentPageContext>;
}

export function useCurrentPage(): Id<"pages"> | null {
  return useContext(CurrentPageContext);
}
