import { labelText } from "./label";

/**
 * The scene model — the canvas editor's single contract.
 *
 * Everything in `canvas/` compiles against this file: the parser, the
 * serializer, the renderer, the gesture layer, the style panel, the layers
 * panel and the AI bridge. It is deliberately data-only — no parsing, no
 * geometry, no layout, no React — so that it can never drag an implementation
 * decision into a module that disagrees with it.
 *
 * ## The persisted format IS the grammar
 *
 * A canvas block stores canvas HTML, not JSON:
 *
 * ```html
 * <nt-diagram id="c1" w="960" h="540" style="background:#fff">
 *   <nt-rect id="s1" x="40" y="24" w="160" h="72" rot="15"
 *            style="background:#6366f1; border-radius:12px">Ingest</nt-rect>
 *   <nt-group id="g1" x="0" y="200" w="400" h="160"
 *             style="display:flex; gap:16px; padding:12px">
 *     <nt-rect id="s5" w="100" h="60" style="background:#eee">A</nt-rect>
 *   </nt-group>
 * </nt-diagram>
 * ```
 *
 * A `Scene` is exactly that document, parsed. The round trip is a hard
 * requirement in both directions — `serialize(parse(html)) === html`, and
 * `parse(serialize(scene))` deep-equals `scene`. Two consequences shape every
 * type below:
 *
 *  1. **Nothing is dropped.** Attributes this model does not name land in
 *     `attrs`; CSS declarations it does not name stay in `style`. Both survive
 *     untouched.
 *  2. **Optionality is meaningful, not convenience.** A field is optional only
 *     when "absent" and "empty" are different documents (`name`). Everything
 *     else is required and the parser fills the documented default, so no
 *     consumer has to guess and no two consumers can guess differently — and so
 *     deep-equality after a round trip is not defeated by `undefined` vs `{}`.
 *
 * ## Geometry in attributes, appearance in `style`
 *
 * `x`/`y`/`w`/`h`/`rot` (plus `d` on a path, `src` on an image, `sides` on a
 * polygon and `start`/`sweep`/`inner` on an ellipse) are attributes. Everything
 * visual — fills, gradients, borders, radius, shadow, clip-path, typography,
 * and on groups the flex/grid layout — is real CSS in `style`. One way to say
 * each thing, so the sidebar and the compiler cannot disagree.
 *
 * The line between the two is "would a model of this shape need it to answer
 * where its edges are": a polygon's side count and an ellipse's arc would, a
 * drop shadow would not.
 *
 * ## Edges are the one thing that is not a node
 *
 * A connector joins any two nodes — shapes, groups, anything the layers panel
 * lists — so it belongs to neither of them and cannot live in the tree. It is a
 * flat list on the scene instead, and `<nt-edge>` is written as a sibling of
 * the shapes:
 *
 * ```html
 * <nt-edge id="e1" from="s1" to="s5" style="stroke:#111">deploys</nt-edge>
 * ```
 *
 * An edge stores only *which* nodes it joins. Which side it leaves and enters
 * is derived from where the two boxes currently are, so moving a shape re-picks
 * the plugs rather than leaving a connector reaching around behind it. That is
 * a deliberate trade: the route is always sensible, and a hand-authored side
 * would be one more thing to keep true.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A node's stable identity. Every operation addresses nodes by id, never by
 * index — an index is invalidated by any concurrent insert, reorder or undo,
 * and z-order changes constantly.
 */
export type NodeId = string;

/**
 * A connector's stable identity. The same string space as {@link NodeId} — both
 * are `id` attributes in one HTML document, so a mint has to avoid all of them
 * at once — but a distinct name, because the two are never interchangeable at
 * an api boundary.
 */
export type EdgeId = string;

/**
 * Which face of a node's box a connector meets. Four per node: the "plugs" the
 * connector tool reveals, at the middle of each side of the selection box.
 *
 * Never serialized. {@link Scene} stores only the two node ids, and the side is
 * worked out from the current geometry every time the edge is drawn.
 */
