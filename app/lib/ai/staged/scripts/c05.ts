import type { StagedScript } from "../types";
import { openPage, pageLike } from "./resolve";

/** C-05 — which requirements have no test? A cross-page audit with an honest answer. */
export const C05: StagedScript = {
  id: "C-05",
  title: "Which requirements have no test?",
  match:
    /\b(requirements?|reqs?)\b[^?]{0,70}\b(no tests?|not tested|untested|without tests?|missing tests?|aren'?t tested|haven'?t tested|hasn'?t been tested|never tested|have tests?|covered|coverage)\b|\b(which|what|any)\b[^?]{0,40}\b(requirements?|reqs?)\b[^?]{0,50}\btests?\b|\b(traceability|trace matrix|coverage gaps?|test coverage)\b|\b(not covered|nothing covering|no coverage)\b[^?]{0,40}\btests?\b/i,
  says: [
    "which requirements have no test?",
    "which requirements aren't tested",
    "are there requirements without tests",
    "what requirements are missing tests",
    "show me the traceability gaps",
    "which reqs have no test",
    "do all the requirements have tests?",
    "where is our test coverage weak",
    "Which requirements have no test?",
    "any requirements we haven't tested",
    "which requirements are untested",
    "have we got test coverage for everything",
    "find the requirements with no tests",
    "what's not covered by a test",
  ],
  bail: "I need the requirements page and the test page in this project to check that.",
  steps: [
    {
      say: "Reading the requirements, then the test plan.",
      delayMs: 600,
      call: [
        {
          tool: "read_page",
          input: (ctx) => {
            const pageId = pageLike(ctx, /requirement|traceab/i) ?? openPage(ctx);
            return pageId ? { pageId } : null;
          },
        },
        {
          tool: "read_page",
          optional: true,
          input: (ctx) => {
            const pageId = pageLike(ctx, /test|validat|v&v/i);
            return pageId ? { pageId } : null;
          },
        },
      ],
    },
    {
      say: "Four of the twenty-one have nothing pointing at them. Putting the gap on the page.",
      delayMs: 800,
      call: [
        {
          tool: "edit_page",
          input: (ctx) => {
            const pageId = pageLike(ctx, /requirement|traceab/i) ?? openPage(ctx);
            if (!pageId) return null;
            return {
              pageId,
              html: `<h2>Coverage gaps</h2>
<p>Seventeen of twenty-one requirements are covered. These four are not.</p>
<table>
<tr><th>Requirement</th><th>What it asks for</th><th>Nearest existing test</th><th>Suggested</th></tr>
<tr><td>REQ-008</td><td>IP54 chassis ingress</td><td>None — TV-003 covers the motors only</td><td>TV-022, spray rig</td></tr>
<tr><td>REQ-012</td><td>Pack thermal cut-out at 60 °C</td><td>TV-009 tests the derate, not the cut-out</td><td>TV-023, oven soak</td></tr>
<tr><td>REQ-018</td><td>Radiated emissions, CISPR 32 Class B</td><td>None</td><td>TV-024, external lab</td></tr>
<tr><td>REQ-020</td><td>Two-hour continuous duty at 30 °C ambient</td><td>None — longest run to date is 22 min</td><td>TV-025, endurance loop</td></tr>
</table>
<blockquote><p>REQ-018 has no owner either, and it is the only one of the four that needs an external lab — so it is also the only one with a lead time. Worth assigning this week rather than at the gate.</p></blockquote>`,
            };
          },
        },
      ],
    },
  ],
};
