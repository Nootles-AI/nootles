"use client";

import { useState, type ReactNode } from "react";
import { Check } from "../Icons";
import { drawsItself, iconKey, RowIcon, type RowIconValue } from "../rowIcon";
import { initial } from "./people";
import "./workspaces.css";

/**
 * The places a project can live, as the switcher draws them — shared by every
 * menu that lists them, so choosing where a new project goes reads as the
 * same list as going there. Inside a menu classed `nt-ws-switcher`.
 */

/**
 * A workspace's token: its icon where one is chosen, else its initial, in a
 * square where a person's is round. `size` is the tile's side, for the glyph
 * inside it; the class it is drawn with sets the box. A new icon settles into
 * the tile rather than replacing what was there in a frame — only on a
 * change, never as the tile first draws.
 */
export function Tile({
  name,
  icon,
  size = 20,
  className = "",
}: {
  name: string;
  icon?: RowIconValue | null;
  size?: number;
  className?: string;
}) {
  const shown = drawsItself(icon) ? icon : null;
  const key = iconKey(shown);
  const [was, setWas] = useState(key);
  const [changed, setChanged] = useState(false);
  if (was !== key) {
    setWas(key);
    setChanged(true);
  }
  return (
    <span
      className={`nt-monogram nt-ws-tile is-square${shown ? ` has-icon is-${shown.kind}` : ""}${
        className ? ` ${className}` : ""
      }`}
      aria-hidden="true"
    >
      <span key={key} className={`nt-ws-tile-face${changed ? " is-new" : ""}`}>
        {shown ? (
          <RowIcon
            icon={shown}
            kind="page"
            // A picture fills the tile; a glyph or an emoji sits in its well.
            size={shown.kind === "image" ? size : Math.round(size * 0.7)}
            className="nt-ws-tile-icon"
          />
        ) : (
          initial(name)
        )}
      </span>
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