export type EdgeSide = "top" | "right" | "bottom" | "left";

export const EDGE_SIDES: readonly EdgeSide[] = [
  "top",
  "right",
  "bottom",
  "left",
];

/** An axis-aligned box in scene units (px). `x`/`y` is the top-left corner. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A position in scene units (px). */
export interface Point {
  x: number;
  y: number;
}

/**
 * A parsed CSS declaration block: property → value.
 *
 * Keys are CSS property names **exactly as authored — kebab-case, lowercase**
 * (`border-radius`, `flex-direction`, `mix-blend-mode`), never the camelCase
 * React spelling. The renderer converts on the way to the DOM; nothing else
 * should. Values are raw CSS strings including units (`"12px"`, `"none"`,
 * `"linear-gradient(...)"`), never numbers.
 */
export type StyleMap = Record<string, string>;

/**
 * A change to a declaration block. `undefined` **removes** the declaration —
 * which is how a control clears a property rather than writing `"none"`, a
 * distinction the round trip can see.
 */
export type StylePatch = Record<string, string | undefined>;

/**
 * The viewport transform, screen px ⇄ scene px:
 *
 * ```
 * screen = scene * zoom + { x, y }
 * scene  = (screen - { x, y }) / zoom
 * ```
 *
 * i.e. exactly `transform: translate(x, y) scale(zoom)` on the scene layer.
 * Transient UI state — never serialized into the grammar.
 */
export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The current selection, in **document order** (back-to-front), not click
 * order. Panels read it as an ordered list — "align to the first selected" and
 * the layers panel both depend on the order being the document's — so the
 * gesture layer must keep it sorted rather than appending on click.
 */
export type Selection = NodeId[];

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

/**
 * The closed set of node kinds. A shape's *appearance* is CSS, so this list
 * stays small: new visual forms (pill, arrow head) are style on an existing
 * kind, not new kinds.
 *
 * `polygon` is the exception that proves it. A regular N-gon is *geometry* — it
 * has to be parametric so the side count stays editable, and it has to stroke
 * its own edges, which a `clip-path` on a rect cannot do. A four-sided polygon
 * is the diamond tool; the older diamonds authored as a clipped rect are still
 * rects and still render.
 */
export type SceneNodeKind =
  | "rect"
  | "ellipse"
  | "polygon"
  | "text"
  | "image"
  | "path"
  | "group";

/** Iteration order for tool palettes and validation. */
export const SCENE_NODE_KINDS = [
  "rect",
  "ellipse",
  "polygon",
  "text",
  "image",
  "path",
  "group",
] as const satisfies readonly SceneNodeKind[];

/** Root element tag of a canvas document. */
export const SCENE_TAG = "nt-diagram";

/** Kind → element tag. The parser and serializer must share this map. */
export const TAG_BY_KIND: Record<SceneNodeKind, string> = {
  rect: "nt-rect",
  ellipse: "nt-ellipse",
  polygon: "nt-polygon",
  text: "nt-text",
  image: "nt-image",
  path: "nt-path",
  group: "nt-group",
};

/** Element tag → kind. `null` for anything outside the grammar. */
export function kindForTag(tag: string): SceneNodeKind | null {
  const t = tag.toLowerCase();
  for (const kind of SCENE_NODE_KINDS) {
    if (TAG_BY_KIND[kind] === t) return kind;
  }
  return null;
}

/**
 * Attribute names this model owns. Everything else on an element goes into
 * `attrs` verbatim and comes back out unchanged.
 *
 * Booleans are written as `locked="true"` / `hidden="true"` and omitted when
 * false; `rot` is omitted when 0; `name` is omitted when undefined. Fixing the
 * encoding here is what makes `serialize(parse(html)) === html` achievable
 * rather than approximately true.
 */
export const RESERVED_ATTRS = [
  "id",
  "x",
  "y",
  "w",
  "h",
  "rot",
  "name",
  "locked",
  "hidden",
  "d",
  "src",
  "style",
] as const;

