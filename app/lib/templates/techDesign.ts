import { ACCENT, BOX, GHOST_BOX } from "@/app/lib/onboarding/diagramStyle";
import { bullet, canvas, check, h2, p, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A technical design, as a scaffold: the argument a design has to make, and a
 * Design folder for the three things reviewers argue with — the shape, the
 * interfaces, and how it ships. Each figure is already in the kind of block it
 * belongs in, so the reader of a new project sees the page they are about to
 * write rather than a description of it.
 */

/** The new part is the one tinted shape; the rest is context it plugs into. */
const ARCHITECTURE = `<nt-diagram h="360">
  <nt-rect id="client" x="280" y="24" w="160" h="48" style="${GHOST_BOX}">Client</nt-rect>
  <nt-rect id="api" x="280" y="112" w="160" h="48" style="${BOX}">API</nt-rect>
  <nt-rect id="service" x="280" y="200" w="160" h="48" style="${ACCENT}">New service</nt-rect>
  <nt-rect id="cache" x="520" y="200" w="140" h="48" style="${GHOST_BOX}">Cache</nt-rect>
  <nt-rect id="store" x="180" y="288" w="160" h="48" style="${BOX}">Database</nt-rect>
  <nt-rect id="queue" x="380" y="288" w="160" h="48" style="${BOX}">Queue</nt-rect>
  <nt-edge id="e1" from="client" to="api"></nt-edge>
  <nt-edge id="e2" from="api" to="service"></nt-edge>
  <nt-edge id="e3" from="service" to="cache">reads</nt-edge>
  <nt-edge id="e4" from="service" to="store"></nt-edge>
  <nt-edge id="e5" from="service" to="queue">events</nt-edge>
</nt-diagram>`;

const INK = "#2b2b28";
const RAIL = "#d8d8d4";
const MILESTONE = `background: ${INK}`;
const LABEL =
  "display: flex; align-items: center; justify-content: center; text-align: center; " +
  `color: ${INK}; font-size: 13px`;

const STAGES = ["Review", "Shadow", "Beta", "Everyone"];
const ROLLOUT = `<nt-diagram h="96">
  <nt-rect id="rail" x="100" y="31" w="520" h="2" name="Rail" style="background: ${RAIL}"></nt-rect>
${STAGES.map((_, i) => {
  const x = 92 + Math.round((i * 520) / 3);
  return `  <nt-ellipse id="m${i + 1}" x="${x}" y="24" w="16" h="16" name="Milestone" style="${MILESTONE}"></nt-ellipse>`;
}).join("\n")}
${STAGES.map((stage, i) => {
  const x = 30 + Math.round((i * 520) / 3);
  return `  <nt-text id="t${i + 1}" x="${x}" y="52" w="140" h="20" style="${LABEL}">${stage}</nt-text>`;
}).join("\n")}
</nt-diagram>`;

const INTERFACE = `/** What callers can ask of the new service. Types first; the rest follows. */
export interface Service {
  create(input: CreateInput): Promise<Item>;
  get(id: ItemId): Promise<Item | null>;
  list(filter: Filter, page: Cursor): Promise<Page<Item>>;
}

export type CreateInput = {
  ownerId: string;
  // …
};`;

export const techDesign: ProjectTemplate = {
  id: "techDesign",
  name: "Tech design",
  description: "The case for a change, with its architecture, interfaces and rollout",
  rows: [
    {
      kind: "page",
      title: "Summary",
      blocks: [
        p(
          "Two sentences: what changes, and what that buys. Someone who reads only this should be able to say yes or no.",
        ),
        h2("Context"),
        p(
          "How it works today and what is wrong with that. Link the incident, the metric or the ticket — a reviewer should not have to take the problem on trust.",
        ),
        h2("Goals"),
        bullet("What will be true when this ships, stated so it can be checked"),
        h2("Non-goals"),
        bullet("Close enough to be assumed, deliberately not part of this"),
        h2("Proposal"),
        p(
          "The design in one paragraph. The detail — shape, interfaces, rollout — is in the Design folder, one page each, so each can be reviewed on its own.",
        ),
      ],
    },
    {
      kind: "folder",
      title: "Design",
      pages: [
        {
          title: "Architecture",
          blocks: [
            p(
              "The system after the change. Drag the boxes to your own; the tinted one is what this design adds, and everything else is what it plugs into.",
            ),
            canvas(ARCHITECTURE),
            h2("Components"),
            table(
              ["Component", "Owns", "What changes"],
              ["New service", "", ""],
              ["API", "", ""],
              ["Database", "", ""],
            ),
            h2("Capacity"),
            p("The load it has to carry, worked out where the reader can check the arithmetic."),
            {
              type: "mathBlock",
              props: {
                source:
                  "\\text{peak rps} = \\frac{\\text{daily users} \\times \\text{requests per user}}{86\\,400} \\times \\text{peak factor}",
              },
            },
          ],
        },
        {
          title: "Interfaces",
          blocks: [
            p(
              "The contract, written as code. Settle the types first — most review comments on a design are about its interfaces, and they are cheapest to change here.",
            ),
            {
              type: "codeBlock",
              props: { language: "typescript", code: INTERFACE },
            },
            h2("Data model"),
            table(
              ["Field", "Type", "Notes"],
              ["id", "string", "Stable, never reused"],
              ["ownerId", "string", "Indexed"],
              ["createdAt", "number", ""],
            ),
            h2("Migration"),
            bullet("How existing data reaches the new shape"),
            bullet("What reads the old shape while it does"),
          ],
        },
        {
          title: "Rollout",
          blocks: [
            p("How it ships, in stages that can each be stopped."),
            canvas(ROLLOUT),
            check("Design reviewed"),
            check("Shadow: runs beside the old path, compared, never served"),
            check("Beta: a named set of accounts"),
            check("Everyone, with the old path still switchable"),
            h2("Risks"),
            table(
              ["Risk", "Likelihood", "Mitigation"],
              ["", "Low", ""],
              ["", "Medium", ""],
            ),
            h2("Rolling back"),
            p("The one switch that undoes it, and who is allowed to throw it."),
          ],
        },
      ],
    },
    {
      kind: "page",
      title: "Alternatives",
      blocks: [
        p(
          "What else was considered, and why it lost. A design that names no alternative gets asked for one in review.",
        ),
        table(
          ["Option", "For", "Against"],
          ["Do nothing", "", ""],
          ["The proposal", "", ""],
          ["", "", ""],
        ),
        h2("Open questions"),
        check("Question — who can answer it, and by when"),
      ],
    },
  ],
};
