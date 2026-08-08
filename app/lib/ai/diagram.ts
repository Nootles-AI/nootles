import { streamText, type LanguageModelUsage } from "ai";
import { AI } from "./aiConfig";
import { diagramModel } from "./chat/provider";

/**
 * The diagram builder — stage two of the completion lane.
 *
 * The FIM model writes `<nt-build-diagram>a brief</nt-build-diagram>` where a
 * diagram belongs; this turns that brief into canvas HTML. It is an instruct
 * call rather than fill-in-the-middle for the reason the reformat lane is one:
 * the canvas grammar is a set of RULES — geometry in attributes, appearance in
 * CSS, arcs absent on a plain ellipse, children of an auto-layout group with no
 * x/y — and a rule is the one thing a base model cannot be given.
 *
 * Examples carry the grammar, as they do everywhere else here. Four of them,
 * chosen as the four ways a canvas can be laid out rather than as four
 * subjects: a graph placed by coordinates, a grid placed by CSS, a mockup that
 * nests one inside the other, and a storyboard that draws what no arrangement
 * of boxes could. Every use case in {@link USE_CASES} is one of those four
 * wearing different labels, so the model generalises instead of pattern-matching
 * a subject it has seen.
 *
 * The fourth is the newest and the least like the others. `<nt-path>` takes
 * ordinary SVG path data, which these models write fluently and unprompted —
 * the work here is not teaching them to draw but telling them they may, and
 * fencing it so that a flowchart does not come back as four hand-drawn
 * rectangles. Hence the standing order in DRAWING: native shapes first, the pen
 * for what a native shape cannot be.
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

const FLOWCHART = `<nt-diagram w="600" h="440">
  <nt-rect id="s1" x="200" y="40" w="200" h="56" style="${BOX}">Order received</nt-rect>
  <nt-polygon id="s2" x="180" y="156" w="240" h="128" sides="4" style="${PLAIN}">In stock?</nt-polygon>
  <nt-rect id="s3" x="40" y="344" w="200" h="56" style="${BOX}">Pack and ship</nt-rect>
  <nt-rect id="s4" x="360" y="344" w="200" h="56" style="${BOX}">Raise backorder</nt-rect>
  <nt-edge id="e1" from="s1" to="s2"></nt-edge>
  <nt-edge id="e2" from="s2" to="s3">yes</nt-edge>
  <nt-edge id="e3" from="s2" to="s4">no</nt-edge>
</nt-diagram>`;

const CELL =
  "background: #ffffff; display: flex; align-items: center; " +
  "justify-content: center; color: #2b2b28; font-size: 12px";
const HEAD = `${CELL}; font-weight: 600`;

const TABLE = `<nt-diagram w="600" h="216">
  <nt-group id="t1" x="40" y="40" w="520" h="136" style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; padding: 1px; background: #d8d8d4">
    <nt-rect id="h1" w="172" h="44" style="${HEAD}">Region</nt-rect>
    <nt-rect id="h2" w="172" h="44" style="${HEAD}">Owner</nt-rect>
    <nt-rect id="h3" w="172" h="44" style="${HEAD}">Revenue</nt-rect>
    <nt-rect id="c1" w="172" h="44" style="${CELL}">North</nt-rect>
    <nt-rect id="c2" w="172" h="44" style="${CELL}">Priya</nt-rect>
    <nt-rect id="c3" w="172" h="44" style="${CELL}">4.2m</nt-rect>
    <nt-rect id="c4" w="172" h="44" style="${CELL}">South</nt-rect>
    <nt-rect id="c5" w="172" h="44" style="${CELL}">Sam</nt-rect>
    <nt-rect id="c6" w="172" h="44" style="${CELL}">3.1m</nt-rect>
  </nt-group>
</nt-diagram>`;

const FRAME =
  "background: #ffffff; border: 1px solid #d8d8d4; border-radius: 8px";
const CAPTION = "display: flex; color: #6b6b66; font-size: 11px";

/**
 * The drawing example, and the one that carries the most instruction.
 *
 * Its subject is chosen so that neither half can be skipped: a storyboard is
 * frames (which are boxes, and must stay boxes) with drawings inside them
 * (which no arrangement of boxes could be). Shown together, the rule reads as a
 * division of labour rather than as a preference, which is the thing a list of
 * prose rules is worst at conveying.
 *
 * Each drawn element is its OWN `<nt-path>` rather than one path with many
 * subpaths — separately fillable, separately selectable, its own row in the
 * layers panel. The stick figure is the exception that shows the other rule: one
 * body, six strokes, one path, because they share a stroke and nothing would be
 * gained by separating them.
 *
 * The sun is an `<nt-ellipse>` and not a drawn circle, which is the "native
 * shapes first" rule holding inside the very example that introduces the pen.
 * An example that broke it would teach the opposite of what the prose says, and
 * the example is what a model actually copies.
 *
 * Emitted in the exact form `serializeScene(adoptScene(parseScene(…)))`
 * produces — attribute order, tight boxes and all — so the model is shown the
 * canonical spelling rather than a second one that the pipeline would silently
 * rewrite. (Which is why `hill` has control points at -6: a box is tight to the
 * CURVE, and a cubic's controls may sit outside the curve they bend.)
 */
