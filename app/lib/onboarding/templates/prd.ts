import type { Template } from "../types";
import { ACCENT, BOX, PLAIN } from "../diagramStyle";
import { cell } from "../cell";

const FLOW = `<nt-diagram w="600" h="568">
  <nt-rect id="s1" x="200" y="40" w="200" h="52" style="${BOX}">Cart</nt-rect>
  <nt-rect id="s2" x="180" y="132" w="240" h="52" style="${BOX}">Checkout — email only</nt-rect>
  <nt-polygon id="s3" x="180" y="224" w="240" h="112" sides="4" style="${PLAIN}">Account exists?</nt-polygon>
  <nt-rect id="s4" x="40" y="384" w="200" h="52" style="${ACCENT}">Pay as guest</nt-rect>
  <nt-rect id="s5" x="360" y="384" w="200" h="52" style="${BOX}">Offer sign in</nt-rect>
  <nt-rect id="s6" x="200" y="476" w="200" h="52" style="${BOX}">Confirmation</nt-rect>
  <nt-edge id="e1" from="s1" to="s2"></nt-edge>
  <nt-edge id="e2" from="s2" to="s3"></nt-edge>
  <nt-edge id="e3" from="s3" to="s4">no</nt-edge>
  <nt-edge id="e4" from="s3" to="s5">yes</nt-edge>
  <nt-edge id="e5" from="s4" to="s6"></nt-edge>
  <nt-edge id="e6" from="s5" to="s6"></nt-edge>
</nt-diagram>`;

export const prd: Template = {
  id: "prd",
  label: "Product requirements",
  blurb: "A problem, a proposal, and the open questions between them.",
  description:
    "Letting first-time buyers pay without making an account, and what that changes.",
  showcase: {
    heading: "How we will know",
    caption: "Prose, a diagram you can drag, and a table. One page.",
    block: {
      type: "table",
      content: {
        type: "tableContent",
        headerRows: 1,
        rows: [
          { cells: [cell("Measure"), cell("Today"), cell("Target")] },
          { cells: [cell("Checkout completion"), cell("61%"), cell("74%")] },
          { cells: [cell("Drop-off at account"), cell("23%"), cell("under 5%")] },
          { cells: [cell("Support tickets"), cell("40 / wk"), cell("no rise")] },
        ],
      },
    },
  },
  pages: [
    {
      title: "Guest checkout",
      blocks: [
        {
          type: "paragraph",
          content:
            "Let a first-time buyer pay without making an account, and ask for the account afterwards — if at all.",
        },
        { id: "nt-hint-slash", type: "paragraph", content: "" },
        {
          type: "paragraph",
          content:
            "Checkout is four steps and the second one is a wall. We ask for an email, a password, and a confirmation before we have asked for a card, which means we are asking someone to commit to us before they have bought anything.",
        },
        {
          id: "nt-hint-write",
          type: "paragraph",
          content: "The drop-off is concentrated at the account step —",
        },
        { type: "heading", props: { level: 2 }, content: "How it would work" },
        {
          type: "paragraph",
          content: "The flow we are proposing:",
        },
        { id: "nt-hint-canvas", type: "canvas", props: { data: FLOW } },
        { type: "heading", props: { level: 2 }, content: "Open questions" },
        {
          type: "bulletListItem",
          content: "What happens when a guest email already has an account?",
        },
        {
          type: "bulletListItem",
          content: "Do guest orders show up in support tooling the same way?",
        },
        { type: "bulletListItem", content: "How long do we keep a guest order?" },
        {
          type: "paragraph",
          content:
            "What we will watch after launch is on the Success metrics page, in the sidebar.",
        },
        {
          type: "paragraph",
          content:
            "If you want a Risks section here, ask the agent — open the chat and the question is already drafted.",
        },
        { type: "paragraph", content: "That's everything — this page is yours." },
      ],
    },
    {
      title: "Success metrics",
      blocks: [
        {
          type: "paragraph",
          content:
            "What we will look at four weeks after this ships, and what would make us roll it back.",
        },
        {
          type: "paragraph",
          content:
            "Press / and pick Table — one row per measure, with today's number and the target.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-hint-write",
      ghost:
        " 62% of first-time buyers who reach it never come back to finish the order.",
    },
    priorChat: {
      title: "Scope",
      asked:
        "Should a guest be able to claim their order into an account later, or is that a separate project?",
      answered:
        "Later, and separate. Claiming needs an identity merge and an email verification path, and folding those in would roughly double this one. Worth a line under Open questions so it is not quietly forgotten.",
    },
    ask: "Read this page and add a Risks section with the three things most likely to go wrong.",
  },
};