/**
 * Attributes one kind owns. Reserved on that kind and carried verbatim on every
 * other, so a `sides` a model hung on a rect is still just an attribute rather
 * than a number silently dropped on the way through.
 */
export const KIND_ATTRS: Record<SceneNodeKind, readonly string[]> = {
  rect: [],
  ellipse: ["start", "sweep", "inner"],
  polygon: ["sides"],
  text: [],
  image: [],
  path: [],
  group: [],
};

/** True when an attribute is modelled explicitly and must not enter `attrs`. */
export function isReservedAttr(attr: string, kind?: SceneNodeKind): boolean {
  const name = attr.toLowerCase();
  if ((RESERVED_ATTRS as readonly string[]).includes(name)) return true;
  return kind !== undefined && KIND_ATTRS[kind].includes(name);
}

/** Fields every node carries, whatever its kind. */
export interface SceneNodeBase {
  id: NodeId;

  /**
   * Box position, relative to the parent group's box (or to the scene for a
   * top-level node). Rotation does not affect it: `x`/`y`/`w`/`h` always
   * describe the *unrotated* box, and `rot` spins it about its centre.
   *
   * Inside an auto-layout group (`display:flex|grid`) `x`/`y` are **computed,
   * not authored** — the layout engine writes them and the serializer omits
   * them. Treat them as read-only there.
   */
  x: number;
  y: number;
  w: number;
  h: number;

  /** Clockwise degrees about the box centre. 0 when unrotated. */
  rot: number;

  /** Parsed `style` attribute. Authoritative for everything visual. */
  style: StyleMap;

  /**
   * The node's text content, plain (the grammar has no inline markup inside a
   * shape). Present on every kind and `""` when there is none, so that generic
   * code never has to narrow just to read it; only kinds where
   * {@link hasText} is true render or serialize it.
   */
  label: string;

  /**
   * The layers-panel name, when the user has set one explicitly.
   *
   * **Undefined is the normal case** — an unnamed node is displayed by its
   * label, falling back to a kind default. Read it through
   * {@link displayName}; never read `node.name` directly for display. Storing
   * the derived name instead would make an unnamed node's label edits stop
   * updating the layers panel, and would add a `name` attribute the source
   * never had.
   */
  name?: string;

  /** Not selectable or editable on the canvas; still visible and still listed. */
  locked: boolean;

  /** Not rendered and not hittable; still listed, still selectable in layers. */
  hidden: boolean;

  /**
   * Attributes outside {@link RESERVED_ATTRS}, verbatim. Carried so the round
   * trip is lossless — never dropped, never interpreted.
   */
  attrs: Record<string, string>;
}

/** The default box. Rounded corners, diamonds and pills are all `style`. */
export interface RectNode extends SceneNodeBase {
  kind: "rect";
}

/**
 * An ellipse, optionally cut into an arc — Figma's pie and donut controls.
 *
 * `start` and `sweep` are clockwise degrees from twelve o'clock; `inner` is the
 * hole as a 0–1 fraction of the radius. **All three are absent on a plain
 * ellipse and all three must stay absent**, because absent is what makes it a
 * `border-radius: 50%` div — the thing every document written so far is, and
 * the thing they must all still serialize to, byte for byte. Writing `start="0"
 * sweep="360" inner="0"` would say the same shape in a form no existing file
 * uses. Read them through {@link arcOf}, which supplies the defaults.
 */
export interface EllipseNode extends SceneNodeBase {
  kind: "ellipse";
  start?: number;
  sweep?: number;
  inner?: number;
}

/**
 * A regular N-gon inscribed in the box, normalised to fill it — so it stretches
 * with a non-square box the way Figma's does. `sides` is an integer ≥ 3 and 4 is
 * the diamond tool.
 */
export interface PolygonNode extends SceneNodeBase {
  kind: "polygon";
  sides: number;
}

/** A text run laid out in its own box. No fill by default. */
export interface TextNode extends SceneNodeBase {
  kind: "text";
}

export interface ImageNode extends SceneNodeBase {
  kind: "image";
  /** `src` attribute, verbatim (URL or data URI). */
  src: string;
}

