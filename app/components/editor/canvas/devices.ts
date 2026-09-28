/**
 * The two device mockups, as markup a diagram can hold: an iPhone and a
 * browser window, each one group of ordinary shapes.
 *
 * Their own module, free of the canvas engine, because more than the preset
 * bar draws them — a project template seeds a page of empty screens with the
 * same devices, and must not pull the scene engine into the projects screen to
 * do it. The id is a prefix for every part, so several devices can share one
 * diagram.
 */

export const INK = "#2b2b28";
export const RULE = "#d8d8d4";
export const CENTRED =
  "display: flex; align-items: center; justify-content: center; text-align: center";

const SOLID = `background: ${INK}`;
/** Where a page's words and pictures would go. */
const FILLER = "background: #ececea; border-radius: 4px";
/** A browser's own marks: its buttons, its lock. */
const GLYPH = "background: #8a8a85";

export const PHONE_W = 200;
export const PHONE_H = 420;

export function phone(id: string, x: number, y: number, pad = "  "): string {
  return [
    `<nt-group id="${id}" x="${x}" y="${y}" w="${PHONE_W}" h="${PHONE_H}" name="iPhone">`,
    `  <nt-rect id="${id}-frame" x="0" y="0" w="${PHONE_W}" h="${PHONE_H}" name="Frame" style="background: #ffffff; border: 3px solid ${INK}; border-radius: 34px"></nt-rect>`,
    `  <nt-rect id="${id}-island" x="72" y="14" w="56" h="18" name="Island" style="${SOLID}; border-radius: 9px"></nt-rect>`,
    `  <nt-text id="${id}-time" x="20" y="14" w="44" h="18" name="Time" style="${CENTRED}; color: ${INK}; font-size: 12px; font-weight: 600">9:41</nt-text>`,
    `  <nt-group id="${id}-signal" x="138" y="18" w="15" h="10" name="Signal">`,
    `    <nt-rect id="${id}-bar-1" x="0" y="6" w="3" h="4" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>`,
    `    <nt-rect id="${id}-bar-2" x="4" y="4" w="3" h="6" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>`,
    `    <nt-rect id="${id}-bar-3" x="8" y="2" w="3" h="8" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>`,
    `    <nt-rect id="${id}-bar-4" x="12" y="0" w="3" h="10" name="Bar" style="${SOLID}; border-radius: 1px"></nt-rect>`,
    `  </nt-group>`,
    `  <nt-group id="${id}-battery" x="159" y="18" w="23" h="10" name="Battery">`,
    `    <nt-rect id="${id}-battery-body" x="0" y="0" w="20" h="10" name="Body" style="border: 1px solid ${INK}; border-radius: 3px"></nt-rect>`,
    `    <nt-rect id="${id}-battery-charge" x="2" y="2" w="12" h="6" name="Charge" style="${SOLID}; border-radius: 1.5px"></nt-rect>`,
    `    <nt-rect id="${id}-battery-cap" x="21" y="3" w="2" h="4" name="Cap" style="${SOLID}; border-radius: 1px"></nt-rect>`,
    `  </nt-group>`,
    `  <nt-rect id="${id}-home" x="66" y="406" w="68" h="5" name="Home indicator" style="${SOLID}; border-radius: 2.5px"></nt-rect>`,
    `</nt-group>`,
  ]
    .map((line) => pad + line)
    .join("\n");
}

export const BROWSER_W = 520;
export const BROWSER_H = 320;

/** `skeleton` draws a page's placeholder lines inside; without it the window is empty. */
export function browser(
  id: string,
  x: number,
  y: number,
  { address = "nootles.app", skeleton = true, pad = "  " } = {},
): string {
  const lines = [
    `<nt-group id="${id}" x="${x}" y="${y}" w="${BROWSER_W}" h="${BROWSER_H}" name="Browser">`,
    `  <nt-rect id="${id}-window" x="0" y="0" w="${BROWSER_W}" h="${BROWSER_H}" name="Window" style="background: #ffffff; border: 1px solid ${RULE}; border-radius: 10px"></nt-rect>`,
    `  <nt-rect id="${id}-toolbar" x="1" y="1" w="518" h="43" name="Toolbar" style="background: #f5f5f3; border-bottom: 1px solid #ececea; border-radius: 9px 9px 0 0"></nt-rect>`,
    `  <nt-group id="${id}-controls" x="14" y="17" w="42" h="10" name="Window controls">`,
    `    <nt-ellipse id="${id}-close" x="0" y="0" w="10" h="10" name="Close" style="background: #ee6a5f"></nt-ellipse>`,
    `    <nt-ellipse id="${id}-minimize" x="16" y="0" w="10" h="10" name="Minimize" style="background: #f5be4f"></nt-ellipse>`,
    `    <nt-ellipse id="${id}-zoom" x="32" y="0" w="10" h="10" name="Zoom" style="background: #62c554"></nt-ellipse>`,
    `  </nt-group>`,
    `  <nt-rect id="${id}-address" x="150" y="10" w="220" h="24" name="Address bar" style="background: #ffffff; border: 1px solid #ececea; border-radius: 7px; display: flex; align-items: center; justify-content: center; padding: 0 12px; color: #6b6b66; font-size: 11px">${address}</nt-rect>`,
    `  <nt-group id="${id}-lock" x="200" y="17" w="8" h="10" name="Lock">`,
    `    <nt-ellipse id="${id}-shackle" x="1" y="0" w="6" h="8" name="Shackle" start="270" sweep="180" inner="0.6" style="${GLYPH}"></nt-ellipse>`,
    `    <nt-rect id="${id}-lock-body" x="0" y="4" w="8" h="6" name="Body" style="${GLYPH}; border-radius: 1.5px"></nt-rect>`,
    `  </nt-group>`,
    `  <nt-ellipse id="${id}-reload" x="354" y="17" w="10" h="10" name="Reload" start="45" sweep="300" inner="0.6" style="${GLYPH}"></nt-ellipse>`,
    ...(skeleton
      ? [
          `  <nt-group id="${id}-skeleton" x="32" y="72" w="456" h="224" name="Skeleton">`,
          `    <nt-rect id="${id}-heading" x="0" y="0" w="180" h="14" name="Heading" style="${FILLER}"></nt-rect>`,
          `    <nt-rect id="${id}-line-1" x="0" y="30" w="456" h="8" name="Text" style="${FILLER}"></nt-rect>`,
          `    <nt-rect id="${id}-line-2" x="0" y="46" w="420" h="8" name="Text" style="${FILLER}"></nt-rect>`,
          `    <nt-rect id="${id}-line-3" x="0" y="62" w="280" h="8" name="Text" style="${FILLER}"></nt-rect>`,
          `    <nt-rect id="${id}-image" x="0" y="90" w="456" h="134" name="Image" style="background: #f5f5f3; border-radius: 6px"></nt-rect>`,
          `  </nt-group>`,
        ]
      : []),
    `</nt-group>`,
  ];
  return lines.map((line) => pad + line).join("\n");
}
