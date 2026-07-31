"use client";

import { Tooltip } from "@/app/components/Tooltip";
import { alignNodes, distributeNodes } from "../../scene/align";
import {
  SHORTCUTS_BY_ID,
  shortcutHint,
  type ShortcutId,
} from "../../engine/shortcuts";
import type { Alignment, DistributeAxis, NodeId, Point } from "../../scene/types";
import type { SectionProps } from "../StylePanel";

/** Icon geometry, in a 16px box: the rule as `x1,y1,x2,y2`, bars as `x,y,w,h`. */
function Glyph({ rule, bars }: { rule?: string; bars: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      {rule && <Rule spec={rule} />}
      {bars.split(" ").map((bar) => {
        const [x, y, w, h] = bar.split(",");
        return (
          <rect
            key={bar}
            x={x}
            y={y}
            width={w}
            height={h}
            rx="1"
            fill="currentColor"
            opacity="0.55"
          />
        );
      })}
    </svg>
  );
}

function Rule({ spec }: { spec: string }) {
  const [x1, y1, x2, y2] = spec.split(",");
  return (
    <path
      d={`M${x1} ${y1}L${x2} ${y2}`}
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
    />
  );
}

/** The name and the key both come from the keymap table, so neither can drift. */
const ALIGN: { value: Alignment; id: ShortcutId; rule: string; bars: string }[] = [
  { value: "left", id: "align.left", rule: "2.5,2,2.5,14", bars: "3.5,4,9,3 3.5,9,6,3" },
  { value: "hcenter", id: "align.hcenter", rule: "8,2,8,14", bars: "3.5,4,9,3 5,9,6,3" },
  { value: "right", id: "align.right", rule: "13.5,2,13.5,14", bars: "3.5,4,9,3 6.5,9,6,3" },
  { value: "top", id: "align.top", rule: "2,2.5,14,2.5", bars: "4,3.5,3,9 9,3.5,3,6" },
  { value: "vcenter", id: "align.vcenter", rule: "2,8,14,8", bars: "4,3.5,3,9 9,5,3,6" },
  { value: "bottom", id: "align.bottom", rule: "2,13.5,14,13.5", bars: "4,3.5,3,9 9,6.5,3,6" },
];

const DISTRIBUTE: { value: DistributeAxis; label: string; bars: string }[] = [
  { value: "horizontal", label: "Distribute horizontal spacing", bars: "2,4,3,8 6.5,4,3,8 11,4,3,8" },
  { value: "vertical", label: "Distribute vertical spacing", bars: "4,2,8,3 4,6.5,8,3 4,11,8,3" },
];

/**
 * Figma's first row: six alignments, then the two distributions.
 *
 * Both act on the selection's own bounds, so both need something to act
 * against — one node has nothing to align to but itself, and two nodes already
 * have exactly one gap. Below those counts the buttons are disabled rather than
 * appearing to promise something they cannot do.
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
    <div className="flex items-center justify-between px-2 py-1.5">
      <div className="flex items-center gap-0.5">
        {ALIGN.map((a) => (
          <Tooltip
            key={a.value}
            label={SHORTCUTS_BY_ID[a.id].label}
            hint={shortcutHint(a.id)}
          >
            <button
              className="ab-icon-btn size-6"
              disabled={!canAlign}
              aria-label={SHORTCUTS_BY_ID[a.id].label}
              onClick={() => move(alignNodes(selection, a.value))}
            >
              <Glyph rule={a.rule} bars={a.bars} />
            </button>
          </Tooltip>
        ))}
      </div>
      <div className="flex items-center gap-0.5">
        {DISTRIBUTE.map((d) => (
          <Tooltip key={d.value} label={d.label}>
            <button
              className="ab-icon-btn size-6"
              disabled={!canDistribute}
              aria-label={d.label}
              onClick={() => move(distributeNodes(selection, d.value))}
            >
              <Glyph bars={d.bars} />
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