/**
 * A vector path from the pen tool.
 *
 * `d` is in coordinates **local to the node box** — origin at the box's
 * top-left, so moving the node is a change to `x`/`y` alone and never a rewrite
 * of the path data.
 */
export interface PathNode extends SceneNodeBase {
  kind: "path";
  d: string;
}

/**
 * A container. Children's `x`/`y` are relative to this group's box.
 *
 * With `display:flex|grid` in `style` it is an auto-layout group: children's
 * positions are computed (see {@link GroupLayout}) and their authored `x`/`y`
 * are neither read nor written.
 */
export interface GroupNode extends SceneNodeBase {
  kind: "group";
  /** Document order = back-to-front, same as the scene's top level. */
  children: SceneNode[];
}

/** Discriminated on `kind`. Exhaustive `switch` is the intended way to consume it. */
export type SceneNode =
  | RectNode
  | EllipseNode
  | PolygonNode
  | TextNode
  | ImageNode
  | PathNode
  | GroupNode;

/** Kinds whose `label` is rendered and serialized as element text content. */
export type TextBearingNode =
  | RectNode
  | EllipseNode
  | PolygonNode
  | TextNode;

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * A connector between two nodes.
 *
 * No geometry of its own — that is the point. `from` and `to` name the nodes,
 * and where the line runs is recomputed from their boxes on every draw, so a
 * connector cannot go stale when a shape moves. Appearance is CSS in `style`,
 * exactly as it is for a node: `stroke`, `stroke-width`, `stroke-dasharray`.
 *
 * `label` is the element's text content, the same place a shape's label lives.
 */
export interface SceneEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  /** `""` when the element had no text, so absence and empty are one thing. */
  label: string;
  style: StyleMap;
  /** Attributes outside {@link EDGE_ATTRS}, verbatim. */
  attrs: Record<string, string>;
}

/** The connector element. */
export const EDGE_TAG = "nt-edge";

/** Tags accepted as a connector, canonical first. */
export const EDGE_TAGS: readonly string[] = [
  EDGE_TAG,
  "nt-connector",
  "nt-link",
  "edge",
  "connector",
];

/** Attributes the edge model owns; everything else is carried in `attrs`. */
export const EDGE_ATTRS: readonly string[] = ["id", "from", "to", "style"];

export function isEdgeTag(tag: string): boolean {
  return EDGE_TAGS.includes(tag.toLowerCase());
}

export function isEdgeAttr(attr: string): boolean {
  return EDGE_ATTRS.includes(attr.toLowerCase());
}

/**
 * A parsed canvas document.
 *
 * `nodes` is in **document order: index 0 is furthest back, the last element is
 * furthest front.** The layers panel shows this reversed (front at top), like
 * Figma. Nothing else reverses it.
 */
export interface Scene {
  /** Width of the canvas surface in scene px. */
  w: number;
  /** Height of the canvas surface in scene px. */
  h: number;
  /** Parsed `style` of `<nt-diagram>` — the surface's own background etc. */
  style: StyleMap;
  nodes: SceneNode[];
  /**
   * Connectors, in document order. Flat and never nested: an edge joins two
   * nodes anywhere in the tree, so it is a child of neither. Serialized after
   * the shapes, which is also the order they are drawn in — under everything.
   */
  edges: SceneEdge[];
  /**
   * `id` of `<nt-diagram>`. Optional because a document may omit it; preserved
   * so the round trip does not invent one.
   */
  id?: string;
  /** Root attributes outside {@link RESERVED_ATTRS}, verbatim. */
  attrs: Record<string, string>;
}

/**
 * Anything the read helpers can search. Gesture and panel code often holds a
 * bare node list rather than a whole `Scene`; accepting both keeps them from
 * hand-rolling their own traversal.
 */
export type SceneLike = Scene | readonly SceneNode[];

// ---------------------------------------------------------------------------
// Auto-layout (a derived read-view of a group's `style`)
// ---------------------------------------------------------------------------

