import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { check, h2, p, storyboard, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A shoot, from brief to wrap: the brief, a storyboard, the shot list it turns
 * into, and a Shoot day folder for the call sheet and the gear.
 *
 * The board is drawn — a few bold shapes a shot, which is all a frame shown a
 * couple of hundred pixels wide can carry — so a new project opens on a story
 * rather than six empty frames. The shot list below it follows the same six
 * shots, which is the relationship the two pages are meant to keep.
 */

const INK = "#2b2b28";
const STONE = "#d6d3cb";
const FIGURE = "#9d9a92";
const PAPER = "#f7f7f5";
const LIGHT = "#f0d9a8";
const CENTRED =
  "display: flex; align-items: center; justify-content: center; text-align: center";

/** One 16:9 frame, 320 by 180 at its own origin, as every shot is authored. */
const frame = (shapes: string[]) =>
  `<nt-diagram w="320" h="180">\n${shapes.map((s) => `  ${s}`).join("\n")}\n</nt-diagram>`;

const SHOTS: { scene: string; note: string }[] = [
  {
    scene: frame([
      `<nt-ellipse id="sun" x="224" y="30" w="40" h="40" style="background: ${LIGHT}"></nt-ellipse>`,
      `<nt-rect id="studio" x="70" y="64" w="96" h="72" style="background: ${STONE}"></nt-rect>`,
      `<nt-rect id="window" x="104" y="82" w="28" h="20" style="background: ${LIGHT}"></nt-rect>`,
      `<nt-path id="hill" x="0" y="116" w="320" h="64" d="M 0 64 L 0 28 C 80 -6 240 -6 320 28 L 320 64 Z" style="fill: #dfe2d8"></nt-path>`,
    ]),
    note: "Wide. The studio at first light.\nOne window is already lit.",
  },
  {
    scene: frame([
      `<nt-ellipse id="head" x="140" y="44" w="40" h="40" style="background: ${FIGURE}"></nt-ellipse>`,
      `<nt-rect id="body" x="128" y="88" w="64" h="48" style="background: ${FIGURE}; border-radius: 28px 28px 6px 6px"></nt-rect>`,
      `<nt-rect id="laptop" x="200" y="100" w="56" h="32" style="background: ${STONE}; border-radius: 4px"></nt-rect>`,
      `<nt-rect id="desk" x="40" y="132" w="240" h="10" style="background: #b9b6ad"></nt-rect>`,
    ]),
    note: "Medium. They sit down and open the laptop.\nNo music yet.",
  },
  {
    scene: frame([
      `<nt-rect id="device" x="80" y="40" w="160" h="100" style="background: ${STONE}; border-radius: 8px"></nt-rect>`,
      `<nt-rect id="screen" x="92" y="50" w="136" h="76" style="background: ${PAPER}; border-radius: 4px"></nt-rect>`,
      `<nt-ellipse id="hand-left" x="56" y="124" w="76" h="44" style="background: ${FIGURE}"></nt-ellipse>`,
      `<nt-ellipse id="hand-right" x="188" y="124" w="76" h="44" style="background: ${FIGURE}"></nt-ellipse>`,
    ]),
    note: "Close-up. Hands, and the first thing typed.\nHold for a beat.",
  },
  {
    scene: frame([
      `<nt-rect id="screen" x="150" y="32" w="150" h="100" style="background: ${PAPER}; border: 2px solid ${INK}; border-radius: 6px"></nt-rect>`,
      `<nt-rect id="line-1" x="166" y="52" w="90" h="8" style="background: ${STONE}; border-radius: 4px"></nt-rect>`,
      `<nt-rect id="line-2" x="166" y="68" w="112" h="6" style="background: #e4e2dc; border-radius: 3px"></nt-rect>`,
      `<nt-ellipse id="head" x="0" y="40" w="100" h="110" style="background: ${INK}"></nt-ellipse>`,
      `<nt-rect id="shoulder" x="0" y="124" w="160" h="56" style="background: ${INK}; border-radius: 40px 40px 0 0"></nt-rect>`,
    ]),
    note: "Over the shoulder. The screen, readable.\nThe shot the product lives in.",
  },
  {
    scene: frame([
      `<nt-rect id="window" x="40" y="24" w="240" h="132" style="background: #ffffff; border: 1px solid #d8d8d4; border-radius: 8px"></nt-rect>`,
      `<nt-rect id="title" x="60" y="44" w="120" h="12" style="background: #b9b6ad; border-radius: 4px"></nt-rect>`,
      `<nt-rect id="row-1" x="60" y="72" w="200" h="16" style="background: #f2f2f0; border-radius: 4px"></nt-rect>`,
      `<nt-rect id="row-2" x="60" y="96" w="200" h="16" style="background: #f2f2f0; border-radius: 4px"></nt-rect>`,
      `<nt-rect id="row-3" x="60" y="120" w="200" h="16" style="background: #f2f2f0; border-radius: 4px"></nt-rect>`,
      `<nt-ellipse id="done" x="240" y="98" w="12" h="12" style="background: #9fbfa8"></nt-ellipse>`,
    ]),
    note: "Insert. The moment it works.\nScreen recording, not a reshoot.",
  },
  {
    scene: frame([
      `<nt-text id="name" x="60" y="64" w="200" h="32" style="${CENTRED}; color: ${INK}; font-size: 22px; font-weight: 600">Your product</nt-text>`,
      `<nt-text id="url" x="60" y="100" w="200" h="18" style="${CENTRED}; color: #6b6b66; font-size: 12px">yourproduct.com</nt-text>`,
    ]),
    note: "End card. Name and address on white.\nThree seconds, then black.",
  },
];

const BOARD = serializeStoryboard({ ratio: "16:9", shots: SHOTS });

export const videoShoot: ProjectTemplate = {
  id: "videoShoot",
  name: "Video shoot",
  description: "A brief, a storyboard and its shot list, and the call sheet for the day",
  rows: [
    {
      kind: "page",
      title: "Brief",
      blocks: [
        p("What the film is, who it is for, and the one thing a viewer should remember."),
        h2("Deliverables"),
        table(
          ["Cut", "Ratio", "Length", "Due"],
          ["Hero film", "16:9", "60s", ""],
          ["Social cutdown", "9:16", "15s", ""],
          ["Stills", "4:5", "", ""],
        ),
        h2("Tone"),
        p("Three words for how it should feel, and a film or ad it should feel like."),
        h2("References"),
        p("Paste links, or type / and choose Album to collect frames you want to steal from."),
      ],
    },
    {
      kind: "page",
      title: "Storyboard",
      blocks: [
        p(
          "The film, shot by shot. Draw in any frame with the canvas tools, write the action on the lines under it, and change the ratio from the board's toolbar — every frame re-crops to match.",
        ),
        storyboard(BOARD),
      ],
    },
    {
      kind: "page",
      title: "Shot list",
      blocks: [
        p("The board, as the crew reads it on the day. One row a shot, numbered as on the board."),
        table(
          ["#", "Shot", "Framing", "Movement", "Lens", "Done"],
          ["1", "Studio at first light", "Wide", "Static", "24mm", ""],
          ["2", "Sits, opens the laptop", "Medium", "Slow push", "35mm", ""],
          ["3", "Hands, first thing typed", "Close-up", "Static", "85mm", ""],
          ["4", "Screen over the shoulder", "Over the shoulder", "Handheld", "50mm", ""],
          ["5", "It works", "Insert", "Screen recording", "", ""],
          ["6", "End card", "Graphic", "", "", ""],
        ),
      ],
    },
    {
      kind: "folder",
      title: "Shoot day",
      pages: [
        {
          title: "Call sheet",
          blocks: [
            p("Everything the crew needs to arrive in the right place at the right time."),
            h2("Location"),
            p("Address, parking and who lets you in. Type / and choose Location for a map."),
            h2("Schedule"),
            table(
              ["Time", "What"],
              ["07:00", "Crew call, load in"],
              ["08:00", "Shots 1–2"],
              ["10:30", "Shots 3–4"],
              ["12:30", "Lunch"],
              ["13:30", "Insert, pickups"],
              ["16:00", "Wrap"],
            ),
            h2("Crew"),
            table(
              ["Role", "Name", "Phone"],
              ["Director", "", ""],
              ["Camera", "", ""],
              ["Sound", "", ""],
              ["Talent", "", ""],
            ),
          ],
        },
        {
          title: "Gear",
          blocks: [
            p("Packed the night before, checked at wrap."),
            check("Camera body and two batteries"),
            check("Lenses: 24, 35, 50, 85"),
            check("Cards, formatted"),
            check("Lav and boom"),
            check("Two lights and stands"),
            check("Release forms"),
          ],
        },
      ],
    },
  ],
};
