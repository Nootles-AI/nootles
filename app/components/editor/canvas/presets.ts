import { landFragment } from "./engine/clipboard";
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

const INK = "#2b2b28";
const RULE = "#d8d8d4";

const CENTRED = "display: flex; align-items: center; justify-content: center; text-align: center";
const BOX = `background: #f2f2f0; border: 1px solid ${RULE}; border-radius: 10px; ${CENTRED}; color: ${INK}; font-size: 13px`;
const PLAIN = BOX.replace("border-radius: 10px; ", "");
const PILL = BOX.replace("border-radius: 10px", "border-radius: 24px");
const SOFT = BOX.replace(`background: #f2f2f0; border: 1px solid ${RULE}`, "background: #f7f7f5; border: 1px solid #e4e4e0");
const CAPTION = `${CENTRED}; color: #6b6b66; font-size: 12px`;
const LABEL = `${CENTRED}; color: ${INK}; font-size: 13px`;

const SOLID = `background: ${INK}`;
/** Where a page's words and pictures would go. */
const FILLER = "background: #ececea; border-radius: 4px";
/** A browser's own marks: its buttons, its lock. */
const GLYPH = "background: #8a8a85";

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
  <nt-group id="phone" x="260" y="24" w="200" h="420" name="iPhone">
    <nt-rect id="phone-frame" x="0" y="0" w="200" h="420" name="Frame" style="background: #ffffff; border: 3px solid ${INK}; border-radius: 34px"></nt-rect>
    <nt-rect id="phone-island" x="72" y="14" w="56" h="18" name="Island" style="${SOLID}; border-radius: 9px"></nt-rect>
    <nt-text id="phone-time" x="20" y="14" w="44" h="18" name="Time" style="${CENTRED}; color: ${INK}; font-size: 12px; font-weight: 600">9:41</nt-text>
    <nt-group id="phone-signal" x="138" y="18" w="15" h="10" name="Signal">
      <nt-rect id="phone-bar-1" x="0" y="6" w="3" h="4" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>
      <nt-rect id="phone-bar-2" x="4" y="4" w="3" h="6" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>
      <nt-rect id="phone-bar-3" x="8" y="2" w="3" h="8" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>
      <nt-rect id="phone-bar-4" x="12" y="0" w="3" h="10" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>
    </nt-group>
    <nt-group id="phone-battery" x="159" y="18" w="23" h="10" name="Battery">
      <nt-rect id="phone-battery-body" x="0" y="0" w="20" h="10" name="Body" style="border: 1px solid ${INK}; border-radius: 3px"></nt-rect>
      <nt-rect id="phone-battery-charge" x="2" y="2" w="12" h="6" name="Charge" style="${SOLID}; border-radius: 1.5px"></nt-rect>
      <nt-rect id="phone-battery-cap" x="21" y="3" w="2" h="4" name="Cap" style="${SOLID}; border-radius: 1px"></nt-rect>
    </nt-group>
    <nt-rect id="phone-home" x="66" y="406" w="68" h="5" name="Home indicator" style="${SOLID}; border-radius: 2.5px"></nt-rect>
  </nt-group>
</nt-diagram>`;

const BROWSER = `<nt-diagram h="368">
  <nt-group id="browser" x="100" y="24" w="520" h="320" name="Browser">
    <nt-rect id="browser-window" x="0" y="0" w="520" h="320" name="Window" style="background: #ffffff; border: 1px solid ${RULE}; border-radius: 10px"></nt-rect>
    <nt-rect id="browser-tabs" x="1" y="1" w="518" h="37" name="Tab strip" style="background: #f2f2f0; border-radius: 9px 9px 0 0"></nt-rect>
    <nt-group id="browser-controls" x="14" y="15" w="42" h="10" name="Window controls">
      <nt-ellipse id="browser-close" x="0" y="0" w="10" h="10" name="Close" style="background: ${RULE}"></nt-ellipse>
      <nt-ellipse id="browser-minimize" x="16" y="0" w="10" h="10" name="Minimize" style="background: ${RULE}"></nt-ellipse>
      <nt-ellipse id="browser-zoom" x="32" y="0" w="10" h="10" name="Zoom" style="background: ${RULE}"></nt-ellipse>
    </nt-group>
    <nt-rect id="browser-tab" x="72" y="7" w="168" h="31" name="Tab" style="background: #ffffff; border-radius: 8px 8px 0 0; display: flex; align-items: center; padding: 0 12px; color: ${INK}; font-size: 11px">Nootles</nt-rect>
    <nt-rect id="browser-toolbar" x="1" y="38" w="518" h="36" name="Toolbar" style="background: #ffffff; border-bottom: 1px solid #ececea"></nt-rect>
    <nt-group id="browser-nav" x="16" y="51" w="50" h="10" name="Navigation">
      <nt-polygon id="browser-back" x="0" y="0" w="10" h="10" rot="-90" name="Back" sides="3" style="${GLYPH}"></nt-polygon>
      <nt-polygon id="browser-forward" x="20" y="0" w="10" h="10" rot="90" name="Forward" sides="3" style="background: ${RULE}"></nt-polygon>
      <nt-ellipse id="browser-reload" x="40" y="0" w="10" h="10" name="Reload" start="45" sweep="300" inner="0.6" style="${GLYPH}"></nt-ellipse>
    </nt-group>
    <nt-rect id="browser-address" x="80" y="44" w="424" h="24" name="Address bar" style="background: #f2f2f0; border-radius: 12px; display: flex; align-items: center; padding: 0 12px 0 28px; color: #6b6b66; font-size: 11px">nootles.app</nt-rect>
    <nt-group id="browser-lock" x="92" y="51" w="8" h="10" name="Lock">
      <nt-ellipse id="browser-shackle" x="1" y="0" w="6" h="8" name="Shackle" start="270" sweep="180" inner="0.6" style="${GLYPH}"></nt-ellipse>
      <nt-rect id="browser-lock-body" x="0" y="4" w="8" h="6" name="Body" style="${GLYPH}; border-radius: 1.5px"></nt-rect>
    </nt-group>
    <nt-rect id="browser-heading" x="32" y="102" w="180" h="14" name="Heading" style="${FILLER}"></nt-rect>
    <nt-rect id="browser-line-1" x="32" y="132" w="456" h="8" name="Text" style="${FILLER}"></nt-rect>
    <nt-rect id="browser-line-2" x="32" y="148" w="420" h="8" name="Text" style="${FILLER}"></nt-rect>
    <nt-rect id="browser-line-3" x="32" y="164" w="280" h="8" name="Text" style="${FILLER}"></nt-rect>
    <nt-rect id="browser-image" x="32" y="192" w="456" h="104" name="Image" style="background: #f5f5f3; border-radius: 6px"></nt-rect>
  </nt-group>
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