const STORY = `<nt-diagram w="600" h="260">
  <nt-rect id="f1" x="40" y="40" w="160" h="120" style="${FRAME}"></nt-rect>
  <nt-path id="hill" x="40" y="118" w="160" h="42" d="M 0 42 L 0 18 C 40 -6 120 -6 160 18 L 160 42 Z" style="fill: #dfe7d8"></nt-path>
  <nt-ellipse id="sun" x="150" y="58" w="28" h="28" style="background: #f0d9a8"></nt-ellipse>
  <nt-text id="c1" x="40" y="168" w="160" h="16" style="${CAPTION}">1 — She wakes early</nt-text>
  <nt-rect id="f2" x="220" y="40" w="160" h="120" style="${FRAME}"></nt-rect>
  <nt-path id="road" x="282" y="80" w="48" h="80" d="M 0 80 L 12 0 L 28 0 L 48 80 Z" style="fill: #eeeeec"></nt-path>
  <nt-path id="car" x="270" y="112" w="55" h="26" d="M 4 26 L 0 14 C 0 10 2 8 6 8 L 14 8 L 22 0 L 40 0 L 48 8 L 52 10 C 56 12 56 22 52 26 Z" style="fill: #2b2b28"></nt-path>
  <nt-text id="c2" x="220" y="168" w="160" h="16" style="${CAPTION}">2 — The drive in</nt-text>
  <nt-rect id="f3" x="400" y="40" w="160" h="120" style="${FRAME}"></nt-rect>
  <nt-path id="desk" x="416" y="120" w="128" h="8" d="M 0 0 L 128 0 L 128 8 L 0 8 Z" style="fill: #d8d8d4"></nt-path>
  <nt-path id="figure" x="462" y="66" w="36" h="54" d="M 18 0 C 26 0 26 14 18 14 C 10 14 10 0 18 0 Z M 18 14 L 18 38 M 18 20 L 0 30 M 18 20 L 36 30 M 18 38 L 6 54 M 18 38 L 30 54" style="fill: none; stroke: #2b2b28; stroke-width: 2"></nt-path>
  <nt-text id="c3" x="400" y="168" w="160" h="16" style="${CAPTION}">3 — At the desk by seven</nt-text>
</nt-diagram>`;

const CARD =
  "background: #ffffff; border: 1px solid #e4e4e0; border-radius: 10px; " +
  "display: flex; align-items: center; justify-content: center; " +
  "color: #2b2b28; font-size: 18px; font-weight: 600";
const NAV =
  "display: flex; align-items: center; padding: 0 10px; color: #6b6b66; font-size: 12px";

