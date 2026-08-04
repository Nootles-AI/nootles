import type { Template } from "../types";
import { BOX, CAPTION } from "../diagramStyle";

const ELEVATION = `<nt-diagram w="600" h="436">
  <nt-rect id="top" x="100" y="40" w="400" h="26" style="${BOX}">Top · 18 × 14</nt-rect>
  <nt-rect id="apron" x="138" y="66" w="324" h="34" style="${BOX}">Apron</nt-rect>
  <nt-rect id="legL" x="112" y="66" w="26" h="300" style="${BOX}"></nt-rect>
  <nt-rect id="legR" x="462" y="66" w="26" h="300" style="${BOX}"></nt-rect>
  <nt-rect id="str" x="138" y="300" w="324" h="16" style="${BOX}"></nt-rect>
  <nt-text id="t1" x="504" y="196" w="56" h="20" style="${CAPTION}">24 in</nt-text>
  <nt-text id="t2" x="112" y="382" w="300" h="20" style="${CAPTION}">Stretcher, 4 in above the floor</nt-text>
</nt-diagram>`;

export const woodworking: Template = {
  id: "woodworking",
  label: "Something you are building",
  blurb: "A cut list, the joinery, and a drawing to argue with.",
  projectTitle: "Walnut side table",
  description: "18 by 14 by 24, walnut, mortise and tenon, oil finish.",
  showcase: {
    heading: "Board feet",
    caption: "Prose, a drawing you can drag, and maths that computes. One page.",
    block: {
      type: "mathBlock",
      // Name a number once and the rows below it stay right when it changes.
      props: {
        source: [
          "top = \\frac{18 \\times 14}{144}",
          "aprons = \\frac{4 \\times 14 \\times 3.5}{144}",
          "waste = 1.15",
          "total = (top + aprons) \\times waste",
        ].join("\n"),
      },
    },
  },
  pages: [
    {
      title: "Walnut side table",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Walnut side table" },
        {
          type: "paragraph",
          content:
            "18 wide, 14 deep, 24 tall. Walnut throughout, mortise and tenon at the aprons, oil and wax.",
        },
        { type: "heading", props: { level: 2 }, content: "Stock" },
        {
          type: "paragraph",
          content:
            "One 8-foot board of 4/4 walnut for the top and aprons, and a length of 8/4 for the legs. Mill everything oversize and let it sit a week before final dimensioning — the shop swings fifteen degrees between morning and afternoon.",
        },
        {
          id: "nt-tour-write",
          type: "paragraph",
          content: "Legs are 1¾ square, tapered from",
        },
        { type: "heading", props: { level: 2 }, content: "How it goes together" },
        {
          id: "nt-tour-draw",
          type: "paragraph",
          content: "Front elevation:",
        },
        { type: "heading", props: { level: 2 }, content: "Order of work" },
        { type: "bulletListItem", content: "Mill the legs, cut the mortises." },
        { type: "bulletListItem", content: "Aprons to length, tenons to fit." },
        { type: "bulletListItem", content: "Dry fit the whole thing before glue." },
        { type: "bulletListItem", content: "Top last, so it can be flattened once." },
      ],
    },
    {
      title: "Cut list",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Cut list" },
        {
          type: "paragraph",
          content: "Finished dimensions. Add an inch to every length for now.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-tour-write",
      ghost: " 12 inches down to 1¼ at the floor, on the two inside faces only.",
    },
    draw: {
      blockId: "nt-tour-draw",
      brief:
        "a front elevation of the side table showing the top, aprons, tapered legs and the stretcher",
      html: ELEVATION,
    },
    priorChat: {
      title: "Wood movement",
      asked: "Do I need to worry about the top moving if it is only 18 inches wide?",
      answered:
        "Yes — roughly an eighth of an inch across the grain between summer and winter for walnut at that width. Not enough to see, plenty to split a top that is screwed down hard. Buttons or elongated screw holes and it moves without telling you about it.",
    },
    ask: "Read this page and work out how much 4/4 walnut I need in board feet, allowing 15% for waste.",
    suggest: {
      type: "mathBlock",
      label: "Math block",
      hint: "Name a variable once and reuse it down the page.",
    },
  },
};
