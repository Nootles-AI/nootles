"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import type { RowIconValue } from "./rowIcon";

export type PageRef = {
  _id: Id<"pages">;
  title: string;
  /** The page's chosen icon, so a chip wears it the way the sidebar does. */
  icon?: RowIconValue;
};

/**
 * The project's pages, in sidebar order, for anything that names a page —
 * the "@" mention menus and the chips they insert (which read the live title
 * here rather than trusting the one stored at pick time).
 *
 * Nullable rather than throwing: the read-only share surface renders the same
 * chips with no workspace around them, and there a chip is just its text.
 */
const PagesContext = createContext<PageRef[] | null>(null);

export function PagesProvider({
  pages,
  children,
}: {
  pages: PageRef[] | null;
  children: ReactNode;
}) {
  return <PagesContext value={pages}>{children}</PagesContext>;
}

export function usePages(): PageRef[] | null {
  return useContext(PagesContext);
}
