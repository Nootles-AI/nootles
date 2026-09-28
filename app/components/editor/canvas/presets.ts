import { landFragment } from "./engine/clipboard";
import { browser, CENTRED, INK, phone, RULE } from "./devices";
import { parseScene, type ParseHtml } from "./scene/parse";
import type { NodeId, Scene, SceneOp } from "./scene/types";

/**
 * What a new diagram can start from: a handful of drawings, each written in
 * the grammar every other diagram is stored in — band coordinates, the text's
 * left edge at x = 0, the first shape a band below the top — so choosing one
 * is a paste of it, through the same ops.
 *
 * Every part is a shape the toolbar could have drawn. The two mockups are
 * groups, so a device moves and selects as one thing and a double-click goes
 * inside to restyle the island, retype the clock or drop the toolbar; the
 * parts that only mean something together (the signal bars, the battery, the
 * window controls) are groups of their own inside it. None of them lays its
 * children out: a device is drawn, not flowed.
 */

export type PresetId = "flowchart" | "phone" | "browser" | "matrix" | "timeline";

export type Preset = {
  id: PresetId;
  label: string;
  /** The tooltip: what it draws. */
  title: string;
  html: string;
};

const BOX = `background: #f2f2f0; border: 1px solid ${RULE}; border-radius: 10px; ${CENTRED}; color: ${INK}; font-size: 13px`;
const PLAIN = BOX.replace("border-radius: 10px; ", "");
const PILL = BOX.replace("border-radius: 10px", "border-radius: 24px");
const SOFT = BOX.replace(`background: #f2f2f0; border: 1px solid ${RULE}`, "background: #f7f7f5; border: 1px solid #e4e4e0");
const CAPTION = `${CENTRED}; color: #6b6b66; font-size: 12px`;
const LABEL = `${CENTRED}; color: ${INK}; font-size: 13px`;

const SOLID = `background: ${INK}`;

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
${phone("phone", 260, 24)}
</nt-diagram>`;

const BROWSER = `<nt-diagram h="368">
${browser("browser", 100, 24)}
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
  <nt-rect id="rail" x="100" y="31" w="520" h="2" name="Rail" style="background: ${RULE}"></nt-rect>
  <nt-ellipse id="m1" x="92" y="24" w="16" h="16" name="Milestone" style="${SOLID}"></nt-ellipse>
  <nt-ellipse id="m2" x="265" y="24" w="16" h="16" name="Milestone" style="${SOLID}"></nt-ellipse>
  <nt-ellipse id="m3" x="439" y="24" w="16" h="16" name="Milestone" style="${SOLID}"></nt-ellipse>
  <nt-ellipse id="m4" x="612" y="24" w="16" h="16" name="Milestone" style="${SOLID}"></nt-ellipse>
  <nt-text id="t1" x="30" y="52" w="140" h="20" style="${LABEL}">Kickoff</nt-text>
  <nt-text id="t2" x="203" y="52" w="140" h="20" style="${LABEL}">Prototype</nt-text>
  <nt-text id="t3" x="377" y="52" w="140" h="20" style="${LABEL}">Beta</nt-text>
  <nt-text id="t4" x="550" y="52" w="140" h="20" style="${LABEL}">Launch</nt-text>
</nt-diagram>`;

export const PRESETS: readonly Preset[] = [
  { id: "flowchart", label: "Flowchart", title: "A process, a condition and two end states", html: FLOWCHART },
  { id: "phone", label: "iPhone", title: "An iPhone wireframe, every part editable", html: PHONE },
  { id: "browser", label: "Browser", title: "A browser window wireframe, every part editable", html: BROWSER },
  { id: "matrix", label: "Matrix", title: "A two-by-two of impact against effort", html: MATRIX },
  { id: "timeline", label: "Timeline", title: "Four milestones on a line", html: TIMELINE },
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
