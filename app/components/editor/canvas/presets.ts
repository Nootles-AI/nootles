import { landFragment } from "./engine/clipboard";
import { parseScene, type ParseHtml } from "./scene/parse";
import { canonicalPath } from "./scene/canonicalPaths";
import type { NodeId, Scene, SceneOp } from "./scene/types";

/**
 * What a new diagram can start from: a handful of drawings, each written in
 * the grammar every other diagram is stored in — band coordinates, the text's
 * left edge at x = 0, the first shape a band below the top — so choosing one
 * is a paste of it, through the same ops.
 *
 * The two mockups are each ONE path, a device outline you draw into rather
 * than a kit of parts to keep together. They are filled with `evenodd` rather
 * than stroked: a single path has a single stroke width, and the phone needs a
 * bezel, a battery with charge in it and a clock that reads at 10px, which only
 * filled geometry gives. The rings are an outline and its inset; everything
 * inside the screen is an odd number of outlines deep, and so solid.
 */

export type PresetId = "flowchart" | "phone" | "browser" | "matrix" | "timeline" | "board";

export type Preset = {
  id: PresetId;
  label: string;
  /** The tooltip: what it draws. */
  title: string;
  html: string;
};

const INK = "#2b2b28";

const BOX =
  "background: #f2f2f0; border: 1px solid #d8d8d4; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "text-align: center; color: #2b2b28; font-size: 13px";
const PLAIN = BOX.replace("border-radius: 10px; ", "");
const PILL = BOX.replace("border-radius: 10px", "border-radius: 24px");
const SOFT = BOX.replace("background: #f2f2f0; border: 1px solid #d8d8d4", "background: #f7f7f5; border: 1px solid #e4e4e0");
const CAPTION =
  "display: flex; align-items: center; justify-content: center; text-align: center; color: #6b6b66; font-size: 12px";
const LABEL = CAPTION.replace("color: #6b6b66; font-size: 12px", "color: #2b2b28; font-size: 13px");
const LANE =
  "background: #f7f7f5; border: 1px solid #e4e4e0; border-radius: 10px; " +
  "display: flex; align-items: flex-start; justify-content: flex-start; padding: 12px 14px; " +
  "color: #6b6b66; font-size: 12px; font-weight: 600";
const CARD =
  "background: #ffffff; border: 1px solid #d8d8d4; border-radius: 8px; " +
  "display: flex; align-items: center; padding: 0 14px; color: #2b2b28; font-size: 13px";
const DEVICE = `fill: ${INK}; fill-rule: evenodd`;

// ---- Path geometry -----------------------------------------------------------

/** The cubic that draws a quarter circle. */
const K = 0.5522847498;
const n = (v: number) => String(Math.round(v * 1000) / 1000);

/** A rectangle outline, its corners rounded by `r`, clockwise from its top edge. */
function box(x: number, y: number, w: number, h: number, r = 0): string {
  if (r === 0) return `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w)} ${n(y + h)} L ${n(x)} ${n(y + h)} Z`;
  const c = r * K;
  const [l, t, rt, b] = [x, y, x + w, y + h];
  return [
    `M ${n(l + r)} ${n(t)}`,
    `L ${n(rt - r)} ${n(t)}`,
    `C ${n(rt - r + c)} ${n(t)} ${n(rt)} ${n(t + r - c)} ${n(rt)} ${n(t + r)}`,
    `L ${n(rt)} ${n(b - r)}`,
    `C ${n(rt)} ${n(b - r + c)} ${n(rt - r + c)} ${n(b)} ${n(rt - r)} ${n(b)}`,
    `L ${n(l + r)} ${n(b)}`,
    `C ${n(l + r - c)} ${n(b)} ${n(l)} ${n(b - r + c)} ${n(l)} ${n(b - r)}`,
    `L ${n(l)} ${n(t + r)}`,
    `C ${n(l)} ${n(t + r - c)} ${n(l + r - c)} ${n(t)} ${n(l + r)} ${n(t)}`,
    "Z",
  ].join(" ");
}

