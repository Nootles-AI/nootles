import { generateText, streamText, type LanguageModelUsage } from "ai";
import { AI } from "./aiConfig";
import { CANVAS_GRAMMAR } from "./canvasGrammar";
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
brief describing what to draw and the page it is being drawn on. You reply with a plan
comment and then ONE <nt-diagram> element — nothing else, no other prose, no code fence.

THE GRAMMAR

${CANVAS_GRAMMAR}

WHAT TO DRAW
${USE_CASES}

PLAN, THEN DRAW
Open every reply with the plan, as one HTML comment. Three lines:
  scene:  every object the drawing needs, back to front — the background counts
  parts:  each drawn object broken into its NAMED components (a fox is body, head, ears,
          tail, legs; a lamp is base, stem, shade)
  layout: where each object sits, as x y w h on this canvas, and the colour it takes
The plan is where the composition is decided — coverage, overlap, what reads at a glance —
and the drawing can only be as good as the plan it answers to. A component missing from
parts: will be missing from the picture. Then draw exactly what the plan says: every
component its own shape or path, its id naming what it is (fox-tail, lamp-shade), in the
plan's stacking order.

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
/**
 * Each example's plan, prepended to its reply. The measured effect of forcing
 * this expansion is the largest of any prompt-level technique in the SVG
 * literature (ablating it cost ~40% on image fidelity — Chat2SVG's stage-one
 * finding): objects that never make the parts line never make the picture, so
 * the plan is where completeness and composition are actually decided. Shown
 * in every example because the example is what the model copies — a contract
 * stated only in prose gets a plan only sometimes.
 */
const PLANS = {
  flowchart: `<!-- plan
scene: four process steps, one decision, connectors
parts: boxes and a diamond carry their own labels; no drawn objects
layout: start 200 40 200x56; decision 180 156 240x128; yes-branch 40 344 200x56; no-branch 360 344 200x56; neutral fills -->`,
  table: `<!-- plan
scene: one grid of regions
parts: header row (region, owner, revenue), two data rows
layout: single grid group 40 40 520x136, three equal columns, white cells on a hairline grid -->`,
  mockup: `<!-- plan
scene: app window, title bar, sidebar nav, headline, stat cards, chart placeholder
parts: title bar is three dots; sidebar is three nav rows; cards are three tiles
layout: window 40 40 520x360 white; bar across the top 40h; sidebar 140w down the left; cards row 200 140 340x80; chart 200 240 340x140 -->`,
  story: `<!-- plan
scene: three frames with captions; per frame — 1: hill and sun; 2: road and car; 3: desk and figure
parts: hill one curve; sun one ellipse; road a trapezoid; car body one silhouette; desk a slab; figure head-and-limbs in one stroke
layout: frames 160x120 at x 40/220/400 y 40, captions under each; hill fills frame-1 base #dfe7d8; sun upper right #f0d9a8; car dark #2b2b28 on the road; figure dark stroke at the desk -->`,
} as const;

