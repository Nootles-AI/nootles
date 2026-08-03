"use client";

import { Tooltip } from "@/app/components/Tooltip";
import { alignNodes, distributeNodes } from "../../scene/align";
import {
  SHORTCUTS_BY_ID,
  shortcutHint,
  type ShortcutId,
} from "../../engine/shortcuts";
import { Align } from "../controls/glyphs";
import type { Alignment, DistributeAxis, NodeId, Point } from "../../scene/types";
import type { SectionProps } from "../StylePanel";
import "../panel.css";

/** The name and the key both come from the keymap table, so neither can drift. */
const ALIGN: {
  value: Alignment;
  id: ShortcutId;
  rule: string;
  bars: string;
}[] = [
  {
    value: "left",
    id: "align.left",
    rule: "2.5,2,2.5,14",
    bars: "3.5,4,9,3 3.5,9,6,3",
  },
  {
    value: "hcenter",
    id: "align.hcenter",
    rule: "8,2,8,14",
    bars: "3.5,4,9,3 5,9,6,3",
  },
  {
    value: "right",
    id: "align.right",
    rule: "13.5,2,13.5,14",
    bars: "3.5,4,9,3 6.5,9,6,3",
  },
  {
    value: "top",
    id: "align.top",
    rule: "2,2.5,14,2.5",
    bars: "4,3.5,3,9 9,3.5,3,6",
  },
  {
    value: "vcenter",
    id: "align.vcenter",
    rule: "2,8,14,8",
    bars: "4,3.5,3,9 9,5,3,6",
  },
  {
    value: "bottom",
    id: "align.bottom",
    rule: "2,13.5,14,13.5",
    bars: "4,3.5,3,9 9,6.5,3,6",
  },
];

const DISTRIBUTE: { value: DistributeAxis; label: string; bars: string }[] = [
  {
    value: "horizontal",
    label: "Distribute horizontally",
    bars: "2,4,3,8 6.5,4,3,8 11,4,3,8",
  },
  {
    value: "vertical",
    label: "Distribute vertically",
    bars: "4,2,8,3 4,6.5,8,3 4,11,8,3",
  },
];

/**
 * Figma's first row: six alignments, then the two distributions. It is not a
 * `PanelSection` — it acts on the *selection*, not on a property of it, which
 * is why it is the panel's one full-bleed strip.
 *
 * Both act on the selection's own bounds, so both need something to act
 * against — one node has nothing to align to but itself, and two nodes already
 * have exactly one gap. Below those counts the buttons are disabled rather
 * than appearing to promise something they cannot do.
 */
export function AlignRow({ selection, patch }: SectionProps) {
  const move = (moves: Map<NodeId, Point>) =>
    patch((node) => {
      const to = moves.get(node.id);
      return to ? { x: to.x, y: to.y } : {};
    });

  const canAlign = selection.length > 1;
  const canDistribute = selection.length > 2;

  return (
    <div className="nt-align-strip" role="group" aria-label="Align and distribute">
      <div className="nt-align-group">
        {ALIGN.map((a) => (
          <Tooltip
            key={a.value}
            label={SHORTCUTS_BY_ID[a.id].label}
            hint={shortcutHint(a.id)}
          >
            <button
              className="nt-icon-btn is-sm"
              disabled={!canAlign}
              aria-label={SHORTCUTS_BY_ID[a.id].label}
              onClick={() => move(alignNodes(selection, a.value))}
            >
              <Align rule={a.rule} bars={a.bars} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="nt-align-group">
        {DISTRIBUTE.map((d) => (
          <Tooltip key={d.value} label={d.label}>
            <button
              className="nt-icon-btn is-sm"
              disabled={!canDistribute}
              aria-label={d.label}
              onClick={() => move(distributeNodes(selection, d.value))}
            >
              <Align bars={d.bars} />
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
