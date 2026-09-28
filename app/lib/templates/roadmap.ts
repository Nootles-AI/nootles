import { BOX, CAPTION, GHOST_BOX } from "@/app/lib/onboarding/diagramStyle";
import { bullet, canvas, check, h2, maths, p, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A roadmap, as a scaffold: the board everyone looks at, the scoring that
 * decides what goes on it, and a folder for the one-page brief each
 * initiative gets before it is started.
 *
 * Now / Next / Later rather than dates, because a roadmap that promises
 * quarters is a roadmap that is wrong by the second one.
 */

const LANE = "background: #f8fafc; border: 1px solid #e3e7ee; border-radius: 10px";
const LANES: { name: string; cards: string[]; style: string }[] = [
  { name: "Now", cards: ["Initiative", "Initiative", "Initiative"], style: BOX },
  { name: "Next", cards: ["Initiative", "Initiative"], style: BOX },
  { name: "Later", cards: ["Idea", "Idea"], style: GHOST_BOX },
];

const BOARD = `<nt-diagram h="236">
${LANES.map(({ name, cards, style }, l) => {
  const x = 24 + l * 232;
  const id = name.toLowerCase();
  return [
    `  <nt-text id="${id}" x="${x}" y="16" w="208" h="20" style="${CAPTION}">${name}</nt-text>`,
    `  <nt-rect id="${id}-lane" x="${x}" y="44" w="208" h="168" style="${LANE}"></nt-rect>`,
    ...cards.map(
      (card, i) =>
        `  <nt-rect id="${id}-${i + 1}" x="${x + 12}" y="${56 + i * 52}" w="184" h="44" style="${style}">${card}</nt-rect>`,
    ),
  ].join("\n");
}).join("\n")}
</nt-diagram>`;

export const roadmap: ProjectTemplate = {
  id: "roadmap",
  name: "Roadmap",
  description: "Now, next and later, the scoring behind it, and a brief per initiative",
  rows: [
    {
      kind: "page",
      title: "Roadmap",
      blocks: [
        p(
          "What the team is working on, what comes after, and what is only an idea. Move a card when the plan moves — this page is only useful while it is true.",
        ),
        canvas(BOARD),
        h2("Now, in detail"),
        table(
          ["Initiative", "Outcome", "Owner", "Status"],
          ["", "", "", "On track"],
          ["", "", "", "At risk"],
          ["", "", "", "Not started"],
        ),
        p(
          "How the order was decided is on Prioritisation. Each initiative gets a brief in the Initiatives folder before it moves into Now.",
        ),
      ],
    },
    {
      kind: "page",
      title: "Prioritisation",
      blocks: [
        p(
          "Every candidate scored the same way, so the argument is about the inputs rather than the order.",
        ),
        maths(
          "\\text{score} = \\frac{\\text{reach} \\times \\text{impact} \\times \\text{confidence}}{\\text{effort}}",
        ),
        bullet("Reach — people affected per quarter"),
        bullet("Impact — 3 massive, 2 high, 1 medium, 0.5 low"),
        bullet("Confidence — 100%, 80% or 50%; below that, research first"),
        bullet("Effort — person-weeks"),
        table(
          ["Initiative", "Reach", "Impact", "Confidence", "Effort", "Score"],
          ["", "", "", "", "", ""],
          ["", "", "", "", "", ""],
          ["", "", "", "", "", ""],
        ),
      ],
    },
    {
      kind: "folder",
      title: "Initiatives",
      pages: [
        {
          title: "Initiative brief",
          blocks: [
            p("One page per initiative. Duplicate this one and rename it."),
            h2("Problem"),
            p("Who has it, and the evidence that they do."),
            h2("Bet"),
            p("What we will build, and why we think it solves the problem."),
            h2("How we will know"),
            p("The measure, its value today, and the value that means it worked."),
            h2("Milestones"),
            check("Brief agreed"),
            check("First version in front of users"),
            check("Measured against the target"),
          ],
        },
        {
          title: "Parking lot",
          blocks: [
            p(
              "Ideas that are not on the board. Written down so they stop being re-raised, and so they can be scored when there is room.",
            ),
            bullet("Idea — who raised it, and when"),
          ],
        },
      ],
    },
  ],
};
