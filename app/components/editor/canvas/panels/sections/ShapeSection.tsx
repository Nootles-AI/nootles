"use client";

import {
  arcOf,
  FULL_ARC,
  type EllipseNode,
  type PolygonNode,
  type SceneNode,
  type ShapeParams,
} from "../../scene/types";
import { ArcRatio, ArcStart, ArcSweep, Sides } from "../controls/glyphs";
import { NumberField } from "../controls/NumberField";
import { PanelSection } from "../controls/PanelSection";
import type { SectionProps } from "../StylePanel";

/** Parametric kinds: the ones whose geometry is more than their box. */
export function hasShapeParams(node: SceneNode): node is PolygonNode | EllipseNode {
  return node.kind === "polygon" || node.kind === "ellipse";
}

type Arc = { start: number; sweep: number; inner: number };
type Read = { value: number; mixed: boolean };

function read<T>(items: readonly T[], pick: (item: T) => number): Read {
  const first = pick(items[0]);
  return { value: first, mixed: items.some((item) => pick(item) !== first) };
}

/** Matches the parser's cap: past a hundred sides it is a circle. */
const MAX_SIDES = 100;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * An arc as the shortest attributes that say it. A field left at its default is
 * **removed**, not written: absence is what makes an ellipse a plain one, so
 * removal is the only way back from a donut to a circle.
 */
function arcParams(arc: Arc): ShapeParams {
  return {
    ...(arc.start === FULL_ARC.start ? {} : { start: arc.start }),
    ...(arc.sweep === FULL_ARC.sweep ? {} : { sweep: arc.sweep }),
    ...(arc.inner === FULL_ARC.inner ? {} : { inner: arc.inner }),
  };
}

/**
 * Polygon sides and the ellipse's arc — Figma's pie and donut controls.
 *
 * `setShape` replaces rather than merges, so every edit here reads the node it
 * is editing and hands back the whole of its geometry; nodes this section has
 * nothing to say about are left out entirely.
 */
export function ShapeSection({ selection, setShape }: SectionProps) {
  const polygons = selection.filter(
    (node): node is PolygonNode => node.kind === "polygon",
  );
  const ellipses = selection.filter(
    (node): node is EllipseNode => node.kind === "ellipse",
  );

  const sides = polygons.length ? read(polygons, (node) => node.sides) : null;
  const arcs = ellipses.map(arcOf);
  const arc = arcs.length
    ? {
        start: read(arcs, (a) => a.start),
        sweep: read(arcs, (a) => a.sweep),
        inner: read(arcs, (a) => a.inner),
      }
    : null;

  const setSides = (n: number) =>
    setShape((node) => (node.kind === "polygon" ? { sides: Math.round(n) } : null));

  const setArc = (key: keyof Arc, value: number) =>
    setShape((node) =>
      node.kind === "ellipse" ? arcParams({ ...arcOf(node), [key]: value }) : null,
    );

  return (
    <PanelSection title="Shape">
      {sides && (
        <div className="ab-ctl-grid">
          <NumberField
            label={<Sides />}
            name="Number of sides"
            value={sides.value}
            mixed={sides.mixed}
            min={3}
            max={MAX_SIDES}
            onChange={setSides}
          />
        </div>
      )}

      {arc && (
        <>
          <div className="ab-ctl-grid">
            <NumberField
              label={<ArcStart />}
              name="Arc start angle"
              unit="°"
              value={arc.start.value}
              mixed={arc.start.mixed}
              onChange={(n) => setArc("start", n)}
            />
            <NumberField
              label={<ArcSweep />}
              name="Arc sweep"
              unit="°"
              value={arc.sweep.value}
              mixed={arc.sweep.mixed}
              min={-360}
              max={360}
              onChange={(n) => setArc("sweep", n)}
            />
          </div>
          <div className="ab-ctl-grid">
            <NumberField
              label={<ArcRatio />}
              name="Inner radius"
              unit="%"
              value={round(arc.inner.value * 100)}
              mixed={arc.inner.mixed}
              min={0}
              max={100}
              onChange={(n) => setArc("inner", round(n / 100))}
            />
          </div>
        </>
      )}
    </PanelSection>
  );
}