/** An outline and its inset by `t`: a frame `t` thick. */
const ring = (x: number, y: number, w: number, h: number, r: number, t: number) =>
  `${box(x, y, w, h, r)} ${box(x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t))}`;

const dot = (cx: number, cy: number, r: number) => box(cx - r, cy - r, 2 * r, 2 * r, r);

/** Seven-segment digits, each segment its own rectangle and none overlapping, so `evenodd` fills every one. */
function digit(ch: string, x: number, y: number, w: number, h: number, t: number): string {
  const m = y + (h - t) / 2;
  const seg: Record<string, string> = {
    a: box(x, y, w, t),
    g: box(x, m, w, t),
    d: box(x, y + h - t, w, t),
    f: box(x, y + t, t, m - y - t),
    b: box(x + w - t, y + t, t, m - y - t),
    e: box(x, m + t, t, y + h - t - m - t),
    c: box(x + w - t, m + t, t, y + h - t - m - t),
  };
  switch (ch) {
    case "9":
      return [seg.a, seg.f, seg.b, seg.g, seg.c, seg.d].join(" ");
    case "4":
      // No top bar, so the uprights run to the top.
      return [box(x, y, t, m - y), box(x + w - t, y, t, m - y), seg.g, seg.c].join(" ");
    case "1":
      return box(x, y, t, h);
    case ":":
      return [box(x, y + 2.2, t, t), box(x, y + h - 2.2 - t, t, t)].join(" ");
    default:
      return "";
  }
}

/** A clock face's worth of digits, advancing by each glyph's own width. */
function clock(text: string, x: number, y: number): string {
  const [w, h, t, gap] = [6, 10, 1.6, 1.6];
  const out: string[] = [];
  for (const ch of text) {
    out.push(digit(ch, x, y, w, h, t));
    x += (ch === ":" || ch === "1" ? t : w) + gap;
  }
  return out.join(" ");
}

const path = (...parts: string[]) => canonicalPath(parts.join(" "));

const PHONE_D = path(
  ring(0, 0, 200, 420, 34, 4),
  box(72, 14, 56, 18, 9),
  clock("9:41", 28, 18),
  box(140, 24, 3, 4),
  box(144.5, 22, 3, 6),
  box(149, 20, 3, 8),
  box(153.5, 18, 3, 10),
  ring(161.5, 18.5, 20, 9, 2.5, 1.2),
  box(164, 21, 11, 4),
  box(182.3, 21.2, 1.5, 3.6),
  box(66, 402, 68, 5, 2.5),
);

const BROWSER_D = path(
  ring(0, 0, 520, 320, 10, 1.5),
  box(1.5, 34, 517, 1.5),
  dot(20, 18, 5),
  dot(36, 18, 5),
  dot(52, 18, 5),
  ring(150, 9, 220, 18, 9, 1.5),
);

// ---- The presets ---------------------------------------------------------------

const FLOWCHART = `<nt-diagram h="336">
  <nt-rect id="process" x="286" y="24" w="148" h="56" style="${BOX}">Process</nt-rect>
  <nt-polygon id="condition" x="280" y="120" w="160" h="96" sides="4" style="${PLAIN}">Condition</nt-polygon>
  <nt-rect id="end-a" x="132" y="264" w="148" h="48" style="${PILL}">End state</nt-rect>
  <nt-rect id="end-b" x="440" y="264" w="148" h="48" style="${PILL}">End state</nt-rect>
  <nt-edge id="e1" from="process" to="condition"></nt-edge>
  <nt-edge id="e2" from="condition" to="end-a"></nt-edge>
  <nt-edge id="e3" from="condition" to="end-b"></nt-edge>
</nt-diagram>`;

const PHONE = `<nt-diagram h="468">
  <nt-path id="phone" x="260" y="24" w="200" h="420" d="${PHONE_D}" style="${DEVICE}"></nt-path>
</nt-diagram>`;

