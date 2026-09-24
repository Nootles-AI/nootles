"use client";

import type { ReactNode } from "react";
import { Check } from "../Icons";
import { initial } from "./people";
import "./workspaces.css";

/**
 * The places a project can live, as the switcher draws them — shared by every
 * menu that lists them, so choosing where a new project goes reads as the
 * same list as going there. Inside a menu classed `nt-ws-switcher`.
 */

/** A workspace's token: its initial, in a square where a person's is round. */
export function Tile({ name }: { name: string }) {
  return (
    <span className="nt-monogram nt-ws-tile is-square" aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/** Your own projects' token: your initial, round, as your monogram is everywhere. */
export function YouTile({ name }: { name: string | null | undefined }) {
  return (
    <span className="nt-monogram nt-ws-tile" aria-hidden="true">
      {initial(name)}
    </span>
  );
}

/** One place's row: its tile, its name, what you are there, and the tick on the current one. */
export function Place({
  tile,
  name,
  meta,
  current,
}: {
  tile: ReactNode;
  name: string;
  meta?: ReactNode;
  current: boolean;
}) {
  return (
    <>
      {tile}
      <span className="nt-ws-menu-name">{name}</span>
      {meta && <span className="nt-ws-menu-meta">{meta}</span>}
      <Check
        width={14}
        height={14}
        aria-hidden="true"
        className={`nt-menu-check${current ? " is-on" : ""}`}
      />
    </>
  );
}
