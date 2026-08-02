import { streamText } from "ai";
import { AI } from "./aiConfig";
import { diagramModel } from "./chat/provider";

/**
 * The diagram builder — stage two of the completion lane.
 *
 * The FIM model writes `<ab-build-diagram>a brief</ab-build-diagram>` where a
 * diagram belongs; this turns that brief into canvas HTML. It is an instruct
 * call rather than fill-in-the-middle for the reason the reformat lane is one:
 * the canvas grammar is a set of RULES — geometry in attributes, appearance in
 * CSS, arcs absent on a plain ellipse, children of an auto-layout group with no
 * x/y — and a rule is the one thing a base model cannot be given.
 *
 * Examples carry the grammar, as they do everywhere else here. Three of them,
 * chosen as the three ways a canvas can be laid out rather than as three
 * subjects: a graph placed by coordinates, a grid placed by CSS, and a mockup
 * that nests one inside the other. Every use case in {@link USE_CASES} is one of
 * those three wearing different labels, so the model generalises instead of
 * pattern-matching a subject it has seen.
 */

/**
 * The look a drawn shape has.
 *
 * Lifted from `render/newShape.ts` so a diagram the model builds and a diagram
 * drawn by hand are the same diagram — the alternative is a canvas where you
 * can tell at a glance which shapes you made. Written with `prop: value` and a
 * space, which is what `serializeStyleAttr` emits, so the examples are in the
 * canonical form the round trip produces rather than a second spelling of it.
 */
const BOX =
  "background: #f2f2f0; border: 1px solid #d8d8d4; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "text-align: center; color: #2b2b28; font-size: 13px";

/** The same box without a corner radius, for the kinds that draw their own. */
const PLAIN = BOX.replace("border-radius: 10px; ", "");

const FLOWCHART = `<ab-diagram w="600" h="440">
  <ab-rect id="s1" x="200" y="40" w="200" h="56" style="${BOX}">Order received</ab-rect>
  <ab-polygon id="s2" x="180" y="156" w="240" h="128" sides="4" style="${PLAIN}">In stock?</ab-polygon>
  <ab-rect id="s3" x="40" y="344" w="200" h="56" style="${BOX}">Pack and ship</ab-rect>
  <ab-rect id="s4" x="360" y="344" w="200" h="56" style="${BOX}">Raise backorder</ab-rect>
  <ab-edge id="e1" from="s1" to="s2"></ab-edge>
  <ab-edge id="e2" from="s2" to="s3">yes</ab-edge>
  <ab-edge id="e3" from="s2" to="s4">no</ab-edge>
</ab-diagram>`;

const CELL =
  "background: #ffffff; display: flex; align-items: center; " +
  "justify-content: center; color: #2b2b28; font-size: 12px";
const HEAD = `${CELL}; font-weight: 600`;

const TABLE = `<ab-diagram w="600" h="216">
  <ab-group id="t1" x="40" y="40" w="520" h="136" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; padding: 1px; background: #d8d8d4">
    <ab-rect id="h1" w="172" h="44" style="${HEAD}">Region</ab-rect>
    <ab-rect id="h2" w="172" h="44" style="${HEAD}">Owner</ab-rect>
    <ab-rect id="h3" w="172" h="44" style="${HEAD}">Revenue</ab-rect>
    <ab-rect id="c1" w="172" h="44" style="${CELL}">North</ab-rect>
    <ab-rect id="c2" w="172" h="44" style="${CELL}">Priya</ab-rect>
    <ab-rect id="c3" w="172" h="44" style="${CELL}">4.2m</ab-rect>
    <ab-rect id="c4" w="172" h="44" style="${CELL}">South</ab-rect>
    <ab-rect id="c5" w="172" h="44" style="${CELL}">Sam</ab-rect>
    <ab-rect id="c6" w="172" h="44" style="${CELL}">3.1m</ab-rect>
  </ab-group>
</ab-diagram>`;

const CARD =
  "background: #ffffff; border: 1px solid #e4e4e0; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "color: #2b2b28; font-size: 18px; font-weight: 600";
const NAV =
  "display: flex; align-items: center; padding: 0 10px; color: #6b6b66; font-size: 12px";

