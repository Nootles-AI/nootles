import { ACCENT, BOX, GHOST_BOX } from "@/app/lib/onboarding/diagramStyle";

/**
 * What the recording on the door plays.
 *
 * A launch plan rather than a rate limiter: the door is the one screen that
 * cannot assume anything about who is reading it, and a page about token
 * buckets tells a person who does not write services that this is not for them.
 * Everybody has had to say what has to be true before a thing ships.
 *
 * The three beats are the three things the product does that a screenshot
 * cannot show — a line being finished, a diagram being drawn from a sentence,
 * and that diagram being dragged into shape afterwards. Everything else on the
 * page is there to give them somewhere to happen.
 */

export const TITLE = "Launch plan";

export const INTRO =
  "What has to be true before we ship, who owns each part, and the order it " +
  "has to happen in.";

export const WHERE_HEADING = "Where we are";

export const WHERE =
  "Everything in the first cut is built and behind a flag. What is left is the " +
  "review pass, the copy nobody has written yet, and one decision about " +
  "whether existing accounts see it at all.";

/** The line the model finishes. It has to read as unfinished on its own. */
export const LINE = "The date we are working back from is";

/** What the model offers, accepted with Tab. */
export const GHOST =
  " the last Thursday in March, which leaves three clear weeks of buffer.";

export const HEADING = "How it fits together";

/** The line that invites a drawing, and the sentence the model reads it as. */
export const LEAD = "The order things have to happen in:";
export const BRIEF =
  "draw the path from draft to ship, with the loop back for changes";

/**
 * The diagram, authored at the width the slot gives it so the scene needs no
 * fitting — the recording places it at a known transform and drives a cursor to
 * a known shape, and a fit computed from a measured box would move both.
 */
export const DIAGRAM_W = 500;
export const DIAGRAM_H = 260;

export const DIAGRAM = `<nt-diagram w="${DIAGRAM_W}" h="${DIAGRAM_H}">
  <nt-rect id="d1" x="16" y="26" w="140" h="48" style="${BOX}">Draft</nt-rect>
  <nt-rect id="d2" x="180" y="26" w="140" h="48" style="${BOX}">Review</nt-rect>
  <nt-rect id="d3" x="344" y="26" w="140" h="48" style="${ACCENT}">Ship</nt-rect>
  <nt-rect id="d4" x="180" y="170" w="140" h="48" style="${GHOST_BOX}">Rework</nt-rect>
  <nt-edge id="e1" from="d1" to="d2"></nt-edge>
  <nt-edge id="e2" from="d2" to="d3"></nt-edge>
  <nt-edge id="e3" from="d2" to="d4">changes</nt-edge>
  <nt-edge id="e4" from="d4" to="d1"></nt-edge>
</nt-diagram>`;

/**
 * The rest of the page.
 *
 * Not filler. The sheet is a portrait document and a page that stopped after
 * six lines would read as a stub with a demo bolted to it — the whole claim
 * being made here is that this is what real work looks like in the product. It
 * also gives the drawing somewhere to push: when the diagram lands, the page
 * below it moves down and runs under the crop, which is what a document does.
 */
export const OWNERS_HEADING = "Who owns what";

export const OWNERS = [
  "Scope and draft — Priya, by the 14th",
  "Build and QA — the platform team",
  "Comms and the launch note — Sam",
  "Support handover — Ana, the week before",
];

export const STOP_HEADING = "What would make us stop";

export const STOP =
  "Anything still in the rework loop by the Monday of launch week. We would " +
  "rather move the date once than ship it twice.";

/** The node the cursor picks up, and where it puts it down. */
export const DRAGGED = "d4";
export const DRAG_FROM = { x: 180, y: 170, w: 140, h: 48 };
/**
 * The edit. Rework starts under Review, where the loop back to Draft has to
 * cross the whole drawing to get home; dragged under Draft it closes on itself.
 * A demo edit that made the picture worse would be showing off the drag rather
 * than the point of it.
 */
export const DRAG_DX = -164;
