import { browser, CENTRED, phone, PHONE_W } from "@/app/components/editor/canvas/devices";
import { canvas, cell, h2, p } from "./blocks";
import type { ProjectTemplate } from "./types";

const LABEL = `${CENTRED}; color: #6b6b66; font-size: 12px`;

/** Three phones across the column, each under the name of the screen it will hold. */
const SCREENS = ["First run", "Main screen", "Detail"];
const MOBILE = `<nt-diagram h="492">
${SCREENS.map((name, i) => {
  const x = 20 + i * 240;
  return `  <nt-text id="screen-${i + 1}-name" x="${x}" y="16" w="${PHONE_W}" h="20" style="${LABEL}">${name}</nt-text>
${phone(`screen-${i + 1}`, x, 48)}`;
}).join("\n")}
</nt-diagram>`;

const WEB = `<nt-diagram h="368">
${browser("web", 100, 24, { address: "yourproduct.com", skeleton: false })}
</nt-diagram>`;

/**
 * A product requirements document, as a scaffold: the questions a PRD has to
 * answer, in the order a reader needs them, with a line under each saying what
 * belongs there. No invented product — the text is there to be replaced.
 */
export const prd: ProjectTemplate = {
  id: "prd",
  name: "PRD",
  description: "An overview, and a spec folder for requirements, designs and open questions",
  rows: [
    {
      kind: "page",
      title: "Overview",
      blocks: [
        {
          type: "paragraph",
          content:
            "One paragraph a stranger could read: what is being built, for whom, and why now.",
        },
        { type: "heading", props: { level: 2 }, content: "Problem" },
        {
          type: "paragraph",
          content:
            "What is hard or broken today, and how you know. Evidence beats adjectives: a number, a quote, a ticket.",
        },
        { type: "heading", props: { level: 2 }, content: "Who it is for" },
        {
          type: "paragraph",
          content: "The person with the problem, and the moment they have it.",
        },
        { type: "heading", props: { level: 2 }, content: "Goals" },
        { type: "bulletListItem", content: "The outcome that makes this worth doing" },
        { type: "bulletListItem", content: "How it will be measured, and the number that counts as done" },
        { type: "heading", props: { level: 2 }, content: "Not doing" },
        {
          type: "bulletListItem",
          content: "What is deliberately left out, so nobody assumes it is coming",
        },
        { type: "heading", props: { level: 2 }, content: "Where the detail lives" },
        {
          type: "paragraph",
          content:
            "Requirements and Open questions are in the Spec folder. Keep this page short enough to read in a minute.",
        },
      ],
    },
    {
      kind: "folder",
      title: "Spec",
      pages: [
        {
          title: "Requirements",
          blocks: [
            {
              type: "paragraph",
              content:
                "What the thing must do, one row each. A requirement is something you could test, not a feature name.",
            },
            {
              type: "table",
              content: {
                type: "tableContent",
                headerRows: 1,
                rows: [
                  { cells: [cell("Requirement"), cell("Priority"), cell("Notes")] },
                  { cells: [cell("A person can…"), cell("Must"), cell("")] },
                  { cells: [cell("The system keeps…"), cell("Should"), cell("")] },
                  { cells: [cell(""), cell("Could"), cell("")] },
                ],
              },
            },
            { type: "heading", props: { level: 2 }, content: "Flow" },
            {
              type: "paragraph",
              content:
                "Draw the path through it. Type / and choose Diagram — a flow is easier to argue with than a paragraph about one.",
            },
            { type: "heading", props: { level: 2 }, content: "Edge cases" },
            { type: "bulletListItem", content: "What happens when it is empty" },
            { type: "bulletListItem", content: "What happens when it fails halfway" },
            { type: "bulletListItem", content: "What happens for someone without permission" },
          ],
        },
        {
          title: "Designs",
          blocks: [
            p(
              "The screens the requirements add up to. Every frame is a group of ordinary shapes: double-click into one to draw the screen, or paste a screenshot over it.",
            ),
            h2("Mobile"),
            canvas(MOBILE),
            h2("Web"),
            canvas(WEB),
            p(
              "For another screen, type / and choose Diagram: a new one offers the iPhone and the browser to start from. Name each screen after the requirement it answers.",
            ),
          ],
        },
        {
          title: "Open questions",
          blocks: [
            {
              type: "paragraph",
              content:
                "What is not decided yet. A question here is cheaper than an assumption in the build.",
            },
            { type: "checkListItem", content: "Question — who can answer it, and by when" },
            { type: "checkListItem", content: "" },
            { type: "heading", props: { level: 2 }, content: "Decided" },
            {
              type: "table",
              content: {
                type: "tableContent",
                headerRows: 1,
                rows: [
                  { cells: [cell("Decision"), cell("Why"), cell("Date")] },
                  { cells: [cell(""), cell(""), cell("")] },
                ],
              },
            },
          ],
        },
      ],
    },
  ],
};
