"use client";

import { useCallback, useRef } from "react";
import { X } from "@/app/components/Icons";
import { ColorField } from "../controls/ColorField";
import { Dash as DashGlyph } from "../controls/glyphs";
import { IconButton } from "../controls/IconButton";
import { IconToggle } from "../controls/IconToggle";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import { SelectField } from "../controls/SelectField";
import {
  displayName,
  findNode,
  type EdgeId,
  type NodeId,
  type SceneEdge,
  type Scene,
  type StylePatch,
} from "../../scene/types";

/**
 * The inspector for a connector.
 *
 * A connector has no box, so none of the shape sections apply to it — the
 * panel shows this instead of them, not alongside them. What it does have is
 * two ends and a line, and those are what this offers: where it runs from and
 * to, by layer name, and how the line is drawn.
 *
 * There is no "side" control, and deliberately so: the plugs are picked from
 * where the two boxes currently are (see `scene/edgePath`), so a connector
 * cannot be left pointing at a side its shape no longer faces.
 */

type Dash = "solid" | "dashed" | "dotted";

const DASHARRAY: Record<Dash, string | undefined> = {
  solid: undefined,
  dashed: "8 6",
  dotted: "2 4",
};

const DASHES = (["solid", "dashed", "dotted"] as const).map((kind) => ({
  value: kind,
  label: kind[0].toUpperCase() + kind.slice(1),
  icon: <DashGlyph kind={kind} />,
}));

const dashOf = (value: string | undefined): Dash =>
  value === DASHARRAY.dashed
    ? "dashed"
    : value === DASHARRAY.dotted
      ? "dotted"
      : "solid";

/** The canvas's own line colour, which is what an unstyled connector draws in. */
const DEFAULT_STROKE = "var(--edge-line)";

export interface EdgeSectionProps {
  scene: Scene;
  edges: readonly SceneEdge[];
  setLabel: (id: EdgeId, label: string) => void;
  setStyle: (ids: readonly EdgeId[], decls: StylePatch) => void;
  reconnect: (id: EdgeId, from: NodeId | undefined, to: NodeId | undefined) => void;
  remove: (ids: readonly EdgeId[]) => void;
}

export function EdgeSection({
  scene,
  edges,
  setLabel,
  setStyle,
  reconnect,
  remove,
}: EdgeSectionProps) {
  const ids = edges.map((edge) => edge.id);
  const one = edges.length === 1 ? edges[0] : null;

  const read = (prop: string) => edges[0]?.style[prop] ?? "";
  const differs = (prop: string) =>
    edges.some((edge) => (edge.style[prop] ?? "") !== read(prop));

  const width = Number.parseFloat(read("stroke-width"));

  return (
    <>
      <PanelSection title={edges.length > 1 ? "Connectors" : "Connector"}>
        {one ? (
          <>
            <EndRow
              mark="From"
              scene={scene}
              current={one.from}
              exclude={one.to}
              onPick={(from) => reconnect(one.id, from, undefined)}
            />
            <EndRow
              mark="To"
              scene={scene}
              current={one.to}
              exclude={one.from}
              onPick={(to) => reconnect(one.id, undefined, to)}
            />
            <div className="nt-ctl-row">
              <button
                className="nt-ctl-textbtn"
                onClick={() => reconnect(one.id, one.to, one.from)}
              >
                Swap ends
              </button>
              <span className="nt-ctl-grow" />
              <IconButton label="Remove connector" onClick={() => remove([one.id])}>
                <X width={13} height={13} />
              </IconButton>
            </div>
          </>
        ) : (
          <div className="nt-ctl-row">
            <span className="nt-ctl-empty">{edges.length} selected</span>
            <span className="nt-ctl-grow" />
            <IconButton label="Remove connectors" onClick={() => remove(ids)}>
              <X width={13} height={13} />
            </IconButton>
          </div>
        )}
      </PanelSection>

      <PanelSection title="Label">
        {one ? (
          <LabelField
            key={one.id}
            value={one.label}
            onChange={(label) => setLabel(one.id, label)}
          />
        ) : (
          <span className="nt-ctl-empty">Select one connector to label it</span>
        )}
      </PanelSection>

      <PanelSection title="Line">
        <div className="nt-ctl-row">
          <ColorField
            value={read("stroke") || DEFAULT_STROKE}
            mixed={differs("stroke")}
            onChange={(stroke) => setStyle(ids, { stroke })}
          />
        </div>
        <div className="nt-ctl-grid">
          <NumberField
            label={<DashGlyph kind="solid" />}
            name="Line weight"
            value={Number.isFinite(width) ? width : 1.5}
            mixed={differs("stroke-width")}
            unit="px"
            min={0}
            step={0.5}
            onChange={(n) => setStyle(ids, { "stroke-width": `${n}px` })}
          />
          <span className="nt-ctl-wide-end">
            <IconToggle
              value={
                differs("stroke-dasharray") ? "" : dashOf(read("stroke-dasharray"))
              }
              options={DASHES}
              onChange={(dash) =>
                setStyle(ids, { "stroke-dasharray": DASHARRAY[dash] })
              }
            />
          </span>
        </div>
      </PanelSection>
    </>
  );
}

/**
 * One end, as a picker over every node the layers panel lists. Naming the ends
 * rather than drawing them is the point: "Auth → Database" is what the diagram
 * says, and it is the only place the connector's meaning is written down.
 */
function EndRow({
  mark,
  scene,
  current,
  exclude,
  onPick,
}: {
  mark: string;
  scene: Scene;
  current: NodeId;
  exclude: NodeId;
  onPick: (id: NodeId) => void;
}) {
  const options: { value: string; label: string }[] = [];
  const walkInto = (nodes: readonly { id: string }[], depth: number) => {
    for (const node of nodes) {
      const full = findNode(scene, node.id);
      if (!full) continue;
      if (full.id !== exclude) {
        options.push({
          value: full.id,
          label: `${"  ".repeat(depth)}${displayName(full)}`,
        });
      }
      if (full.kind === "group") walkInto(full.children, depth + 1);
    }
  };
  walkInto(scene.nodes, 0);

  return (
    <div className="nt-ctl-row">
      <SelectField
        label={mark}
        name={`Connector ${mark.toLowerCase()}`}
        value={current}
        options={options}
        onChange={onPick}
      />
    </div>
  );
}

/**
 * The label, typed where it is read. Uncontrolled and keyed by edge id, so a
 * keystroke does not go through the store and back — the connector re-routes on
 * every scene change, and a controlled field would re-serialize the block on
 * every character.
 */
function LabelField({
  value,
  onChange,
}: {
  value: string;
  onChange: (label: string) => void;
}) {
  const dropped = useRef(false);
  const select = useCallback((el: HTMLInputElement | null) => el?.select(), []);

  return (
    <input
      ref={value === "" ? undefined : select}
      type="text"
      spellCheck={false}
      className="nt-ctl-text"
      aria-label="Connector label"
      placeholder="None"
      defaultValue={value}
      onBlur={(e) => {
        if (dropped.current) {
          dropped.current = false;
          return;
        }
        onChange(e.target.value.trim());
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          dropped.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