const MOCKUP = `<nt-diagram w="600" h="440">
  <nt-rect id="win" x="40" y="40" w="520" h="360" style="background: #ffffff; border: 1px solid #d8d8d4; border-radius: 12px"></nt-rect>
  <nt-group id="bar" x="40" y="40" w="520" h="40" style="display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #f7f7f5; border-bottom: 1px solid #d8d8d4; border-radius: 12px 12px 0 0">
    <nt-ellipse id="d1" w="10" h="10" style="background: #d8d8d4"></nt-ellipse>
    <nt-ellipse id="d2" w="10" h="10" style="background: #d8d8d4"></nt-ellipse>
    <nt-ellipse id="d3" w="10" h="10" style="background: #d8d8d4"></nt-ellipse>
  </nt-group>
  <nt-group id="side" x="40" y="80" w="140" h="320" style="display: flex; flex-direction: column; gap: 4px; padding: 12px; background: #fafaf9; border-right: 1px solid #d8d8d4">
    <nt-rect id="nav1" w="116" h="30" style="background: #eeeeec; border-radius: 6px; display: flex; align-items: center; padding: 0 10px; color: #2b2b28; font-size: 12px">Overview</nt-rect>
    <nt-rect id="nav2" w="116" h="30" style="${NAV}">Reports</nt-rect>
    <nt-rect id="nav3" w="116" h="30" style="${NAV}">Settings</nt-rect>
  </nt-group>
  <nt-text id="t1" x="200" y="100" w="240" h="28" style="display: flex; align-items: center; color: #2b2b28; font-size: 20px; font-weight: 600">Overview</nt-text>
  <nt-group id="cards" x="200" y="140" w="340" h="80" style="display: flex; gap: 12px">
    <nt-rect id="k1" w="105" h="80" style="${CARD}">4.2m</nt-rect>
    <nt-rect id="k2" w="105" h="80" style="${CARD}">312</nt-rect>
    <nt-rect id="k3" w="105" h="80" style="${CARD}">98%</nt-rect>
  </nt-group>
  <nt-rect id="chart" x="200" y="240" w="340" h="140" style="background: #fafaf9; border: 1px solid #e4e4e0; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #9a9a94; font-size: 13px">Revenue by month</nt-rect>
</nt-diagram>`;

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
  boxes for the panels, a flex group for each row or column of controls.
Storyboard, illustration, sketch, icon, logo, map, character, scene, cutaway,
  anything ASKED FOR AS A DRAWING — PATHS, like the storyboard example. This is
  the one case boxes cannot do at all: a curve, a silhouette, an arrow head, a
  tree, a person. Draw it.`;

export const SYSTEM = `You draw diagrams for Nootles, a Figma-like canvas. You are given a
brief describing what to draw and the page it is being drawn on. You reply with ONE
<nt-diagram> element and nothing else — no prose, no code fence.

THE GRAMMAR

Shapes:  <nt-rect> <nt-ellipse> <nt-polygon sides="n"> <nt-image src=""> <nt-group>
         <nt-path d=""> — a drawn shape. See DRAWING below.
         <nt-text> — standalone words only, never a label for a shape. See LABELS below.
Connector: <nt-edge from="id" to="id">label</nt-edge>

Geometry is ATTRIBUTES, appearance is CSS in style. Never put position or size in style,
and never put colour or borders in attributes.
  x y w h    position and size in px. x/y is the top-left corner, relative to the parent
             group (or to the canvas for a top-level shape).
  rot        clockwise degrees, only when rotated.
  sides      required on <nt-polygon>. 4 is a diamond, 3 a triangle, 6 a hexagon.
  d          required on <nt-path>. SVG path data.

Every shape needs a unique id.

LABELS BELONG TO THE SHAPE
A shape's label is its OWN text content, plain, no tags inside it:
  <nt-rect id="s1" x="40" y="40" w="200" h="56" style="...">Order received</nt-rect>
The one element a label may carry is a page reference — a chip linking to another page in
the project: <nt-rect id="s1" ...>See <nt-ref page="pageId">Page title</nt-ref></nt-rect>.
Use a real page id; anything else inside a label is flattened to its text.
Never draw an empty shape and lay an <nt-text> over it to label it. That is two objects
pretending to be one: dragging the shape leaves the label behind, the label gets its own
row in the layers panel, and an edge to the shape ignores it. Centre a label inside its own
shape with display: flex; align-items: center; justify-content: center.
<nt-text> is only for words that belong to no shape — a heading above a group, a caption, an
annotation. If the words name a box, they go inside the box.

EDGES
An edge names the two shapes it joins and nothing else: <nt-edge id="e1" from="s1" to="s2">label</nt-edge>.
It has no geometry — which side it leaves and enters is worked out from where the shapes
are, and re-worked when they move. Write edges after the shapes. An edge with no label is
<nt-edge id="e1" from="s1" to="s2"></nt-edge>. Only ever join two ids that exist.

DRAWING
<nt-path> is the pen. Its d is ordinary SVG path data — every command, M L H V C S Q T A Z,
absolute or relative — and you are good at this, so when something has to be DRAWN rather
than arranged, draw it.

