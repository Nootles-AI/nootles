import { createContext, useContext } from "react";
import type { Link } from "./types";

interface LinkShellState {
  blockId: string;
  link: Link;
  set: (next: Link) => void;
}

interface LinkShellContextType {
  active: LinkShellState | null;
  set: (state: LinkShellState | null) => void;
}

const LinkShellContext = createContext<LinkShellContextType | null>(null);

export function useLinkShell(): LinkShellContextType {
  const ctx = useContext(LinkShellContext);
  if (!ctx) {
    return { active: null, set: () => {} };
  }
  return ctx;
}

export const LinkShellProvider = LinkShellContext.Provider;
