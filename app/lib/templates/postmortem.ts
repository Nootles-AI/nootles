import { ACCENT, BOX, GHOST_BOX } from "@/app/lib/onboarding/diagramStyle";
import { bullet, canvas, check, code, h2, numbered, p, quote, table } from "./blocks";
import type { ProjectTemplate } from "./types";

/**
 * An incident review, blameless by construction: what happened and to whom,
 * the timeline, the chain of causes drawn out, and actions that each prevent,
 * detect or soften the next one.
 */

/** The causal chain runs down; the missed alarm is a branch off it, not a link in it. */
const CHAIN = `<nt-diagram h="376">
  <nt-rect id="trigger" x="200" y="24" w="200" h="52" style="${GHOST_BOX}">Trigger</nt-rect>
  <nt-rect id="condition" x="200" y="116" w="200" h="52" style="${BOX}">Latent condition</nt-rect>
  <nt-rect id="failure" x="200" y="208" w="200" h="52" style="${BOX}">Failure</nt-rect>
  <nt-rect id="impact" x="200" y="300" w="200" h="52" style="${ACCENT}">Customer impact</nt-rect>
  <nt-rect id="detection" x="480" y="208" w="180" h="52" style="${GHOST_BOX}">Why we didn’t see it</nt-rect>
  <nt-edge id="e1" from="trigger" to="condition"></nt-edge>
  <nt-edge id="e2" from="condition" to="failure"></nt-edge>
  <nt-edge id="e3" from="failure" to="impact"></nt-edge>
  <nt-edge id="e4" from="failure" to="detection"></nt-edge>
</nt-diagram>`;

const CHANGE = `// The change that met the condition. Paste the real diff, and link the PR.
export const client = createClient({
  url: process.env.DATABASE_URL,
  poolSize: 10,
  timeoutMs: 0, // previously 5_000: a stuck query now holds its connection forever
});`;

export const postmortem: ProjectTemplate = {
  id: "postmortem",
  name: "Incident postmortem",
  description: "Impact, a timeline, the chain of causes, and the actions that follow",
  rows: [
    {
      kind: "page",
      title: "Summary",
      blocks: [
        quote(
          "Blameless: people acted reasonably on what they knew at the time. The question is why the system let that go wrong.",
        ),
        p("Two sentences: what broke, for whom, and for how long."),
        h2("Impact"),
        table(
          ["", "When, or how many"],
          ["Started", ""],
          ["Detected", ""],
          ["Resolved", ""],
          ["Customers affected", ""],
          ["Severity", ""],
        ),
        h2("What went well"),
        bullet("What worked in detection, response or recovery"),
        h2("What went badly"),
        bullet("Where time was lost, and why"),
        h2("Where we got lucky"),
        bullet("What would have made this worse"),
      ],
    },
    {
      kind: "page",
      title: "Timeline",
      blocks: [
        p("Every time in UTC. Include what people believed at each point, not only what they did."),
        table(
          ["Time", "What happened", "Who"],
          ["", "Change deployed", ""],
          ["", "First alert", ""],
          ["", "Incident declared", ""],
          ["", "Mitigated", ""],
          ["", "Resolved", ""],
        ),
      ],
    },
    {
      kind: "page",
      title: "Root cause",
      blocks: [
        p(
          "Incidents have a chain of causes rather than one. Draw it, and name the part that let it go unnoticed.",
        ),
        canvas(CHAIN),
        h2("Five whys"),
        numbered("Why did customers see errors?"),
        numbered("Why did…"),
        numbered("…until the answer is something the system allowed, not something a person did"),
        h2("The change"),
        code("typescript", CHANGE),
      ],
    },
    {
      kind: "page",
      title: "Actions",
      blocks: [
        p(
          "Each action prevents a recurrence, detects one sooner, or softens its impact. An action without an owner and a date is a wish.",
        ),
        table(
          ["Action", "Kind", "Owner", "Due", "Ticket"],
          ["", "Prevent", "", "", ""],
          ["", "Detect", "", "", ""],
          ["", "Mitigate", "", "", ""],
        ),
        h2("Before this is closed"),
        check("Reviewed with everyone who responded"),
        check("Shared with the teams that depend on this system"),
        check("Every action has a ticket"),
      ],
    },
  ],
};
