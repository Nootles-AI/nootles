"use client";

import { useState } from "react";
import { Tooltip } from "@/app/components/Tooltip";
import type { SceneStore } from "../../engine/useScene";
import { isGroup, type Scene, type SceneNode } from "../../scene/types";
import { ColorField } from "../controls/ColorField";
import { PanelSection } from "../controls/PanelSection";
import { collectSelectionColors, recolorOps } from "../selectionColors";
import type { PerStore } from "../StylePanel";

/**
 * "Every colour in this selection, in one list" — the row a designer reaches
 * for after building a chunk of the diagram with one palette and wanting to
 * swap a single colour everywhere it landed, without hunting through Fill,
 * Stroke and every label span one shape at a time.
 *
 * Mounted at the top of the style panel (after `AlignRow`/`BooleanRow`,
 * before `PositionSection` — see `StylePanel.tsx`), and dispatches through
 * `run(recolorOps(...))` rather than `props.patch`: `patch` only ever
 * rewrites the *selected* nodes themselves, and recolouring a group's
 * children needs ops reaching into nested ids, still as one `run()` call so
 * a whole-palette swap is one undo entry — across every diagram the
 * selection reaches into.
 */
export function SelectionColorsSection({
  selection,
  parts,
  run,
}: {
  /** Every part's nodes, together — the list is one list whatever diagram a colour is in. */
  selection: readonly SceneNode[];
  parts: readonly { store: SceneStore; scene: Scene; nodes: readonly SceneNode[] }[];
  run: (each: PerStore) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // Two-or-more shapes, or a single group (whose own colours live on its
  // children) — a lone leaf shape already has Fill/Stroke/Typography for this.
  const eligible = selection.length >= 2 || selection.some(isGroup);
  const colors = eligible ? collectSelectionColors(parts[0].scene, selection) : [];
  if (colors.length === 0) return null;

  const VISIBLE = 8;
  const shown = expanded ? colors : colors.slice(0, VISIBLE);
  const hidden = colors.length - shown.length;

  return (
    <PanelSection title="Selection colours">
      {shown.map((color) => (
        // Keyed on `color.id`, not `color.key` — the latter IS the colour's
        // current value, so keying on it remounts the row (and closes
        // whatever popover is open on it) on every tick of the very drag
        // editing it. `id` is a structural identity that survives the value
        // changing; see its doc comment in `selectionColors.ts`.
        <div className="nt-ctl-row" key={color.id}>
          <ColorField
            value={color.authored}
            onChange={(value) =>
              run(parts.map((part) => [part.store, recolorOps(part.scene, part.nodes, color.key, value)]))
            }
          />
          <Tooltip label={`${color.uses} use${color.uses === 1 ? "" : "s"}`} className="nt-ctl-anchor">
            <span className="nt-ctl-note">{color.uses}</span>
          </Tooltip>
        </div>
      ))}
      {hidden > 0 && (
        <button type="button" className="nt-ctl-textbtn" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </button>
      )}
    </PanelSection>
  );
}
