import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { CAPTION } from "@/app/lib/onboarding/diagramStyle";
import { album, bullet, canvas, check, h2, numbered, p, quote, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A round of user interviews, from plan to findings: the questions, the guide,
 * a page per session, and the synthesis — an affinity map of what was heard,
 * the findings it adds up to, and an album for the screenshots.
 */

const STICKY =
  "background: #f6eec8; border-radius: 3px; display: flex; align-items: center; " +
  "justify-content: center; text-align: center; padding: 8px; color: #3d3a2c; font-size: 12px";

const THEMES: { name: string; notes: string[] }[] = [
  {
    name: "Finding things",
    notes: ["Can’t find last week’s doc", "Searches Slack instead", "Keeps a list of links"],
  },
  {
    name: "Trust",
    notes: ["Checks twice before sending", "Wants a draft first", "Asks a colleague to look"],
  },
  {
    name: "Sharing",
    notes: ["Exports to PDF to share", "Unsure who can see it", "Pastes into email"],
  },
];

/** Stickies under each theme, two across and one below, each a degree or two off square. */
const SLOTS = [
  { dx: 0, dy: 0, rot: -2 },
  { dx: 112, dy: 0, rot: 1 },
  { dx: 0, dy: 84, rot: 2 },
];

const AFFINITY = `<nt-diagram h="228">
${THEMES.map(({ name, notes }, t) => {
  const x = 24 + t * 232;
  return [
    `  <nt-text id="theme-${t + 1}" x="${x}" y="16" w="208" h="20" style="${CAPTION}">${name}</nt-text>`,
    ...notes.map((note, i) => {
      const { dx, dy, rot } = SLOTS[i];
      return `  <nt-rect id="note-${t + 1}-${i + 1}" x="${x + dx}" y="${48 + dy}" w="96" h="72" rot="${rot}" style="${STICKY}">${note}</nt-rect>`;
    }),
  ].join("\n");
}).join("\n")}
</nt-diagram>`;

const session = (n: number) => ({
  title: `Participant ${n}`,
  blocks: [
    table(["Role", "Team size", "Date", "Recording"], ["", "", "", ""]),
    h2("Notes"),
    p("What they did, in order. Write what you saw, not what you think it means — that is for Synthesis."),
    h2("Quotes"),
    quote("Their words, exactly."),
    h2("Surprises"),
    bullet("Anything that contradicted what we expected"),
  ],
});

export const userResearch: ProjectTemplate = {
  id: "userResearch",
  name: "User research",
  description: "A research plan, an interview guide, a page per session and the synthesis",
  rows: [
    {
      kind: "page",
      title: "Plan",
      blocks: [
        p("What we are trying to learn, and the decision it will inform."),
        h2("Research questions"),
        numbered("What do people do today when…"),
        numbered("Where does that break down?"),
        numbered("What would they have to believe to switch?"),
        h2("Method"),
        p("Five to eight 45-minute interviews, recorded, with a task in the middle."),
        h2("Participants"),
        table(
          ["Participant", "Role", "Date", "Status"],
          ["1", "", "", "Booked"],
          ["2", "", "", "Invited"],
          ["3", "", "", ""],
          ["4", "", "", ""],
          ["5", "", "", ""],
        ),
        h2("Screener"),
        check("Has done the task in the last month"),
        check("Not an employee or a close customer"),
      ],
    },
    {
      kind: "page",
      title: "Interview guide",
      blocks: [
        p("The same questions, in the same order, every time. Ask about the last time, not about usually."),
        h2("Warm-up — 5 min"),
        numbered("Tell me about your role, and what a normal week looks like."),
        h2("Context — 15 min"),
        numbered("Walk me through the last time you…"),
        numbered("What happened next?"),
        numbered("What was the hardest part?"),
        h2("Task — 15 min"),
        numbered("Show me how you would… Think aloud as you go."),
        h2("Wrap-up — 10 min"),
        numbered("If you could change one thing about how you do this, what would it be?"),
        numbered("Who else should we talk to?"),
      ],
    },
    { kind: "folder", title: "Sessions", pages: [session(1), session(2)] },
    {
      kind: "page",
      title: "Synthesis",
      blocks: [
        p(
          "What we heard, grouped. Put every observation on a sticky, then drag them into themes — the themes are the finding, not the stickies.",
        ),
        canvas(AFFINITY),
        h2("Findings"),
        table(
          ["Finding", "Evidence", "Heard from"],
          ["", "", "0 of 5"],
          ["", "", "0 of 5"],
        ),
        h2("Screenshots"),
        p("Drop screenshots and photos from the sessions here."),
        album(serializeAlbum({ items: [] })),
        h2("What we will do about it"),
        bullet("The change, and the finding it answers"),
      ],
    },
  ],
};
