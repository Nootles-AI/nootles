"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";

/** The surface is one column, or two: a primary and a second beside it. */
export type Pane = "main" | "aside";

type PaneView = {
  /** The page last chosen here — by the sidebar, or by the agent's `open_page`. */
  page: Id<"pages"> | null;
  /** Whether a chip was followed in this pane, so there is a way home. */
  canGoBack: boolean;
};

type OpenPage = {
  main: PaneView;
  /** The second pane, null while the surface is a single column. */
  aside: PaneView | null;
  /** Which pane the chat, the agent and a followed chip act on. */
  focus: Pane;
  /** Deliberate navigation — the sidebar, the agent. Dismisses any trail. */
  open: (pageId: Id<"pages">) => void;
  /** Put a page in the second pane, opening it if there wasn't one. */
  openAside: (pageId: Id<"pages">) => void;
  closeAside: () => void;
  focusPane: (pane: Pane) => void;
  /**
   * A chip followed somewhere — the one way of leaving a page that needs a way
   * home, so it is the one that writes the trail. `from` is the page being
   * left, needed while the pane's own selection is still null (the implicit
   * first page of a fresh load); after any explicit choice it knows on its own.
   */
  follow: (pageId: Id<"pages">, from?: Id<"pages"> | null) => void;
  /**
   * Return to the page the last `follow` left. Named rather than focused, the
   * one verb that has to be: both panes draw their own arrow at once, and each
   * has to mean its own trail.
   */
  back: (pane: Pane) => void;
};

const OpenPageContext = createContext<OpenPage | null>(null);

/** What one pane is showing, and how it got there. */
type PaneState = { selected: Id<"pages"> | null; trail: Id<"pages">[] };

const EMPTY: PaneState = { selected: null, trail: [] };

const viewOf = (pane: PaneState): PaneView => ({
  page: pane.selected,
  canGoBack: pane.trail.length > 0,
});

/**
 * Which page each pane of the surface is showing.
 *
 * Held above the workspace rather than inside it so the agent opens a page
 * through the same selection the sidebar writes to — one selection, one code
 * path. It stays a request rather than an answer: the workspace still resolves
 * it against the project's pages during render, so an id that is stale or
 * belongs elsewhere falls back to the first page instead of blanking the
 * surface — including a trail entry whose page has since been deleted.
 *
 * Navigation acts on the focused pane rather than taking one, because the
 * pointer has already said which: a click inside a pane focuses it on the way
 * down, before the chip or the button it landed on is heard from.
 */
export function OpenPageProvider({ children }: { children: ReactNode }) {
  const [main, setMain] = useState<PaneState>(EMPTY);
  const [aside, setAside] = useState<PaneState | null>(null);
  const [focused, setFocused] = useState<Pane>("main");

  const value = useMemo<OpenPage>(() => {
    // The aside can close while it holds focus, and a pane that isn't there
    // cannot be the one being typed in.
    const focus: Pane = aside ? focused : "main";

    const write = (pane: Pane, next: (prev: PaneState) => PaneState) => {
      if (pane === "main") setMain(next);
      else setAside((prev) => (prev ? next(prev) : prev));
    };

    // Choosing a page outright ends the excursion the trail was recording:
    // "back" after a sidebar click would mean somewhere you have already
    // deliberately left, and the button would simply never go away.
    const open = (pageId: Id<"pages">) =>
      write(focus, () => ({ selected: pageId, trail: [] }));

    const follow = (pageId: Id<"pages">, from: Id<"pages"> | null = null) =>
      write(focus, (prev) => {
        const origin = prev.selected ?? from;
        return {
          selected: pageId,
          trail:
            origin && origin !== pageId ? [...prev.trail, origin] : prev.trail,
        };
      });

    const back = (pane: Pane) =>
      write(pane, (prev) => {
        const previous = prev.trail[prev.trail.length - 1];
        if (previous === undefined) return prev;
        return { selected: previous, trail: prev.trail.slice(0, -1) };
      });

    // A page dragged to the side is one you want to be reading, so it takes
    // focus — the chat and the agent follow it there.
    const openAside = (pageId: Id<"pages">) => {
      setAside({ selected: pageId, trail: [] });
      setFocused("aside");
    };

    const closeAside = () => {
      setAside(null);
      setFocused("main");
    };

    return {
      main: viewOf(main),
      aside: aside && viewOf(aside),
      focus,
      open,
      openAside,
      closeAside,
      focusPane: setFocused,
      follow,
      back,
    };
  }, [main, aside, focused]);

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
