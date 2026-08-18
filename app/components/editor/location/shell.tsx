"use client";

import { createContext, useContext } from "react";
import type { Location } from "./types";

/**
 * Which place card the screen is speaking for.
 *
 * The same arrangement as the canvas: a 600px column has no room for an
 * inspector, so the window mounts one and the block only says which card is
 * under the hand. One at a time — a page may hold a dozen cafés, and a list of
 * what to show is a list about one of them.
 */
export type ActiveLocation = {
  blockId: string;
  location: Location;
  set: (next: Location) => void;
};

export type LocationShell = {
  active: ActiveLocation | null;
  set: (next: ActiveLocation | null) => void;
};

/** A card rendered outside the workspace simply has no shell to take over. */
const NO_SHELL: LocationShell = { active: null, set: () => {} };

export const LocationShellContext = createContext<LocationShell>(NO_SHELL);

export function useLocationShell(): LocationShell {
  return useContext(LocationShellContext);
}
