import type { Template } from "../types";
import { ACCENT, BOX } from "../diagramStyle";

const STEPS = `<nt-diagram w="600" h="408">
  <nt-rect id="p1" x="160" y="40" w="280" h="52" style="${BOX}">Form A − λI</nt-rect>
  <nt-rect id="p2" x="160" y="132" w="280" h="52" style="${BOX}">Set det(A − λI) = 0</nt-rect>
  <nt-rect id="p3" x="160" y="224" w="280" h="52" style="${BOX}">Solve for λ</nt-rect>
  <nt-rect id="p4" x="160" y="316" w="280" h="52" style="${ACCENT}">Back-substitute for v</nt-rect>
  <nt-edge id="e1" from="p1" to="p2"></nt-edge>
  <nt-edge id="e2" from="p2" to="p3">characteristic polynomial</nt-edge>
  <nt-edge id="e3" from="p3" to="p4">one λ at a time</nt-edge>
</nt-diagram>`;

export const classNotes: Template = {
  id: "classNotes",
  label: "Notes on something",
  blurb: "A lecture, a paper, a chapter — with the maths that goes with it.",
  projectTitle: "Linear algebra — eigenvalues",
  description: "Week six: eigenvalues, eigenvectors, and what they mean.",
  showcase: {
    heading: "A 2×2, worked",
    caption: "Prose, a diagram you can drag, and maths that computes. One page.",
    block: {
      type: "mathBlock",
      // Each line is its own row; a name defined on one is in scope on the next.
      props: {
        source: [
          "a = 4",
          "d = 3",
          "\\lambda_1 = \\frac{(a+d) + \\sqrt{(a-d)^2 + 8}}{2}",
          "\\lambda_2 = \\frac{(a+d) - \\sqrt{(a-d)^2 + 8}}{2}",
        ].join("\n"),
      },
    },
  },
  pages: [
    {
      title: "Eigenvalues",
      blocks: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "A vector ", styles: {} },
            { type: "math", props: { latex: "v" } },
            { type: "text", text: " is an eigenvector of ", styles: {} },
            { type: "math", props: { latex: "A" } },
            { type: "text", text: " when ", styles: {} },
            { type: "math", props: { latex: "Av = \\lambda v" } },
            {
              type: "text",
              text: " — the matrix acts on it like a number does.",
              styles: {},
            },
          ],
        },
        { id: "nt-tour-slash", type: "paragraph", content: "" },
        {
          type: "paragraph",
          content:
            "Most vectors get turned when you apply a matrix to them. A few do not: they come out pointing exactly where they went in, only longer or shorter, or flipped end for end. Those are the eigenvectors, and the amount they were scaled by is the eigenvalue.",
        },
        {
          id: "nt-tour-write",
          type: "paragraph",
          content:
            "So the eigenvectors are the directions the matrix leaves alone, and",
        },
        { type: "heading", props: { level: 2 }, content: "Finding them" },
        {
          id: "nt-tour-draw",
          type: "paragraph",
          content: "The procedure, in order:",
        },
        { type: "heading", props: { level: 2 }, content: "To check" },
        {
          type: "bulletListItem",
          content: "Why does a real matrix sometimes have complex eigenvalues?",
        },
        {
          type: "bulletListItem",
          content: "What does a repeated eigenvalue mean geometrically?",
        },
      ],
    },
    {
      title: "Worked examples",
      blocks: [
        {
          type: "paragraph",
          content: "One 2×2 done slowly, then a 3×3 done properly.",
        },
      ],
    },
  ],
  script: {
    write: {
      blockId: "nt-tour-write",
      ghost: " the eigenvalues are how much it stretches each of them.",
    },
    draw: {
      blockId: "nt-tour-draw",
      brief:
        "the four steps for finding eigenvalues, from forming A minus lambda I through to back-substituting for the eigenvector",
      html: STEPS,
    },
    priorChat: {
      title: "Why the determinant",
      asked: "Why does setting the determinant to zero find the eigenvalues?",
      answered:
        "Because Av = λv rearranges to (A − λI)v = 0, and you want a solution where v is not the zero vector. A matrix only sends a non-zero vector to zero when it is singular — and singular is exactly what a zero determinant means.",
    },
    ask: "Read these notes, then work through a 2×2 example step by step on the worked examples page.",
    suggest: {
      type: "mathBlock",
      label: "Math block",
      hint: "Define a variable on one line and reuse it on the next.",
    },
  },
};