Reach for a native shape first. A box is <nt-rect>, a circle is <nt-ellipse>, a triangle or
a diamond is <nt-polygon>. Those carry labels, take connectors, and stay editable as shapes;
a path that imitates one is worse in every way. Use <nt-path> for what they cannot be: a
curve, a silhouette, a figure, a tree, a mountain, an arrow head, an icon, a logo, a
coastline, a piece of machinery.

Write d in the shape's OWN coordinates, near 0 0 — not where it sits on the canvas. Where it
sits goes on x and y. Do not try to work out w and h: they are measured from the path for
you, so put anything reasonable and let them be corrected.
  <nt-path id="p1" x="120" y="70" w="80" h="30" d="M 0 30 C 20 -10 60 -10 80 30 Z" style="fill: #dfe7d8"></nt-path>

ONE PATH PER THING YOU CAN NAME. A face is an outline, two eyes and a mouth — four paths,
not one. Each gets its own fill and its own row in the layers panel, and the user can
restyle or move any of them. Put several strokes in ONE d when they are one object drawn in
one colour, as the stick figure is in the storyboard example. Use several subpaths for a
shape with a HOLE in it too, and give that one fill-rule: evenodd.

A path is painted with fill and stroke in style, exactly as in SVG. Say what you mean —
a path that names neither is drawn as a plain dark line. Filled silhouettes read better at
small sizes than outlines do.
  style="fill: #2b2b28"                                    a solid shape
  style="fill: none; stroke: #2b2b28; stroke-width: 2"     a line
  style="fill: #fff; stroke: #d8d8d4; stroke-width: 1"     an outlined shape
stroke-linecap: round and stroke-linejoin: round make a drawn line look drawn.

A path holds no label. Words about a drawing go in an <nt-text> beside it, as the captions
do in the storyboard example.

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
particular product — build that, and put the surface colour on <nt-diagram> itself so the
whole canvas reads as one screen rather than pale shapes on white. A mockup of a dark app
is dark.
Said nothing about it, work neutral and flat like the examples: #f2f2f0 fills, #d8d8d4
lines, #2b2b28 text, white surfaces, no gradients, no drop shadows. That is the default,
not a rule.
A drawing may take as much colour as it needs — a tree is green — but keep it flat and
few: a handful of solid fills, no gradients, no shading.
Labels are 12-13px; a heading in a mockup can be larger. Centre a label with display:
flex; align-items: center; justify-content: center.
SIZE AND PLACEMENT
The diagram sits in a document column about 600px wide and is shown from its top-left
corner, so lay it out there: start at about x=40, y=40, keep the whole thing within 600px
across, and set w/h on <nt-diagram> to just contain the content plus that margin. A canvas
far wider than what is in it puts the drawing off to one side of the column, and content
past 600px is off the edge. Keep 40px between things that are not related.

WHAT TO DRAW
${USE_CASES}

Take the labels from the page's own wording wherever it says something — a diagram of the
page should use its words. Six to ten shapes is usually right for a diagram; past a dozen
it stops being readable. A drawing is counted differently — every stroke is a shape, so
spend as many as the thing needs and keep each one simple. If the brief does not describe
something a diagram or a drawing would actually show, reply with nothing at all.`;

/**
 * Few-shot pairs. The brief is written the way stage one writes one.
 *
 * Four, because there are four ways to lay a canvas out and not four subjects:
 * coordinates, a grid, nesting, and drawn geometry. The storyboard goes last —
 * it is the one that is both, and the position nearest the real brief is the one
 * a model weighs most.
 */
const SHOTS: Array<{ brief: string; html: string }> = [
  { brief: "the order fulfilment process, with the out-of-stock branch", html: FLOWCHART },
  { brief: "a table of regions with their owner and revenue", html: TABLE },
  { brief: "a mockup of the analytics dashboard screen", html: MOCKUP },
  { brief: "a storyboard of her morning commute, three frames", html: STORY },
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
  onUsage?: (result: { usage: LanguageModelUsage; latencyMs: number }) => void,
): Response {
  const started = Date.now();
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
    onEnd: ({ totalUsage }) =>
      onUsage?.({ usage: totalUsage, latencyMs: Date.now() - started }),
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
