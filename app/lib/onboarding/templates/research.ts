import type { Template } from "../types";
import { CELL, HEAD } from "../diagramStyle";

const cell = (id: string, text: string, style = CELL) =>
  `<nt-rect id="${id}" w="172" h="44" style="${style}">${text}</nt-rect>`;

const DESIGN = `<nt-diagram w="600" h="261">
  <nt-group id="g1" x="40" y="40" w="520" h="181" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; padding: 1px; background: #d8d8d4">
    ${cell("h1", "Method", HEAD)}
    ${cell("h2", "Who", HEAD)}
    ${cell("h3", "What it answers", HEAD)}
    ${cell("c1", "Session replay")}
    ${cell("c2", "20 churned")}
    ${cell("c3", "Where they stall")}
    ${cell("c4", "Interviews")}
    ${cell("c5", "8 churned")}
    ${cell("c6", "Why they stopped")}
    ${cell("c7", "Cohort SQL")}
    ${cell("c8", "All since March")}
    ${cell("c9", "When exactly")}
  </nt-group>
</nt-diagram>`;

export const research: Template = {
  id: "research",
  label: "A question to investigate",
  blurb: "What you know, how you will find out, and what would change your mind.",
  projectTitle: "Why users churn at day eight",
  description:
    "Retention is flat for a week and then falls off. Finding out what happens on day eight.",
  roles: [
    "Researcher",
    "Product manager",
    "Data analyst",
    "Designer",
    "Founder",
  ],
  pages: [
    {
      title: "Why users churn at day eight",
      blocks: [
        {
          type: "heading",
          props: { level: 1 },
          content: "Why users churn at day eight",
        },
        {
          type: "paragraph",
          content:
            "Something happens at the end of the first week that we cannot see from the dashboard. This is a plan to find out what.",
        },
        { type: "heading", props: { level: 2 }, content: "What we know" },
        {
          type: "paragraph",
          content:
            "Day-one through day-seven retention is unremarkable and stable. It has not moved meaningfully in two quarters, through three releases and a pricing change.",
        },
        {
          id: "nt-tour-write",
          type: "paragraph",
          content: "Then the curve does something it has no business doing —",
        },
        { type: "heading", props: { level: 2 }, content: "How we will find out" },
        {
          id: "nt-tour-draw",
          type: "paragraph",
          content: "The study design:",
        },
        {
          type: "heading",
          props: { level: 2 },
          content: "What would change our minds",
        },
        {
          type: "bulletListItem",
          content: "If the drop is a billing event, this is not a product problem.",
        },
        {
          type: "bulletListItem",
          content: "If it is only one platform, it is a bug, not behaviour.",
        },
      ],
    },
    {
      title: "Interview guide",
      blocks: [
        { type: "heading", props: { level: 1 }, content: "Interview guide" },
        {
          type: "paragraph",
          content:
            "Forty minutes. Open wide, narrow late, and never ask them to explain their own behaviour.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-tour-write",
      ghost: " it falls off a cliff on day eight, in every cohort since March.",
    },
    draw: {
      blockId: "nt-tour-draw",
      brief:
        "a table of the three research methods, who each one covers and what question it answers",
      html: DESIGN,
    },
    ask: "Read this plan, then write the interview guide — eight questions, ordered so the hardest one is not first.",
    suggest: {
      type: "table",
      label: "Table",
      hint: "For tracking who you have spoken to.",
    },
  },
};
