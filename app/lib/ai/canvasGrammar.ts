/**
 * The canvas grammar, taught once.
 *
 * Two lanes write diagrams and they had drifted apart. The builder in
 * `diagram.ts` knew every element, every layout mode and what a diagram should
 * look like; the chat agent's standing prompt knew two rectangles and an edge.
 * Asked for a flowchart it produced unstyled boxes, because the styling rules
 * were never in its prompt — and asked to draw anything at all it fell back to
 * ASCII in prose, because nothing it had been told about could make a curve.
 *
 * Which is a documentation bug, not a model one. The parser has always accepted
 * all seven kinds; only one of the two prompts said so. So the grammar lives
 * here and both import it, and the next element added to the canvas is added in
 * one place rather than in whichever prompt its author happened to be editing.
 *
 * It costs the chat lane roughly a thousand tokens per turn. That block sits
 * above the cache breakpoint `route.ts` sets and does not change for the length
 * of a conversation, so it is written once and read back at a tenth the price
 * thereafter — and the agent has to hold all of it regardless of what it is
 * asked, because `read_page` hands it real diagrams. An agent that only knows
 * rectangles flattens the ellipses in a diagram it was asked to relabel.
 */
export const CANVAS_GRAMMAR = `Shapes:  <nt-rect> <nt-ellipse> <nt-polygon sides="n"> <nt-image src=""> <nt-group>
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
than arranged, draw it. Never draw with characters: ASCII art is not a diagram, and a canvas
that can hold a curve should never be handed a row of slashes.

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
one colour, as a stick figure is. Use several subpaths for a shape with a HOLE in it too,
and give that one fill-rule: evenodd.

A path is painted with fill and stroke in style, exactly as in SVG. Say what you mean —
a path that names neither is drawn as a plain dark line. Filled silhouettes read better at
small sizes than outlines do.
  style="fill: #2b2b28"                                    a solid shape
  style="fill: none; stroke: #2b2b28; stroke-width: 2"     a line
  style="fill: #fff; stroke: #d8d8d4; stroke-width: 1"     an outlined shape
stroke-linecap: round and stroke-linejoin: round make a drawn line look drawn.

A path holds no label. Words about a drawing go in an <nt-text> beside it.

GROUPS AND AUTO-LAYOUT
A group with display: flex or display: grid POSITIONS ITS OWN CHILDREN. Inside one, give
each child w and h but NO x and NO y — writing them would be a second, wrong answer about
where the child is. Use gap, padding, flex-direction, align-items, justify-content and
grid-template-columns, exactly as CSS.
A group WITHOUT display is a plain container: its children keep their own x/y.

Reach for a layout group whenever things are evenly spaced — rows, columns, grids, cards.
Use coordinates when the arrangement is the meaning, as it is in a flowchart.

THE LOOK
What was asked for wins. When it says how the thing should look — dark mode, a brand colour,
a particular product — build that, and put the surface colour on <nt-diagram> itself so the
whole canvas reads as one screen rather than pale shapes on white. A mockup of a dark app
is dark.
Said nothing about it, work neutral and flat: #f2f2f0 fills, #d8d8d4 lines, #2b2b28 text,
white surfaces, no gradients, no drop shadows. That is the default, not a rule.
A drawing may take as much colour as it needs — a tree is green — but keep it flat and
few: a handful of solid fills, no gradients, no shading.
Every shape carries a style. A shape with none is an invisible box with a label floating in
it, which is what a flowchart looks like when the fills and borders are left off. The
neutral box is:
  style="background: #f2f2f0; border: 1px solid #d8d8d4; border-radius: 10px; display: flex; align-items: center; justify-content: center; text-align: center; color: #2b2b28; font-size: 13px"
Labels are 12-13px; a heading in a mockup can be larger.

SIZE AND PLACEMENT
The diagram sits in a document column about 600px wide and is shown from its top-left
corner, so lay it out there: start at about x=40, y=40, keep the whole thing within 600px
across, and set w/h on <nt-diagram> to just contain the content plus that margin. A canvas
far wider than what is in it puts the drawing off to one side of the column, and content
past 600px is off the edge. Keep 40px between things that are not related.`;