/**
 * How a group positions its children, from CSS `display`.
 *
 * `"none"` means absolute positioning — children keep their authored `x`/`y`.
 * It is the default and the value for a group with no `display` declaration.
 */
export type LayoutMode = "none" | "flex" | "grid";

export type FlexDirection = "row" | "row-reverse" | "column" | "column-reverse";

/** CSS values verbatim, so the mapping to `style` is the identity. */
export type AlignItems =
  | "flex-start"
  | "center"
  | "flex-end"
  | "stretch"
  | "baseline";

export type JustifyContent =
  | "flex-start"
  | "center"
  | "flex-end"
  | "space-between"
  | "space-around"
  | "space-evenly";

/** Resolved padding box in px — the four longhands, never a shorthand string. */
export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * A group's layout, **derived from `style` and never stored**.
 *
 * `style` is the single source of truth; this is the shape the layout engine
 * and the sidebar agree to read it as. That direction matters: the derivation
 * may simplify (a two-value `gap: 16px 24px` collapses to one number), and the
 * original declaration is still in `style` to round-trip. Deriving on read
 * keeps hand-authored and AI-authored CSS working; storing this instead would
 * make anything the sidebar cannot express unrepresentable.
 */
export interface GroupLayout {
  mode: LayoutMode;
  flexDirection: FlexDirection;
  /** Uniform gap in px. */
  gap: number;
  padding: Padding;
  alignItems: AlignItems;
  justifyContent: JustifyContent;
  /** Raw CSS track list, e.g. `"repeat(3, 1fr)"`. Only meaningful when grid. */
  gridTemplateColumns: string;
}

/** Which declaration each {@link GroupLayout} field is read from and written to. */
export const LAYOUT_STYLE_PROPS: Record<keyof GroupLayout, string> = {
  mode: "display",
  flexDirection: "flex-direction",
  gap: "gap",
  padding: "padding",
  alignItems: "align-items",
  justifyContent: "justify-content",
  gridTemplateColumns: "grid-template-columns",
};

// ---------------------------------------------------------------------------
// Operations — the editor's internal mutation vocabulary
// ---------------------------------------------------------------------------

/**
 * Everything the canvas editor can do to a scene, as data.
 *
 * This is the *editor's* vocabulary and is distinct from
 * `convex/ai/operations.ts`, which is the *document AI's* vocabulary over
 * blocks. They meet at the canvas block: an AI canvas edit lands as HTML, is
 * parsed, and any subsequent human edit is one of these.
 *
 * Conventions, uniform across the union:
 *  - The discriminant is `type` (`kind` already means "node kind" everywhere in
 *    this file; reusing it would make `op.kind === "rect"` look plausible).
 *  - Ops address one or more ids. An op whose value differs per node carries an
 *    array of entries; an op whose value is uniform carries `ids` plus the value.
 *  - A gesture commits **one array of ops** = one undo entry. Ops apply in
 *    order, all or nothing.
 *  - Ops are declarative results, not gestures: they are emitted at gesture end,
 *    never per frame (per-frame work mutates the DOM directly through refs).
 */