const MOCKUP = `<ab-diagram w="600" h="440">
  <ab-rect id="win" x="40" y="40" w="520" h="360" style="background: #ffffff; border: 1px solid #d8d8d4; border-radius: 12px"></ab-rect>
  <ab-group id="bar" x="40" y="40" w="520" h="40" style="display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #f7f7f5; border-bottom: 1px solid #d8d8d4; border-radius: 12px 12px 0 0">
    <ab-ellipse id="d1" w="10" h="10" style="background: #d8d8d4"></ab-ellipse>
    <ab-ellipse id="d2" w="10" h="10" style="background: #d8d8d4"></ab-ellipse>
    <ab-ellipse id="d3" w="10" h="10" style="background: #d8d8d4"></ab-ellipse>
  </ab-group>
  <ab-group id="side" x="40" y="80" w="140" h="320" style="display: flex; flex-direction: column; gap: 4px; padding: 12px; background: #fafaf9; border-right: 1px solid #d8d8d4">
    <ab-rect id="nav1" w="116" h="30" style="background: #eeeeec; border-radius: 6px; display: flex; align-items: center; padding: 0 10px; color: #2b2b28; font-size: 12px">Overview</ab-rect>
    <ab-rect id="nav2" w="116" h="30" style="${NAV}">Reports</ab-rect>
    <ab-rect id="nav3" w="116" h="30" style="${NAV}">Settings</ab-rect>
  </ab-group>
  <ab-text id="t1" x="200" y="100" w="240" h="28" style="display: flex; align-items: center; color: #2b2b28; font-size: 20px; font-weight: 600">Overview</ab-text>
  <ab-group id="cards" x="200" y="140" w="340" h="80" style="display: flex; gap: 12px">
    <ab-rect id="k1" w="105" h="80" style="${CARD}">4.2m</ab-rect>
    <ab-rect id="k2" w="105" h="80" style="${CARD}">312</ab-rect>
    <ab-rect id="k3" w="105" h="80" style="${CARD}">98%</ab-rect>
  </ab-group>
  <ab-rect id="chart" x="200" y="240" w="340" h="140" style="background: #fafaf9; border: 1px solid #e4e4e0; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #9a9a94; font-size: 13px">Revenue by month</ab-rect>
</ab-diagram>`;

/**
 * What the builder is for, said as subjects rather than as shapes.
 *
 * Each names the mechanism it is built from, because the failure this prevents
 * is the model reaching for absolute coordinates to lay out a table — which
 * works until a label is one word longer and the column stops lining up.
 */
const USE_CASES = `Flowchart, decision tree, state machine, org chart, dependency
  graph, system architecture, mind map, user flow, ER diagram — SHAPES AND EDGES,
  placed by coordinates, like the flowchart example.
Table, matrix, calendar, pricing grid, comparison, bingo of any kind — ONE GRID
  GROUP, like the table example. Never absolute coordinates: a grid keeps its
  columns when a label grows.
Kanban board, timeline, roadmap, swimlane, process strip, stack of steps, legend
  — ONE FLEX GROUP, row or column, like the sidebar in the mockup example.
App screen, dashboard, landing page, form, mobile screen, settings panel, modal,
  wireframe of anything — GROUPS INSIDE GROUPS, like the mockup example: absolute
  boxes for the panels, a flex group for each row or column of controls.`;

