import type { ProjectTemplate } from "./types";

/** A table cell: inline content, which is what both the editor and the
 *  thumbnail read. */
const cell = (text: string) => [{ type: "text" as const, text, styles: {} }];

/**
 * A product requirements document, as a scaffold: the questions a PRD has to
 * answer, in the order a reader needs them, with a line under each saying what
 * belongs there. No invented product — the text is there to be replaced.
 */
export const prd: ProjectTemplate = {
  id: "prd",
  name: "PRD",
  description: "An overview, and a spec folder for requirements and open questions",
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