export type SceneOp =
  /** Translate by a delta — nudge and drag are the same op. */
  | { type: "move"; ids: NodeId[]; dx: number; dy: number }
  /**
   * Absolute boxes, per node: a handle drag gives every selected node a
   * different frame, and a left-edge drag changes `x` as well as `w`.
   */
  | { type: "resize"; frames: NodeFrame[] }
  /**
   * Absolute degrees, applied to each id. Rotating a multi-selection about a
   * shared centre also moves the nodes — emit `rotate` and `move` together.
   */
  | { type: "rotate"; ids: NodeId[]; rot: number }
  /** Merge declarations; an `undefined` value removes one. */
  | { type: "setStyle"; ids: NodeId[]; decls: StylePatch }
  /**
   * The parametric geometry a kind carries beyond its box. **Replace
   * semantics** — what you pass is what the node ends up with, so `{}` on an
   * ellipse restores a plain one and `{ sides: 5 }` turns a diamond into a
   * pentagon. A patch would need a second spelling for "remove", and removal is
   * the whole difference between a donut and a circle.
   */
  | { type: "setShape"; ids: NodeId[]; params: ShapeParams }
  | { type: "setLabel"; id: NodeId; label: string }
  /** `undefined` clears an explicit name, restoring the derived one. */
  | { type: "setName"; id: NodeId; name: string | undefined }
  /**
   * Insert already-built nodes (ids minted by the caller, unique scene-wide).
   * `parentId: null` is the scene root. `index` is a document-order index among
   * the target's children; omitted means append, i.e. frontmost.
   */
  | {
      type: "insert";
      nodes: SceneNode[];
      parentId?: NodeId | null;
      index?: number;
    }
  /** Removes each id and its whole subtree. */
  | { type: "remove"; ids: NodeId[] }
  /** Z-order and reparenting: both are "put these nodes somewhere else in the tree". */
  | { type: "reorder"; ids: NodeId[]; to: ZTarget }
  /**
   * Wrap the ids in a new group. The applier computes the group's box from the
   * selection's bounds and rewrites the children's `x`/`y` to be relative to
   * it; the caller supplies only the id (and optionally a name).
   */
  | { type: "group"; ids: NodeId[]; groupId: NodeId; name?: string }
  /** Dissolve each group, splicing its children into the group's place in z-order. */
  | { type: "ungroup"; ids: NodeId[] }
  | { type: "setLocked"; ids: NodeId[]; locked: boolean }
  | { type: "setHidden"; ids: NodeId[]; hidden: boolean }
  /**
   * Pen-tool edit. `frame` accompanies `d` because editing a point usually
   * changes the path's bounds, and `d` is local to the box.
   */
  | { type: "setPath"; id: NodeId; d: string; frame?: Rect }
  | { type: "align"; ids: NodeId[]; to: Alignment; relativeTo?: AlignTarget }
  /**
   * Even spacing along an axis. `spacing` undefined spreads the nodes within
   * their current bounds; a number sets a fixed gap starting from the first.
   */
  | {
      type: "distribute";
      ids: NodeId[];
      axis: DistributeAxis;
      spacing?: number;
    }
  /**
   * Add already-built connectors, ids minted by the caller. An edge naming a
   * node that is not in the scene is dropped by the applier rather than stored:
   * a dangling connector has nothing to draw between.
   */
  | { type: "addEdge"; edges: SceneEdge[] }
  | { type: "removeEdge"; ids: EdgeId[] }
  | { type: "setEdgeLabel"; id: EdgeId; label: string }
  | { type: "setEdgeStyle"; ids: EdgeId[]; decls: StylePatch }
  /**
   * Re-aim one end, or both. Omitting an end leaves it where it was, which is
   * what makes a swap a single op.
   */
  | { type: "reconnect"; id: EdgeId; from?: NodeId; to?: NodeId };

export type SceneOpType = SceneOp["type"];

/** One node's absolute box, for {@link SceneOp} `resize`. */
export type NodeFrame = { id: NodeId } & Rect;

/** Geometry that is not the box: {@link PolygonNode} and {@link EllipseNode}. */
export type ShapeParams = {
  sides?: number;
  start?: number;
  sweep?: number;
  inner?: number;
};

/**
 * Where `reorder` puts the nodes. The relative forms are the z-order menu; the
 * `index` form is a layers-panel drag, which may also change parent.
 */
export type ZTarget =
  | { at: "front" }
  | { at: "back" }
  | { at: "forward" }
  | { at: "backward" }
  | { at: "index"; parentId: NodeId | null; index: number };

export type Alignment =
  | "left"
  | "hcenter"
  | "right"
  | "top"
  | "vcenter"
  | "bottom";

/**
 * What `align` aligns against. Defaults to `"selection"` for a multi-selection
 * and `"parent"` for a single node — aligning one node to itself is a no-op,
 * which is not what the button appears to promise.
 */
export type AlignTarget = "selection" | "parent";

export type DistributeAxis = "horizontal" | "vertical";

