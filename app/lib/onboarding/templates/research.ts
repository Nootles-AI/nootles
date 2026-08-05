import type { Template } from "../types";
import { CELL, GRID_LINE, HEAD } from "../diagramStyle";

const cell = (id: string, text: string, style = CELL) =>
  `<nt-rect id="${id}" w="172" h="44" style="${style}">${text}</nt-rect>`;

const DESIGN = `<nt-diagram w="600" h="261">
  <nt-group id="g1" x="40" y="40" w="520" h="181" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; padding: 1px; background: ${GRID_LINE}">
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
  showcase: {
    heading: "Pulling the cohorts",
    caption: "Prose, a diagram you can drag, and the query itself. One page.",
    block: {
      type: "codeBlock",
      props: {
        language: "sql",
        code: `select date_trunc('week', signed_up_at) as cohort,
       extract(day from last_seen_at - signed_up_at) as lived,
       count(*)
from users
where signed_up_at > '2026-03-01'
group by 1, 2
order by 1, 2;`,
      },
    },
  },
  pages: [
    {
      title: "Why users churn at day eight",
      blocks: [
        {
          type: "paragraph",
          content:
            "Something happens at the end of the first week that we cannot see from the dashboard. This is a plan to find out what.",
        },
        { id: "nt-hint-slash", type: "paragraph", content: "" },
        {
          type: "paragraph",
          content:
            "Day-one through day-seven retention is unremarkable and stable. It has not moved meaningfully in two quarters, through three releases and a pricing change.",
        },
        {
          id: "nt-hint-write",
          type: "paragraph",
          content: "Then the curve does something it has no business doing —",
        },
        { type: "heading", props: { level: 2 }, content: "How we will find out" },
        {
          type: "paragraph",
          content: "The study design:",
        },
        { id: "nt-hint-canvas", type: "canvas", props: { data: DESIGN } },
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
        {
          type: "paragraph",
          content: "The interview guide has a page of its own, in the sidebar.",
        },
        {
          type: "paragraph",
          content:
            "It also needs writing — ask the agent: open the chat and the question is already drafted.",
        },
        { type: "paragraph", content: "That's everything — this page is yours." },
      ],
    },
    {
      title: "Interview guide",
      blocks: [
        {
          type: "paragraph",
          content:
            "Forty minutes. Open wide, narrow late, and never ask them to explain their own behaviour.",
        },
        {
          type: "paragraph",
          content:
            "Press / and pick Table for tracking who you have spoken to.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-hint-write",
      ghost: " it falls off a cliff on day eight, in every cohort since March.",
    },
    priorChat: {
      title: "Sample size",
      asked: "Is eight interviews enough to conclude anything?",
      answered:
        "Enough to find the mechanism, not enough to size it. Eight will tell you what happens on day eight; the cohort SQL is what tells you how often. They answer different questions — the trouble starts when you read them as answering the same one twice.",
    },
    ask: "Read this plan, then write the interview guide — eight questions, ordered so the hardest one is not first.",
  },
};
