import type { Template } from "../types";
import { BOX, CAPTION, COLUMN } from "../diagramStyle";
import { cell } from "../cell";

const card = (id: string, text: string) =>
  `<nt-rect id="${id}" w="142" h="48" style="${BOX}">${text}</nt-rect>`;

const BEATS = `<nt-diagram w="600" h="288">
  <nt-text id="k1" x="40" y="40" w="162" h="20" style="${CAPTION}">ACT ONE</nt-text>
  <nt-text id="k2" x="218" y="40" w="162" h="20" style="${CAPTION}">ACT TWO</nt-text>
  <nt-text id="k3" x="396" y="40" w="162" h="20" style="${CAPTION}">ACT THREE</nt-text>
  <nt-group id="a1" x="40" y="68" w="162" h="180" style="${COLUMN}">
    ${card("b1", "Arrival")}
    ${card("b2", "The key")}
    ${card("b3", "She stays")}
  </nt-group>
  <nt-group id="a2" x="218" y="68" w="162" h="180" style="${COLUMN}">
    ${card("b4", "The other guest")}
    ${card("b5", "The flats at night")}
    ${card("b6", "What she buried")}
  </nt-group>
  <nt-group id="a3" x="396" y="68" w="162" h="180" style="${COLUMN}">
    ${card("b7", "The road out")}
    ${card("b8", "She goes back")}
    ${card("b9", "Sunrise")}
  </nt-group>
</nt-diagram>`;

export const screenplay: Template = {
  id: "screenplay",
  label: "Film or story",
  blurb: "A logline, a beat sheet, and somewhere to see the shape of it.",
  projectTitle: "Salt Flats",
  description: "A woman checks into a motel she has no memory of booking.",
  showcase: {
    heading: "Scenes",
    caption: "Prose, a board you can drag, and a table. One page.",
    block: {
      type: "table",
      content: {
        type: "tableContent",
        headerRows: 1,
        rows: [
          { cells: [cell("#"), cell("Where"), cell("Who"), cell("Pages")] },
          { cells: [cell("1"), cell("The flats"), cell("Mara"), cell("2")] },
          { cells: [cell("2"), cell("Motel office"), cell("Mara, Dell"), cell("3")] },
          { cells: [cell("3"), cell("Room 11"), cell("Mara"), cell("1")] },
        ],
      },
    },
  },
  pages: [
    {
      title: "Salt Flats",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Salt Flats" },
        {
          type: "paragraph",
          content:
            "A woman checks into a desert motel she has no memory of booking, and finds a room already made up for her.",
        },
        { id: "nt-tour-slash", type: "paragraph", content: "" },
        {
          type: "paragraph",
          content:
            "Cold open on the flats at four in the afternoon — white ground, white sky, no horizon between them. A car has stopped where the road stops.",
        },
        {
          id: "nt-tour-write",
          type: "paragraph",
          content: "MARA arrives at the motel with no luggage and",
        },
        { type: "heading", props: { level: 2 }, content: "Structure" },
        {
          id: "nt-tour-draw",
          type: "paragraph",
          content: "The shape of it, act by act:",
        },
        { type: "heading", props: { level: 2 }, content: "Questions" },
        {
          type: "bulletListItem",
          content: "Does the audience learn what she buried before she does?",
        },
        {
          type: "bulletListItem",
          content: "Is the other guest real? Does it matter either way?",
        },
      ],
    },
    {
      title: "Characters",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Characters" },
        {
          type: "paragraph",
          content: "Who they are when nobody is watching them.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-tour-write",
      ghost: " a room key she does not remember being given.",
    },
    draw: {
      blockId: "nt-tour-draw",
      brief: "the three-act beat board for Salt Flats, one column per act",
      html: BEATS,
    },
    priorChat: {
      title: "The other guest",
      asked: "Does it hurt the ending if the other guest turns out to be real?",
      answered:
        "It changes what the film is about rather than hurting it. Real, and this is a story about someone she has to get past. Not real, and it is a story about what she is carrying. Both work — but the ending has to be written for one of them rather than hedged between the two.",
    },
    ask: "Read the beat sheet, then suggest three ways act two could complicate what Mara wants.",
    suggest: {
      type: "table",
      label: "Table",
      hint: "One row per scene, once the beats settle.",
    },
  },
};