const BROWSER = `<nt-diagram h="368">
  <nt-path id="browser" x="100" y="24" w="520" h="320" d="${BROWSER_D}" style="${DEVICE}"></nt-path>
</nt-diagram>`;

const MATRIX = `<nt-diagram h="328">
  <nt-rect id="quick-wins" x="156" y="24" w="200" h="120" style="${SOFT}">Quick wins</nt-rect>
  <nt-rect id="big-bets" x="364" y="24" w="200" h="120" style="${SOFT}">Big bets</nt-rect>
  <nt-rect id="fill-ins" x="156" y="152" w="200" h="120" style="${SOFT}">Fill-ins</nt-rect>
  <nt-rect id="money-pits" x="364" y="152" w="200" h="120" style="${SOFT}">Money pits</nt-rect>
  <nt-text id="effort" x="260" y="284" w="200" h="20" style="${CAPTION}">Effort →</nt-text>
  <nt-text id="impact" x="78" y="138" w="120" h="20" rot="-90" style="${CAPTION}">Impact →</nt-text>
</nt-diagram>`;

const TIMELINE = `<nt-diagram h="96">
  <nt-rect id="rail" x="100" y="31" w="520" h="2" style="background: #d8d8d4"></nt-rect>
  <nt-ellipse id="m1" x="92" y="24" w="16" h="16" style="background: ${INK}"></nt-ellipse>
  <nt-ellipse id="m2" x="265" y="24" w="16" h="16" style="background: ${INK}"></nt-ellipse>
  <nt-ellipse id="m3" x="439" y="24" w="16" h="16" style="background: ${INK}"></nt-ellipse>
  <nt-ellipse id="m4" x="612" y="24" w="16" h="16" style="background: ${INK}"></nt-ellipse>
  <nt-text id="t1" x="30" y="52" w="140" h="20" style="${LABEL}">Kickoff</nt-text>
  <nt-text id="t2" x="203" y="52" w="140" h="20" style="${LABEL}">Prototype</nt-text>
  <nt-text id="t3" x="377" y="52" w="140" h="20" style="${LABEL}">Beta</nt-text>
  <nt-text id="t4" x="550" y="52" w="140" h="20" style="${LABEL}">Launch</nt-text>
</nt-diagram>`;

const BOARD = `<nt-diagram h="244">
  <nt-rect id="todo" x="24" y="24" w="216" h="196" style="${LANE}">To do</nt-rect>
  <nt-rect id="doing" x="252" y="24" w="216" h="196" style="${LANE}">Doing</nt-rect>
  <nt-rect id="done" x="480" y="24" w="216" h="196" style="${LANE}">Done</nt-rect>
  <nt-rect id="card-1" x="36" y="64" w="192" h="56" style="${CARD}">Next up</nt-rect>
  <nt-rect id="card-2" x="264" y="64" w="192" h="56" style="${CARD}">In progress</nt-rect>
  <nt-rect id="card-3" x="492" y="64" w="192" h="56" style="${CARD}">Shipped</nt-rect>
</nt-diagram>`;

export const PRESETS: readonly Preset[] = [
  { id: "flowchart", label: "Flowchart", title: "A process, a condition and two end states", html: FLOWCHART },
  { id: "phone", label: "iPhone", title: "An iPhone screen to draw into", html: PHONE },
  { id: "browser", label: "Browser", title: "A browser window to draw into", html: BROWSER },
  { id: "matrix", label: "Matrix", title: "A two-by-two of impact against effort", html: MATRIX },
  { id: "timeline", label: "Timeline", title: "Four milestones on a line", html: TIMELINE },
  { id: "board", label: "Board", title: "To do, Doing and Done, a card in each", html: BOARD },
];

/**
 * The ops that put a preset into a diagram, as a paste of it would land, and
 * the ids its shapes land under.
 */
export function presetOps(
  target: Scene,
  preset: Preset,
  parseHtml?: ParseHtml,
): { ops: SceneOp[]; ids: NodeId[] } {
  return landFragment(target, parseScene(preset.html, parseHtml));
}