// ---------------------------------------------------------------------------
// Helpers — pure, allocation-light, and the only sanctioned implementations
// ---------------------------------------------------------------------------

/** Narrows to the group kind — ask this when you mean the `<nt-group>` tag. */
export function isGroup(node: SceneNode): node is GroupNode {
  return node.kind === "group";
}

/**
 * Narrows to nodes that may hold children — ask this when you mean "can this
 * take a drop / must I recurse into it", so tree code reads as capability
 * rather than as a tag check.
 */
export function isContainer(node: SceneNode): node is GroupNode {
  return node.kind === "group";
}

/** Narrows to kinds whose `label` is rendered and serialized. */
export function hasText(node: SceneNode): node is TextBearingNode {
  return (
    node.kind === "rect" ||
    node.kind === "ellipse" ||
    node.kind === "polygon" ||
    node.kind === "text"
  );
}

/** A full ellipse, as an arc. What {@link arcOf} means by "nothing set". */
export const FULL_ARC = { start: 0, sweep: 360, inner: 0 } as const;

/**
 * True when an ellipse carries arc geometry. A plain one renders as a div and
 * an arc as an SVG path, so this is the question both the renderer and the
 * sidebar ask — and asking it in one place is what keeps "absent means plain"
 * from being re-derived slightly differently somewhere.
 */
export function isArc(node: SceneNode): node is EllipseNode {
  return (
    node.kind === "ellipse" &&
    (node.start !== undefined ||
      node.sweep !== undefined ||
      node.inner !== undefined)
  );
}

/** An ellipse's arc with the defaults filled in. */
export function arcOf(node: EllipseNode): {
  start: number;
  sweep: number;
  inner: number;
} {
  return {
    start: node.start ?? FULL_ARC.start,
    sweep: node.sweep ?? FULL_ARC.sweep,
    inner: node.inner ?? FULL_ARC.inner,
  };
}

/** Layers-panel name for an unnamed, unlabelled node. */
export function defaultNameFor(kind: SceneNodeKind): string {
  switch (kind) {
    case "rect":
      return "Rectangle";
    case "ellipse":
      return "Ellipse";
    case "polygon":
      return "Polygon";
    case "text":
      return "Text";
    case "image":
      return "Image";
    case "path":
      return "Path";
    case "group":
      return "Group";
  }
}

/**
 * A polygon's side count is the whole of what it looks like, and one kind
 * covers all of them — a diamond listed as "Polygon" is the tool's name, not
 * the shape's. Display only: nothing here is ever serialized, so no document
 * gains a `name` attribute from it.
 */
const POLYGON_NAMES: Record<number, string> = {
  3: "Triangle",
  4: "Diamond",
  5: "Pentagon",
  6: "Hexagon",
  8: "Octagon",
};

/**
 * What the layers panel shows: the explicit name, else the label, else the kind
 * default. Truncation is the panel's (CSS) problem, not this function's.
 */
export function displayName(node: SceneNode): string {
  if (node.name !== undefined && node.name !== "") return node.name;
  const label = labelText(node.label).trim();
  if (label) return label;
  if (node.kind === "polygon") {
    return POLYGON_NAMES[Math.round(node.sides)] ?? "Polygon";
  }
  // A pen path that closes encloses an area — it is a shape, and reads as one.
  // `serializePath` ends a closed path with `Z`, and testing the `d` keeps this
  // module free of the imports that make it the contract everything can hold.
  if (node.kind === "path" && /[Zz]\s*$/.test(node.d)) return "Shape";
  return defaultNameFor(node.kind);
}

function rootNodes(scene: SceneLike): readonly SceneNode[] {
  return Array.isArray(scene) ? scene : (scene as Scene).nodes;
}

/**
 * Depth-first traversal in document order (back-to-front), parents before
 * children.
 *
 * `visit` receives the node, its parent group (`null` at the top level) and its
 * index among its siblings. Return `false` to skip that node's subtree —
 * hit-testing skips hidden and locked subtrees, and without this every caller
 * writes its own recursion to do it.
 */