export const SYSTEM = `You draw diagrams for auto-board, a Figma-like canvas. You are given a
brief describing what to draw and the page it is being drawn on. You reply with ONE
<ab-diagram> element and nothing else — no prose, no code fence.

THE GRAMMAR

Shapes:  <ab-rect> <ab-ellipse> <ab-polygon sides="n"> <ab-image src=""> <ab-group>
         <ab-text> — standalone words only, never a label for a shape. See LABELS below.
Connector: <ab-edge from="id" to="id">label</ab-edge>

Geometry is ATTRIBUTES, appearance is CSS in style. Never put position or size in style,
and never put colour or borders in attributes.
  x y w h    position and size in px. x/y is the top-left corner, relative to the parent
             group (or to the canvas for a top-level shape).
  rot        clockwise degrees, only when rotated.
  sides      required on <ab-polygon>. 4 is a diamond, 3 a triangle, 6 a hexagon.

Every shape needs a unique id.

LABELS BELONG TO THE SHAPE
A shape's label is its OWN text content, plain, no tags inside it:
  <ab-rect id="s1" x="40" y="40" w="200" h="56" style="...">Order received</ab-rect>
Never draw an empty shape and lay an <ab-text> over it to label it. That is two objects
pretending to be one: dragging the shape leaves the label behind, the label gets its own
row in the layers panel, and an edge to the shape ignores it. Centre a label inside its own
shape with display: flex; align-items: center; justify-content: center.
<ab-text> is only for words that belong to no shape — a heading above a group, a caption, an
annotation. If the words name a box, they go inside the box.

EDGES
An edge names the two shapes it joins and nothing else: <ab-edge id="e1" from="s1" to="s2">label</ab-edge>.
It has no geometry — which side it leaves and enters is worked out from where the shapes
are, and re-worked when they move. Write edges after the shapes. An edge with no label is
<ab-edge id="e1" from="s1" to="s2"></ab-edge>. Only ever join two ids that exist.

GROUPS AND AUTO-LAYOUT
A group with display: flex or display: grid POSITIONS ITS OWN CHILDREN. Inside one, give
each child w and h but NO x and NO y — writing them would be a second, wrong answer about
where the child is. Use gap, padding, flex-direction, align-items, justify-content and
grid-template-columns, exactly as CSS.
A group WITHOUT display is a plain container: its children keep their own x/y.

Reach for a layout group whenever things are evenly spaced — rows, columns, grids, cards.
Use coordinates when the arrangement is the meaning, as it is in a flowchart.

THE LOOK
The brief wins. When it says how the thing should look — dark mode, a brand colour, a
particular product — build that, and put the surface colour on <ab-diagram> itself so the
whole canvas reads as one screen rather than pale shapes on white. A mockup of a dark app
is dark.
Said nothing about it, work neutral and flat like the examples: #f2f2f0 fills, #d8d8d4
lines, #2b2b28 text, white surfaces, no gradients, no drop shadows. That is the default,
not a rule.
Labels are 12-13px; a heading in a mockup can be larger. Centre a label with display:
flex; align-items: center; justify-content: center.
SIZE AND PLACEMENT
The diagram sits in a document column about 600px wide and is shown from its top-left
corner, so lay it out there: start at about x=40, y=40, keep the whole thing within 600px
across, and set w/h on <ab-diagram> to just contain the content plus that margin. A canvas
far wider than what is in it puts the drawing off to one side of the column, and content
past 600px is off the edge. Keep 40px between things that are not related.

WHAT TO DRAW
${USE_CASES}

Take the labels from the page's own wording wherever it says something — a diagram of the
page should use its words. Six to ten shapes is usually right; past a dozen it stops being
readable. If the brief does not describe something a diagram would actually show, reply
with nothing at all.`;

/** Few-shot pairs. The brief is written the way stage one writes one. */
const SHOTS: Array<{ brief: string; html: string }> = [
  { brief: "the order fulfilment process, with the out-of-stock branch", html: FLOWCHART },
  { brief: "a table of regions with their owner and revenue", html: TABLE },
  { brief: "a mockup of the analytics dashboard screen", html: MOCKUP },
];

/**
 * Streams canvas HTML for one brief.
 *
 * Text rather than an object stream: the caller draws the diagram as the shapes
 * arrive, and a partly-arrived element is something the canvas parser already
 * copes with — so streaming is what makes a two-second call feel like a diagram
 * building itself rather than a spinner.
 */
export function streamDiagram(
  brief: string,
  page: string,
  title: string,
  signal?: AbortSignal,
): Response {
  const result = streamText({
    model: diagramModel(),
    system: SYSTEM,
    messages: [
      ...SHOTS.flatMap(
        (shot) =>
          [
            { role: "user" as const, content: `Draw: ${shot.brief}` },
            { role: "assistant" as const, content: shot.html },
          ] as const,
      ),
      { role: "user", content: userMessage(brief, page, title) },
    ],
    maxOutputTokens: AI.diagram.maxTokens,
    abortSignal: signal,
  });
  return result.toTextStreamResponse();
}

function userMessage(brief: string, page: string, title: string): string {
  // The page goes first and the instruction last: what to draw is the thing the
  // model must still be holding when it starts writing.
  const context = page.trim()
    ? `The page${title.trim() ? ` "${title.trim()}"` : ""} says:\n${page.trim()}\n\n`
    : "";
  return `${context}Draw: ${brief}`;
}
