"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";

type OpenPage = {
  /** The page last chosen — by the sidebar, or by the agent's `open_page`. */
  selected: Id<"pages"> | null;
  open: (pageId: Id<"pages">) => void;
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
 * surface.
 */
export function OpenPageProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Id<"pages"> | null>(null);
  const value = useMemo(() => ({ selected, open: setSelected }), [selected]);
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