export function walk(
  nodes: readonly SceneNode[],
  visit: (
    node: SceneNode,
    parent: GroupNode | null,
    index: number,
  ) => void | false,
): void {
  const step = (list: readonly SceneNode[], parent: GroupNode | null) => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i];
      if (visit(node, parent, i) === false) continue;
      if (isContainer(node)) step(node.children, node);
    }
  };
  step(nodes, null);
}

/** The node with this id, at any depth. `null` when it is not in the scene. */
export function findNode(scene: SceneLike, id: NodeId): SceneNode | null {
  let found: SceneNode | null = null;
  walk(rootNodes(scene), (node) => {
    if (found) return false;
    if (node.id === id) found = node;
  });
  return found;
}

/**
 * The group containing this id. `null` means top level **or absent** — call
 * {@link findNode} first if you need to tell those apart.
 */
export function findParent(scene: SceneLike, id: NodeId): GroupNode | null {
  let found: GroupNode | null = null;
  let done = false;
  walk(rootNodes(scene), (node, parent) => {
    if (done) return false;
    if (node.id === id) {
      found = parent;
      done = true;
    }
  });
  return found;
}

/**
 * The ancestor chain, outermost first and **including the node itself**.
 * Empty when the id is not in the scene.
 *
 * This is the one traversal that both coordinate transforms (accumulate parent
 * offsets) and the layers panel (indentation, expansion) need, so it lives here
 * rather than being written twice with different endpoints.
 */
export function nodePath(scene: SceneLike, id: NodeId): SceneNode[] {
  const path: SceneNode[] = [];
  const step = (list: readonly SceneNode[]): boolean => {
    for (const node of list) {
      path.push(node);
      if (node.id === id) return true;
      if (isContainer(node) && step(node.children)) return true;
      path.pop();
    }
    return false;
  };
  return step(rootNodes(scene)) ? path : [];
}

/**
 * The selected nodes in document order — what every style-panel section is
 * handed. Ids that are no longer in the scene are dropped rather than throwing,
 * because a stale selection outliving a delete or an undo is routine.
 */
export function selectedNodes(
  scene: SceneLike,
  selection: readonly NodeId[],
): SceneNode[] {
  const wanted = new Set(selection);
  if (wanted.size === 0) return [];
  const out: SceneNode[] = [];
  walk(rootNodes(scene), (node) => {
    if (wanted.has(node.id)) out.push(node);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Edge reads
// ---------------------------------------------------------------------------

/** A bare node list carries no connectors, which is not an error — the gesture
 *  and panel code that holds one is asking about nodes. */
function sceneEdges(scene: SceneLike): readonly SceneEdge[] {
  return Array.isArray(scene) ? [] : ((scene as Scene).edges ?? []);
}

/** In document order, stale ids dropped — {@link selectedNodes} for edges. */
export function selectedEdges(
  scene: SceneLike,
  selection: readonly EdgeId[],
): SceneEdge[] {
  const wanted = new Set(selection);
  if (wanted.size === 0) return [];
  return sceneEdges(scene).filter((edge) => wanted.has(edge.id));
}

/**
 * Every connector with an end on one of these nodes, **including ends on their
 * descendants** — deleting a group takes its children with it, and a connector
 * into one of those children has lost its anchor just as surely.
 */
export function edgesTouching(
  scene: Scene,
  ids: readonly NodeId[],
): SceneEdge[] {
  const gone = new Set<NodeId>();
  for (const id of ids) {
    const node = findNode(scene, id);
    if (node) walk([node], (n) => void gone.add(n.id));
    else gone.add(id);
  }
  return scene.edges.filter((e) => gone.has(e.from) || gone.has(e.to));
}

/** How a connector reads in the layers panel and the inspector. */
export function edgeName(scene: SceneLike, edge: SceneEdge): string {
  const end = (id: NodeId) => {
    const node = findNode(scene, id);
    return node ? displayName(node) : "?";
  };
  return `${end(edge.from)} → ${end(edge.to)}`;
}
