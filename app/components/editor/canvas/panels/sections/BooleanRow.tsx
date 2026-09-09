"use client";

import { Tooltip } from "@/app/components/Tooltip";
import {
  SHORTCUTS_BY_ID,
  shortcutHint,
  type ShortcutId,
} from "../../engine/shortcuts";
import { booleanOps, canBoolean, flattenOps, loadClipper } from "../../scene/boolean";
import {
  BOOLEAN_OPS,
  isBoolean,
  type BooleanOp,
  type NodeId,
  type Scene,
  type SceneNode,
  type SceneOp,
} from "../../scene/types";
import { Boolean, Flatten } from "../controls/glyphs";
import "../panel.css";

const SHORTCUT: Record<BooleanOp, ShortcutId> = {
  union: "edit.union",
  subtract: "edit.subtract",
  intersect: "edit.intersect",
  exclude: "edit.exclude",
};

/**
 * Figma's boolean row: the four operations as a toggle, and the flatten. Like
 * the align strip it acts on the *selection* rather than on a property of it,
 * and it is shown whenever the selection could take an operation — two or more
 * shapes, or a group. A lone boolean group reads its own operation as pressed.
 */
export function BooleanRow({
  selection,
  scene,
  run,
  select,
}: {
  selection: SceneNode[];
  scene: Scene;
  run: (ops: readonly SceneOp[]) => void;
  select: (ids: readonly NodeId[]) => void;
}) {
  const lone = selection.length === 1 && isBoolean(selection[0]) ? selection[0] : null;
  const enabled = canBoolean(selection);
  const flattenable = selection.some(isBoolean);

  const apply = (op: BooleanOp) => {
    const result = booleanOps(scene, selection, op);
    if (!result) return;
    run(result.ops);
    select(result.select);
  };
  const flatten = () =>
    void loadClipper().then(() => {
      const ops = flattenOps(scene, selection.map((node) => node.id));
      if (ops.length) run(ops);
    });

  return (
    <div className="nt-align-strip" role="group" aria-label="Boolean">
      <div className="nt-align-group">
        {BOOLEAN_OPS.map((op) => (
          <Tooltip
            key={op}
            label={SHORTCUTS_BY_ID[SHORTCUT[op]].label}
            hint={shortcutHint(SHORTCUT[op])}
          >
            <button
              className="nt-icon-btn is-sm"
              disabled={!enabled}
              aria-pressed={lone?.op === op}
              aria-label={SHORTCUTS_BY_ID[SHORTCUT[op]].label}
              onClick={() => apply(op)}
            >
              <Boolean op={op} />
            </button>
          </Tooltip>
        ))}
      </div>
      <Tooltip label={SHORTCUTS_BY_ID["edit.flatten"].label} hint={shortcutHint("edit.flatten")}>
        <button
          className="nt-icon-btn is-sm"
          disabled={!flattenable}
          aria-label={SHORTCUTS_BY_ID["edit.flatten"].label}
          onClick={flatten}
        >
          <Flatten />
        </button>
      </Tooltip>
    </div>
  );
}
