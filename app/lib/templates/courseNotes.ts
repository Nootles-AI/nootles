import { ACCENT, BOX } from "@/app/lib/onboarding/diagramStyle";
import { $, canvas, check, code, h2, maths, p, prose, table, toggle } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * A course, taken properly: the syllabus, a page per lecture with the maths
 * typeset rather than described, the problem sets, and exam revision as
 * flashcards — toggles whose answer stays folded until you have tried.
 *
 * Calculus as the example, because it is the course most people have taken and
 * it needs every one of maths, a diagram and code to be written down well.
 */

/** Which rule to reach for, as the decision it is. */
const WHICH_RULE = `<nt-diagram h="336">
  <nt-rect id="start" x="240" y="24" w="240" h="52" style="${BOX}">What is f made of?</nt-rect>
  <nt-rect id="product" x="24" y="152" w="200" h="52" style="${BOX}">Product rule</nt-rect>
  <nt-rect id="chain" x="260" y="152" w="200" h="52" style="${BOX}">Chain rule</nt-rect>
  <nt-rect id="quotient" x="496" y="152" w="200" h="52" style="${BOX}">Quotient rule</nt-rect>
  <nt-rect id="done" x="240" y="260" w="240" h="52" style="${ACCENT}">Simplify, then check</nt-rect>
  <nt-edge id="e1" from="start" to="product">g · h</nt-edge>
  <nt-edge id="e2" from="start" to="chain">g(h(x))</nt-edge>
  <nt-edge id="e3" from="start" to="quotient">g / h</nt-edge>
  <nt-edge id="e4" from="product" to="done"></nt-edge>
  <nt-edge id="e5" from="chain" to="done"></nt-edge>
  <nt-edge id="e6" from="quotient" to="done"></nt-edge>
</nt-diagram>`;

const CHECK = `from sympy import diff, sin, symbols

x = symbols("x")
print(diff(x**2 * sin(x), x))  # 2*x*sin(x) + x**2*cos(x)`;

export const courseNotes: ProjectTemplate = {
  id: "courseNotes",
  name: "Course notes",
  description: "A syllabus, lecture notes with real maths, problem sets and flashcards",
  rows: [
    {
      kind: "page",
      title: "Course",
      blocks: [
        p("Calculus I, as an example to write over: what the course covers, and when things are due."),
        table(
          ["Week", "Topic", "Reading", "Due"],
          ["1", "Limits", "Ch. 1", ""],
          ["2", "Derivatives", "Ch. 2", "Problem set 1"],
          ["3", "Applications", "Ch. 3", ""],
          ["4", "Integrals", "Ch. 4", "Problem set 2"],
        ),
        h2("Grading"),
        table(["", "Weight"], ["Problem sets", "30%"], ["Midterm", "30%"], ["Final", "40%"]),
      ],
    },
    {
      kind: "folder",
      title: "Lectures",
      pages: [
        {
          title: "Limits",
          blocks: [
            prose(
              "The limit of ",
              $("f(x)"),
              " as ",
              $("x"),
              " approaches ",
              $("a"),
              " is where ",
              $("f"),
              " is heading, whether or not it ever gets there.",
            ),
            maths(
              "\\lim_{x \\to a} f(x) = L \\iff \\forall \\varepsilon > 0\\ \\exists \\delta > 0 : 0 < |x - a| < \\delta \\implies |f(x) - L| < \\varepsilon",
            ),
            h2("Worked"),
            maths(
              "\\lim_{x \\to 2} \\frac{x^2 - 4}{x - 2}",
              "= \\lim_{x \\to 2} \\frac{(x - 2)(x + 2)}{x - 2}",
              "= \\lim_{x \\to 2} (x + 2) = 4",
            ),
            toggle(
              "Check yourself: what is the limit of sin(x)/x as x approaches 0?",
              prose("1 — the one limit worth memorising: ", $("\\lim_{x \\to 0} \\frac{\\sin x}{x} = 1")),
            ),
          ],
        },
        {
          title: "Derivatives",
          blocks: [
            prose("The derivative is the limit of the slope between two points as they meet:"),
            maths("f'(x) = \\lim_{h \\to 0} \\frac{f(x + h) - f(x)}{h}"),
            h2("The rules"),
            maths(
              "(g h)' = g' h + g h'",
              "\\left(\\frac{g}{h}\\right)' = \\frac{g' h - g h'}{h^2}",
              "\\big(g(h(x))\\big)' = g'(h(x))\\, h'(x)",
            ),
            h2("Which one"),
            canvas(WHICH_RULE),
            h2("Checking an answer"),
            code("python", CHECK),
          ],
        },
      ],
    },
    {
      kind: "page",
      title: "Problem sets",
      blocks: [
        p("Tick a question once it is done and checked, not just attempted."),
        h2("Problem set 1"),
        check("1.1"),
        check("1.2"),
        check("1.3"),
        h2("Problem set 2"),
        check("2.1"),
        check("2.2"),
      ],
    },
    {
      kind: "page",
      title: "Flashcards",
      blocks: [
        p("Answer before you open the toggle. Anything you got wrong goes to the top."),
        toggle("Derivative of sin x", prose($("\\cos x"))),
        toggle("Derivative of eˣ", prose($("e^x"))),
        toggle("Derivative of ln x", prose($("\\frac{1}{x}"), ", for ", $("x > 0"))),
        toggle("The chain rule, in words", p("The derivative of the outside, evaluated at the inside, times the derivative of the inside.")),
      ],
    },
  ],
};