const SHOTS: Array<{ brief: string; html: string }> = [
  {
    brief: "the order fulfilment process, with the out-of-stock branch",
    html: `${PLANS.flowchart}\n${FLOWCHART}`,
  },
  {
    brief: "a table of regions with their owner and revenue",
    html: `${PLANS.table}\n${TABLE}`,
  },
  {
    brief: "a mockup of the analytics dashboard screen",
    html: `${PLANS.mockup}\n${MOCKUP}`,
  },
  {
    brief: "a storyboard of her morning commute, three frames",
    html: `${PLANS.story}\n${STORY}`,
  },
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

/**
 * A fixed frame to fill — a storyboard shot, rather than a document diagram.
 * Null means the ordinary 600px-column sizing the grammar teaches.
 */
export type DrawFrame = { w: number; h: number } | null;

/**
 * How much coordinate room a frame is drawn in, over the size it is stored at.
 *
 * Measured, on one brief at three settings: the same model drawing the same
 * fox produced a flat orange blob at 320x180 and a fox with ears, muzzle, brush
 * tail and white markings at 640x360 — with FEWER shapes. Detail is limited by
 * how finely a coordinate can be said, not by how many shapes are spent, and a
 * 320-wide frame leaves no room to say "muzzle". The scene is vector, so the
 * board scales the result back down for nothing: this buys precision free.
 */
const DRAW_SCALE = 2;

/**
 * What changes when the target is a frame, said AFTER the grammar so the more
 * specific instruction wins. The grammar's sizing rules assume a diagram born
 * into a document column with margins; a shot is a film frame, and a film
 * frame is filled to its edges — a margin there reads as a mistake, not as
 * breathing room.
 */
const frameNote = (frame: DrawFrame): string =>
  frame
    ? `\n\nTHE FRAME
This drawing is one storyboard frame, exactly ${frame.w} wide and ${frame.h} tall. Set
<nt-diagram w="${frame.w}" h="${frame.h}"> exactly and IGNORE the column sizing above: no
margin, no 40px inset. Fill the frame to its edges the way a film shot fills the screen —
sky and ground bleed off all four sides, and the subject sits where the camera would put
it. Give <nt-diagram> itself the scene's ground colour in style.
Draw it as richly as the scene deserves. A subject reads by its PARTS — a fox is body,
head, ears, muzzle, legs, tail and tail-tip, each its own shape — never as one blob, and a
landscape reads by its layers: sky, far ridge, near ridge, ground, foreground framing.
Plan the frame like a camera: open the plan's scene line with the shot itself — wide,
close, low angle, over-the-shoulder — and let the layout line place the subject the way
that shot would.`
    : "";

/**
 * The `<nt-diagram>` element out of a finished reply, or "". Models fence, and
 * sometimes preface — the element is the reply.
 *
 * A reply the token cap cut off has no closing tag, and demanding one threw
 * whole drawings away: a rich brief ("cinematic 3D, forced perspective") runs
 * long, the cap lands mid-shape, and the ninety complete shapes before the cut
 * were discarded with the half one — measured as a third of a board's draws
 * coming back empty and being expensively redrawn. Salvage instead: keep
 * everything up to the last complete element, close the diagram ourselves, and
 * let the parser's ordinary tolerance handle the seam.
 */
export function diagramElement(text: string): string {
  const whole = /<nt-diagram[\s\S]*<\/nt-diagram>/i.exec(text)?.[0];
  if (whole) return whole;
  const open = text.search(/<nt-diagram[\s>]/i);
  if (open === -1) return "";
  let body = text.slice(open);
  if (!body.includes(">")) return "";
  // Cut after the last complete closing tag, so what we close holds only
  // whole shapes — the tail is usually an element severed mid-attribute.
  const lastClose = body.lastIndexOf("</nt-");
  if (lastClose > 0) {
    const end = body.indexOf(">", lastClose);
    if (end !== -1) body = body.slice(0, end + 1);
  }
  return `${body}\n</nt-diagram>`;
}

/**
 * One drawing, whole — the chat agent's `draw` tool.
 *
 * The agent's own model is picked for tool orchestration and long-context
 * recall, not for drawing, and inside a turn a drawing is a side task: its
 * attention is split across page reads, board structure and six captions at
 * once. This call gives every picture what the drawing benchmarks give theirs
 * — a drawing specialist, one canvas, nothing else on its mind. The same
 * split the completion lane has always used, reached from the other side.
 *
 * Non-streaming because a tool result is atomic; the review preview shows the
 * finished drawing the moment the agent places it.
 */
export async function generateDiagram(
  brief: string,
  frame: DrawFrame,
  signal?: AbortSignal,
  onUsage?: (result: { usage: LanguageModelUsage; latencyMs: number }) => void,
): Promise<string> {
  const started = Date.now();
  // Asked for at scale; the board scales it back into the shot's own box.
  const room: DrawFrame = frame
    ? { w: frame.w * DRAW_SCALE, h: frame.h * DRAW_SCALE }
    : null;
  const { text, totalUsage, finishReason } = await generateText({
    model: diagramModel(),
    system: SYSTEM + frameNote(room),
    messages: [
      ...SHOTS.flatMap(
        (shot) =>
          [
            { role: "user" as const, content: `Draw: ${shot.brief}` },
            { role: "assistant" as const, content: shot.html },
          ] as const,
      ),
      { role: "user", content: `Draw: ${brief}` },
    ],
    maxOutputTokens: AI.diagram.maxTokens,
    abortSignal: signal,
  });
  onUsage?.({ usage: totalUsage, latencyMs: Date.now() - started });
  const html = diagramElement(text);
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[draw] finish=${finishReason} text=${text.length}ch html=${html.length}ch` +
        ` brief="${brief.slice(0, 60)}"`,
    );
  }
  return html;
}
