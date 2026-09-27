/**
 * {@link Scene} → standard HTML/CSS (or JSX) — a diagram, transcribed rather
 * than translated. Every decision this file makes about paint, geometry and
 * layout is the decision `render/ShapeView.tsx` / `render/svgShape.tsx` /
 * `render/EdgeLayer.tsx` already make, read from the exact functions those
 * modules were split around (`scene/shapePaint.ts`, `scene/boxModel.ts`,
 * `scene/edgeMarker.ts`) so a click, a render and a compile can never quietly
 * disagree.
 *
 * Not to be confused with `app/lib/ai/html/compile.ts` — a different, older
 * compiler in the same directory (BlockNote `DocNode[]` → an op `Batch`, for
 * `edit_page`). This file compiles a canvas `Scene` to markup; do not import
 * both under an alias named `compile` in the same module.
 *
 * Pure and synchronous except where a boolean group needs the polygon clipper
 * (`compileSceneReady`/`compileSelectionReady`/`compileToHtml`). No React, no
 * DOM, no `"use client"`. Deliberately does not import `render/`, `engine/`,
 * `panels/` or `collab/` — this is a read of the scene model, never the live
 * viewport (`engine/useViewport.ts` is not, and must never be, a dependency:
 * copying at 20% zoom and at 800% zoom must produce byte-identical output).
 */

import { laidOutScene, isPinned, layoutOf, isAutoLayout } from "@/app/components/editor/canvas/scene/autoLayout";
import { bandHeight, bandLeft, bandWidth } from "@/app/components/editor/canvas/scene/band";
import { derivedPath, loadClipper, operandsPath } from "@/app/components/editor/canvas/scene/boolean";
import { cssKey, flowFor, isAutoSize, labelInsetOf, type Flow } from "@/app/components/editor/canvas/scene/boxModel";
import { ARROW_MARKER } from "@/app/components/editor/canvas/scene/edgeMarker";
import {
  edgePoints,
  obstaclesFor,
  pointsToPath,
  polylineMidpoint,
  sceneObstacles,
} from "@/app/components/editor/canvas/scene/edgePath";
import {
  absoluteRect,
  absoluteRotation,
  absoluteSelectionBounds,
} from "@/app/components/editor/canvas/scene/geometry";
import {
  hasBlocks,
  labelBlocks,
  type LabelBlock,
  type LabelMarks,
  type LabelRun,
  type LabelStyle,
} from "@/app/components/editor/canvas/scene/label";
import { paintOf } from "@/app/components/editor/canvas/scene/paint";
import { parseScene, type ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import {
  clipsToShape,
  dropPaint,
  dropStroke,
  paintsBox,
  pathPaintDecls,
  shadowFilterOf,
  shapeGeometry,
  type ShapeGeometry,
} from "@/app/components/editor/canvas/scene/shapePaint";
import { customProperties, resolveVars, type ColorVariable } from "@/app/components/editor/canvas/scene/vars";
import {
  findNode,
  hasText,
  isBoolean,
  isGroup,
  nodePath,
  selectedNodes,
  walk,
  type EdgeId,
  type GroupNode,
  type NodeId,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type StyleMap,
} from "@/app/components/editor/canvas/scene/types";

// ---------------------------------------------------------------------------
// Public types (§2.1)
// ---------------------------------------------------------------------------

export type Flavour = "html" | "jsx";

export interface CompileOptions {
  /** "html" (default) or "jsx". */
  flavour?: Flavour;
  /** Replace every `var(--x)` with the diagram's own value. Default false. */
  resolveVars?: boolean;
  /**
   * Prefix for SVG marker ids, which are document-global. Default
   * `nt-${scene.id}` when the scene carries an id; otherwise a fresh opaque
   * suffix minted per call, `nt-${mintSuffix()}` — never the bare string
   * `"nt"`, which would collide two independently pasted fragments' marker
   * ids on `id="nt-arrow-0"`. Pass one explicitly for a deterministic read
   * (a vitest golden, `get_html` on a scene that already carries `.id`).
   */
  idPrefix?: string;
  /** Add `overflow: hidden` to the root. Default false. */
  clip?: boolean;
  /** Emit `data-nt-id` / `data-nt-edge-label` / `data-nt-ref`. Default true. */
  ids?: boolean;
}

export interface CompileNote {
  id: NodeId | EdgeId | null;
  note: string;
}

export interface Compiled {
  /** One root element. Two-space indent, `\n` line ends, no trailing newline. */
  code: string;
  notes: CompileNote[];
}

// ---------------------------------------------------------------------------
// Small, shared primitives
// ---------------------------------------------------------------------------

/** `delete`-then-`set`, so a key written twice lands where it was written
 *  last — the one rule every declaration order in this file follows (§3.2). */
function put(map: Map<string, string>, key: string, value: string): void {
  map.delete(key);
  map.set(key, value);
}

/** Numbers as `serialize.ts`'s `numAttr` writes them: finite, three decimals,
 *  no trailing zeros worth carrying — path data and edge routing are already
 *  rounded to this precision upstream (`outline.ts`, `edgePath.ts`). */
function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

const px = (n: number): string => `${num(n)}px`;

const ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escAttr = (value: string): string => value.replace(/[&<>"]/g, (c) => ESCAPE[c]);
const escText = (value: string): string => value.replace(/[&<>]/g, (c) => ESCAPE[c]);

/** Declarations as one `prop: value; …` string, empty values dropped — the
 *  same rule `scene/serialize.ts`'s `serializeStyleAttr` applies to NML. */
function declString(decls: Map<string, string>): string {
  const parts: string[] = [];
  for (const [prop, value] of decls) {
    if (prop && value) parts.push(`${prop}: ${value}`);
  }
  return parts.join("; ");
}

const mintSuffix = (): string => Math.random().toString(36).slice(2, 8);

function resolvePrefix(scene: Scene, explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  if (scene.id) return `nt-${scene.id}`;
  return `nt-${mintSuffix()}`;
}

// ---------------------------------------------------------------------------
// Compile-time context — one per `compileScene`/`compileSelection` call
// ---------------------------------------------------------------------------

interface Ctx {
  f: FlavourImpl;
  ids: boolean;
  clip: boolean;
  resolveVarsOn: boolean;
  vars: readonly ColorVariable[];
  prefix: string;
  notes: CompileNote[];
  /** Every node's effective `Flow`, precomputed over the whole tree once —
   *  both node rendering and edge-skip need "is this node actually going to
   *  be drawn", which depends on its own flow (§3.10). */
  flow: Map<NodeId, Flow | undefined>;
}

/** A value that may carry `var(--x)`, resolved when the caller asked for it —
 *  applied uniformly to every emitted CSS value and to the marker `fill`
 *  attribute (§2.3), never to plain text. */
function rv(ctx: Ctx, value: string): string {
  return ctx.resolveVarsOn ? resolveVars(value, ctx.vars) : value;
}

function finalize(ctx: Ctx, decls: Map<string, string>): Map<string, string> {
  if (!ctx.resolveVarsOn) return decls;
  const out = new Map<string, string>();
  for (const [k, v] of decls) out.set(k, resolveVars(v, ctx.vars));
  return out;
}

/** The same `flow` the renderer hands each node — precomputed once so a
 *  node's "is it actually painted" question (§3.10) can be asked about ANY
 *  node in the scene, not just the one currently being walked (an edge's
 *  endpoint may be anywhere). Mirrors `ShapeView`'s own `slot`/`isPinned`
 *  reduction exactly. */
function computeFlow(nodes: readonly SceneNode[]): Map<NodeId, Flow | undefined> {
  const out = new Map<NodeId, Flow | undefined>();
  const visit = (list: readonly SceneNode[], slot: Flow | undefined) => {
    for (const node of list) {
      const flow = slot && isPinned(node) ? undefined : slot;
      out.set(node.id, flow);
      if (isGroup(node)) {
        const childFlow = isAutoLayout(node) ? flowFor(layoutOf(node)) : undefined;
        visit(node.children, childFlow);
      }
    }
  };
  visit(nodes, undefined);
  return out;
}

/** Whether a node is left out of the compiled output entirely — exactly
 *  `ShapeView`'s own `if (node.hidden && !flow) return null;` (§3.10). A node
 *  hidden inside an auto-layout flow is NOT omitted; it is emitted invisible
 *  (`visibility: hidden`), because `resolveLayout` still counts it. */
function isOmitted(ctx: Ctx, node: SceneNode): boolean {
  return node.hidden && ctx.flow.get(node.id) === undefined;
}

/** Whether `box-shadow` is realised as `filter: drop-shadow()` rather than
 *  left as an authored box shadow — exactly `ShapeView`'s `cast` condition:
 *  a path always; a polygon or arc (has its own SVG geometry) always; a group
 *  (boolean or plain) only when it paints nothing of its own. Everything else
 *  (rect, plain ellipse, text, image) never. */
function castsShadowAsFilter(node: SceneNode): boolean {
  if (node.kind === "path") return true;
  if (shapeGeometry(node) !== null) return true;
  if (isGroup(node)) return !paintsBox(node.style);
  return false;
}

const hasBoxShadow = (style: StyleMap): boolean => {
  const v = style["box-shadow"];
  return !!v && v.trim().toLowerCase() !== "none";
};

// ---------------------------------------------------------------------------
// Flavour — html and jsx share every decision above this line; only how a
// tag, an attribute, a style map and a text node are SPELLED differs below.
// ---------------------------------------------------------------------------

/** `fill-rule` → `fillRule`, and the handful of other SVG presentation/marker
 *  attributes React insists on camelCasing (§3.13). Everything not listed
 *  here is already spelled the way JSX wants it (`viewBox`, `refX`, `d`, …). */
const SVG_ATTR_CAMEL: Readonly<Record<string, string>> = {
  "fill-rule": "fillRule",
  "vector-effect": "vectorEffect",
  "stroke-width": "strokeWidth",
  "stroke-dasharray": "strokeDasharray",
  "marker-end": "markerEnd",
};

/** A JSX attribute value: a plain quoted string when that is legal JSX (no
 *  embedded `"`), else a JS string expression — the one case a literal quoted
 *  attribute cannot express (§3.13). */
function jsxAttrLiteral(value: string): string {
  return value.includes('"') ? `{${JSON.stringify(value)}}` : `"${value}"`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** An object-literal key: bare when it is a legal identifier, quoted when it
 *  is not — which is exactly the custom-property case (`"--brand"` stays
 *  quoted; §3.13). */
function jsxKey(key: string): string {
  return IDENT.test(key) ? key : JSON.stringify(key);
}

function jsxStyleObject(ctx: Ctx, decls: Map<string, string>): string {
  const entries: string[] = [];
  for (const [prop, value] of finalize(ctx, decls)) {
    entries.push(`${jsxKey(cssKey(prop))}: ${JSON.stringify(value)}`);
  }
  return `{{ ${entries.join(", ")} }}`;
}

/**
 * The strategy object html and jsx each implement — named `FlavourImpl` so it
 * cannot collide with the public {@link Flavour} option type ("html" | "jsx").
 */
interface FlavourImpl {
  readonly jsx: boolean;
  /** Escaped text content, ready to sit between tags. */
  text(s: string): string;
  /** A DOM/SVG attribute, leading space included; `svg` widens the name to
   *  its JSX spelling when this flavour is jsx. */
  attr(name: string, value: string, svg?: boolean): string;
  /** `style="…"` or `style={{…}}`, leading space included; `""` when the
   *  declaration map is empty (an empty `style={{}}` is still valid JSX but
   *  every fixture omits it, matching the html side exactly). */
  styleAttr(ctx: Ctx, decls: Map<string, string>): string;
}

const HTML_FLAVOUR: FlavourImpl = {
  jsx: false,
  text: (s) => escText(s),
  attr: (name, value) => ` ${name}="${escAttr(value)}"`,
  styleAttr: (ctx, decls) => (decls.size ? ` style="${declString(finalize(ctx, decls))}"` : ""),
};

const JSX_FLAVOUR: FlavourImpl = {
  jsx: true,
  text: (s) => `{${JSON.stringify(s)}}`,
  attr: (name, value, svg) => {
    const jsxName = svg ? (SVG_ATTR_CAMEL[name] ?? name) : name;
    return ` ${jsxName}=${jsxAttrLiteral(value)}`;
  },
  styleAttr: (ctx, decls) => (decls.size ? ` style=${jsxStyleObject(ctx, decls)}` : ""),
};

const flavourOf = (f: Flavour | undefined): FlavourImpl => (f === "jsx" ? JSX_FLAVOUR : HTML_FLAVOUR);

/** `data-nt-id`/`data-nt-edge-label`, present only when `opts.ids` (default
 *  true) — the one identity attribute every node and edge carries (§2.3). */
function idAttr(ctx: Ctx, name: string, id: string): string {
  return ctx.ids ? ctx.f.attr(name, id) : "";
}

// ---------------------------------------------------------------------------
// Box declarations (§3.2) — the one function every kind's style builds from
// ---------------------------------------------------------------------------

interface BoxOpts {
  /** Extra properties the box does not paint because the shape does (§3.5–3.7). */
  drop?: (prop: string) => boolean;
  /** Polygon/arc's compiler-invented stacking context (§3.5). */
  isolation?: boolean;
  /** `clip-path` for a polygon/arc whose fill stayed CSS (§3.5). */
  clipPath?: string | null;
  /** `pathPaintDecls`' own decls, inserted in their own order (step 11, §3.6). */
  paintEntries?: readonly [string, string][];
  /** A path/boolean `<svg>` root: gets the rotation origin fix (step 7) and
   *  is forced `overflow: visible` (step 13). */
  svgRoot?: boolean;
  /** Whether this node casts its `box-shadow` as `filter: drop-shadow()`
   *  (§3.8) — the caller decides via {@link castsShadowAsFilter}; this
   *  function only applies the decision, so the rule lives in one place. */
  shadowCast: boolean;
}

/**
 * One node's style, built in the exact `put` order `render/ShapeView.tsx` and
 * `render/svgShape.tsx` build it in (§3.2's numbered steps). Kind-specific
 * extras (a polygon's clip, a path's paint, an svg root's origin fix) are
 * parameters rather than branches inside this function, so the ORDER stays
 * one thing every kind shares and only the ingredients differ.
 */
function boxDecls(node: SceneNode, flow: Flow | undefined, opts: BoxOpts): Map<string, string> {
  const m = new Map<string, string>();

  // 1. Fixed declarations the canvas gets from `shape.css` for free (§3.1).
  put(m, "box-sizing", "border-box");
  if (hasText(node)) {
    put(m, "white-space", "pre-wrap");
    put(m, "overflow-wrap", "break-word");
  }
  if (node.kind === "ellipse") put(m, "border-radius", "50%");
  if (opts.isolation) put(m, "isolation", "isolate");

  // 2. Authored style, in authored order, minus what the shape drops and
  // minus the label's own `-webkit-line-clamp`.
  for (const prop in node.style) {
    if (prop === "-webkit-line-clamp") continue;
    if (opts.drop?.(prop)) continue;
    put(m, prop, node.style[prop]);
  }

  // 3. clip-path (polygon/arc, CSS-only fill).
  if (opts.clipPath) put(m, "clip-path", opts.clipPath);

  // 4. A diamond's own inset, absent an authored padding.
  const inset = labelInsetOf(node);
  if (inset !== null) put(m, "padding", inset);

  // 5–6. Position, and — free-placed only — where.
  if (flow) {
    put(m, "position", "relative");
  } else {
    put(m, "position", "absolute");
    put(m, "left", px(node.x));
    put(m, "top", px(node.y));
  }

  // 7. Rotation. An svg root's default origin is its view box, not its
  // border box, so it needs the fix a plain HTML element already has by
  // default; a div never does.
  if (node.rot !== 0) {
    put(m, "transform", `rotate(${num(node.rot)}deg)`);
    if (opts.svgRoot) {
      put(m, "transform-origin", "50% 50%");
      put(m, "transform-box", "border-box");
    }
  }

  // 8. Size — the authored keyword when the box hugs, else the axis a
  // stretching parent resolves, else the box's own px.
  if (isAutoSize(node.style.width)) put(m, "width", node.style.width!);
  else put(m, "width", flow === "stretch-x" ? "auto" : px(node.w));
  if (isAutoSize(node.style.height)) put(m, "height", node.style.height!);
  else put(m, "height", flow === "stretch-y" ? "auto" : px(node.h));

  // 9. In a flow, a node never grows or shrinks on its own account.
  if (flow) put(m, "flex", "none");

  // 10. Hidden in a flow keeps its slot, painted invisible; hidden anywhere
  // else is omitted before this function is ever called (§3.10).
  if (node.hidden && flow) put(m, "visibility", "hidden");

  // 11. An svg root's own paint — `pathPaintDecls`' declarations, in order.
  if (opts.paintEntries) for (const [k, v] of opts.paintEntries) put(m, k, v);

  // 12. `box-shadow` cast as `filter: drop-shadow()`, for the kinds whose
  // box is not their drawing (§3.8).
  if (opts.shadowCast) {
    const filter = shadowFilterOf(node.style);
    if (filter !== null) {
      put(m, "box-shadow", "none");
      if (filter) put(m, "filter", filter);
    }
  }

  // 13. An svg root clips to its view box by default; a stroke straddling
  // the geometry it follows must not lose its outer half.
  if (opts.svgRoot) put(m, "overflow", "visible");

  return m;
}

// ---------------------------------------------------------------------------
// Labels (§3.11) — the label grammar, exactly as `render/ShapeLabel.tsx` draws it
// ---------------------------------------------------------------------------

/** The `.nt-label a` fixed declarations (§3.1) — the compiler has no
 *  stylesheet, so every link carries them inline. */
function linkDecls(): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "color", "inherit");
  put(m, "text-decoration", "underline");
  put(m, "text-underline-offset", "0.15em");
  return m;
}

/** The `.nt-ref` fixed declarations (§3.1) — no icon, no hover, no live
 *  title: a page chip is drawn as its stored title, underlined (§8). */
function refDecls(): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "text-decoration", "underline");
  put(m, "text-decoration-thickness", "1px");
  put(m, "text-underline-offset", "2px");
  put(m, "white-space", "nowrap");
  return m;
}

function styleMapOf(style: LabelStyle | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (style) for (const prop in style) put(m, prop, style[prop]);
  return m;
}

/**
 * A text run, wrapped in its marks from the inside out — `<s><u><i><b>`, then
 * a styled `<span>`, then a `<a>` outermost — exactly `RunView`'s nesting
 * order, so a run with everything set comes out `<a><span><b><i><u><s>`.
 */
function renderTextRun(ctx: Ctx, run: LabelRun & { kind: "text" }): string {
  let out = ctx.f.text(run.text);
  const marks: LabelMarks = run.marks;
  if (marks.strike) out = `<s>${out}</s>`;
  if (marks.underline) out = `<u>${out}</u>`;
  if (marks.italic) out = `<i>${out}</i>`;
  if (marks.bold) out = `<b>${out}</b>`;
  if (marks.style) out = `<span${ctx.f.styleAttr(ctx, styleMapOf(marks.style))}>${out}</span>`;
  if (marks.href) {
    out = `<a${ctx.f.attr("href", marks.href)}${ctx.f.attr("target", "_blank")}${ctx.f.attr("rel", "noopener noreferrer")}${ctx.f.styleAttr(ctx, linkDecls())}>${out}</a>`;
  }
  return out;
}

function renderRun(ctx: Ctx, run: LabelRun): string {
  if (run.kind === "ref") {
    return `<span${idAttr(ctx, "data-nt-ref", run.pageId)}${ctx.f.styleAttr(ctx, refDecls())}>${ctx.f.text(run.title)}</span>`;
  }
  return renderTextRun(ctx, run);
}

const renderRuns = (ctx: Ctx, runs: readonly LabelRun[]): string => runs.map((r) => renderRun(ctx, r)).join("");

/** One `<p>`/`<li>`: `margin: 0`, plus the block's own authored spacing
 *  declarations moved to the end by the same `put` rule as everything else. */
function renderBlock(ctx: Ctx, block: LabelBlock, tag: "p" | "li"): string {
  const style = new Map<string, string>([["margin", "0"]]);
  if (block.style) for (const prop in block.style) put(style, prop, block.style[prop]);
  return `<${tag}${ctx.f.styleAttr(ctx, style)}>${renderRuns(ctx, block.runs)}</${tag}>`;
}

const LIST_DECLS: Record<"ul" | "ol", Map<string, string>> = {
  ul: new Map([["margin", "0"], ["padding-left", "1.5em"], ["text-align", "left"], ["list-style", "disc"]]),
  ol: new Map([["margin", "0"], ["padding-left", "1.5em"], ["text-align", "left"], ["list-style", "decimal"]]),
};

/** Blocks → markup: consecutive `li`s of one list share a `<ul>`/`<ol>`. */
function renderBlocks(ctx: Ctx, blocks: readonly LabelBlock[]): string {
  let out = "";
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === "li") {
      const list = block.list ?? "ul";
      let items = "";
      while (i < blocks.length && blocks[i].kind === "li" && (blocks[i].list ?? "ul") === list) {
        items += renderBlock(ctx, blocks[i], "li");
        i++;
      }
      out += `<${list}${ctx.f.styleAttr(ctx, LIST_DECLS[list])}>${items}</${list}>`;
      continue;
    }
    out += renderBlock(ctx, block, "p");
    i++;
  }
  return out;
}

/**
 * The whole label, wrapped in one `<span>` — the shape is a flex container,
 * so one span is one flex item (§3.11). `""` when the label is empty.
 */
function renderLabel(ctx: Ctx, node: SceneNode): string {
  if (node.label === "") return "";
  const blocks = labelBlocks(node.label);
  const rich = hasBlocks(node.label);
  const clampRaw = node.style["-webkit-line-clamp"];
  const lines = clampRaw !== undefined ? Number.parseInt(clampRaw, 10) : 0;

  const wrapper = new Map<string, string>();
  if (rich) {
    put(wrapper, "display", "block");
    put(wrapper, "min-width", "0");
  }
  if (Number.isFinite(lines) && lines > 0) {
    put(wrapper, "display", "-webkit-box");
    put(wrapper, "-webkit-box-orient", "vertical");
    put(wrapper, "overflow", "hidden");
    put(wrapper, "-webkit-line-clamp", String(lines));
  }

  if (blocks.some((b) => b.runs.some((r) => r.kind === "ref"))) {
    ctx.notes.push({ id: node.id, note: "page chip drawn as underlined title" });
  }

  const inner = rich ? renderBlocks(ctx, blocks) : renderRuns(ctx, blocks[0].runs);
  return `<span${ctx.f.styleAttr(ctx, wrapper)}>${inner}</span>`;
}

// ---------------------------------------------------------------------------
// Nodes (§3.3–3.10) — one function per shape the browser draws differently.
// Every node but a group is written on ONE line (§3.11: a text-bearing node's
// `white-space: pre-wrap` would turn a pretty-printed newline into a space);
// a group's own line holds only its open and close tag, one child per line.
// ---------------------------------------------------------------------------

/** `.nt-canvas-viewport`'s inline `<svg>` layer behind a polygon/arc's box
 *  (§3.5) — fixed, not read off any stylesheet the compiled page has. */
function shapeLayerDecls(): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "position", "absolute");
  put(m, "inset", "0");
  put(m, "z-index", "-1");
  put(m, "overflow", "visible");
  put(m, "pointer-events", "none");
  return m;
}

function renderImage(ctx: Ctx, node: SceneNode, flow: Flow | undefined, pad: string): string {
  const src = (node as { src: string }).src;
  const decls = boxDecls(node, flow, { shadowCast: false });
  const id = idAttr(ctx, "data-nt-id", node.id);
  const style = ctx.f.styleAttr(ctx, decls);
  const attrs = `${ctx.f.attr("src", src)}${ctx.f.attr("alt", "")}${ctx.f.jsx ? " draggable={false}" : ' draggable="false"'}`;
  return ctx.f.jsx
    ? `${pad}<img${id}${attrs}${style} />`
    : `${pad}<img${id}${attrs}${style}>`;
}

/** rect, plain ellipse, text — nothing about the box is special. */
function renderLeafDiv(ctx: Ctx, node: SceneNode, flow: Flow | undefined, pad: string): string {
  const decls = boxDecls(node, flow, { shadowCast: castsShadowAsFilter(node) });
  const id = idAttr(ctx, "data-nt-id", node.id);
  const style = ctx.f.styleAttr(ctx, decls);
  return `${pad}<div${id}${style}>${renderLabel(ctx, node)}</div>`;
}

/** polygon, and an ellipse cut into an arc — a `<div>` holding an inline
 *  `<svg>` behind its content (§3.5). */
function renderPolygonArc(ctx: Ctx, node: SceneNode, flow: Flow | undefined, geo: ShapeGeometry, pad: string): string {
  const paint = paintOf(node.style);
  const cssOnly = paint.fill === null;
  const decls = boxDecls(node, flow, {
    drop: cssOnly ? dropStroke : dropPaint,
    isolation: true,
    clipPath: clipsToShape(node.style, cssOnly) ? geo.clip : null,
    shadowCast: true,
  });
  const w = node.w || 1;
  const h = node.h || 1;
  const fill = cssOnly ? "none" : (paint.fill as string);
  const pathAttrs =
    ctx.f.attr("d", geo.d) +
    ctx.f.attr("fill-rule", "evenodd", true) +
    (paint.attrs.stroke ? ctx.f.attr("stroke", paint.attrs.stroke) : "") +
    (paint.attrs.strokeWidth ? ctx.f.attr("stroke-width", paint.attrs.strokeWidth, true) : "") +
    (paint.attrs.strokeDasharray ? ctx.f.attr("stroke-dasharray", paint.attrs.strokeDasharray, true) : "") +
    ctx.f.attr("fill", fill) +
    ctx.f.attr("vector-effect", "non-scaling-stroke", true);
  const pathTag = ctx.f.jsx ? `<path${pathAttrs} />` : `<path${pathAttrs}/>`;
  const innerSvg =
    `<svg${ctx.f.styleAttr(ctx, shapeLayerDecls())}${ctx.f.attr("viewBox", `0 0 ${num(w)} ${num(h)}`)}` +
    `${ctx.f.attr("preserveAspectRatio", "none")}${ctx.f.attr("aria-hidden", "true")}>${pathTag}</svg>`;
  const id = idAttr(ctx, "data-nt-id", node.id);
  const style = ctx.f.styleAttr(ctx, decls);
  return `${pad}<div${id}${style}>${innerSvg}${renderLabel(ctx, node)}</div>`;
}

/** A path or a boolean group — the two kinds that ARE their own `<svg>`, not
 *  a box wearing one (§3.6, §3.7). `d`/`evenOdd` are the one thing that
 *  differs between them; everything else is one function. */
function renderSvgRoot(ctx: Ctx, node: SceneNode, flow: Flow | undefined, d: string, evenOdd: boolean, pad: string): string {
  const { decls: paintDecls, drop } = pathPaintDecls(node.style, d);
  const decls = boxDecls(node, flow, {
    drop,
    paintEntries: Object.entries(paintDecls),
    svgRoot: true,
    shadowCast: castsShadowAsFilter(node),
  });
  const id = idAttr(ctx, "data-nt-id", node.id);
  const style = ctx.f.styleAttr(ctx, decls);
  const viewBox = ctx.f.attr("viewBox", `0 0 ${num(node.w || 1)} ${num(node.h || 1)}`);
  const par = ctx.f.attr("preserveAspectRatio", "none");
  const pathAttrs =
    ctx.f.attr("d", d) +
    (evenOdd ? ctx.f.attr("fill-rule", "evenodd", true) : "") +
    ctx.f.attr("vector-effect", "non-scaling-stroke", true);
  const pathTag = ctx.f.jsx ? `<path${pathAttrs} />` : `<path${pathAttrs}/>`;
  return `${pad}<svg${id}${style}${viewBox}${par}>${pathTag}</svg>`;
}

function renderPath(ctx: Ctx, node: SceneNode, flow: Flow | undefined, pad: string): string {
  return renderSvgRoot(ctx, node, flow, (node as { d: string }).d, false, pad);
}

/** A boolean group draws one derived path and none of its children — the
 *  clipper's absence is a note, not a failure (`operandsPath` stands in). */
function renderBoolean(ctx: Ctx, node: GroupNode, flow: Flow | undefined, pad: string): string {
  const derived = derivedPath(node);
  const d = derived ?? operandsPath(node);
  if (derived === null) {
    ctx.notes.push({
      id: node.id,
      note: "boolean drawn as its operands' outlines (clipper not loaded); use compileSceneReady",
    });
  }
  if (paintsBox(node.style) && hasBoxShadow(node.style)) {
    ctx.notes.push({
      id: node.id,
      note: "rectangular box-shadow kept on a painted boolean group's <svg>, not cast as a drop-shadow",
    });
  }
  return renderSvgRoot(ctx, node, flow, d, true, pad);
}

/** A plain or auto-layout group — the one kind with real children. */
function renderGroup(ctx: Ctx, node: GroupNode, flow: Flow | undefined, pad: string, depth: number): string {
  const decls = boxDecls(node, flow, { shadowCast: castsShadowAsFilter(node) });
  const id = idAttr(ctx, "data-nt-id", node.id);
  const style = ctx.f.styleAttr(ctx, decls);
  const auto = isAutoLayout(node);
  const childFlow = auto ? flowFor(layoutOf(node)) : undefined;
  const childLines = node.children
    .filter((child) => !isOmitted(ctx, child))
    .map((child) => renderNode(ctx, child, childFlow, depth + 1))
    .filter((s): s is string => s !== null);
  if (childLines.length === 0) return `${pad}<div${id}${style}></div>`;
  return `${pad}<div${id}${style}>\n${childLines.join("\n")}\n${pad}</div>`;
}

/**
 * The one dispatcher every node — top-level or nested — goes through.
 *
 * `slot` is the flow the ENCLOSING group offers; a child pinned inside an
 * auto-layout group (Figma's "absolute position") takes it out of the flow
 * regardless — exactly `ShapeView`'s own `slot && isPinned(node) ? undefined
 * : slot`, computed once here rather than by every caller of `renderNode`.
 */
function renderNode(ctx: Ctx, node: SceneNode, slot: Flow | undefined, depth: number): string | null {
  if (isOmitted(ctx, node)) return null;
  const flow = slot && isPinned(node) ? undefined : slot;
  const pad = "  ".repeat(depth);
  if (node.kind === "image") return renderImage(ctx, node, flow, pad);
  if (node.kind === "path") return renderPath(ctx, node, flow, pad);
  if (isBoolean(node)) return renderBoolean(ctx, node, flow, pad);
  const geo = shapeGeometry(node);
  if (geo !== null) return renderPolygonArc(ctx, node, flow, geo, pad);
  if (isGroup(node)) return renderGroup(ctx, node, flow, pad, depth);
  return renderLeafDiv(ctx, node, flow, pad);
}

// ---------------------------------------------------------------------------
// Edges (§3.9) — one `<svg>` layer, then one `<div>` per label, before the
// shapes. DOM order mirrors `CanvasSurface`: edges are drawn under everything.
// ---------------------------------------------------------------------------

/** `--edge-line` resolved (globals.css) — the default an edge paints with
 *  when it names no `stroke` of its own. */
const EDGE_LINE_DEFAULT = "oklch(0.68 0.005 90)";

function edgeSvgDecls(): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "position", "absolute");
  put(m, "inset", "0");
  put(m, "overflow", "visible");
  put(m, "pointer-events", "none");
  return m;
}

function edgeLineDecls(edge: SceneEdge): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "fill", "none");
  put(m, "stroke", EDGE_LINE_DEFAULT);
  put(m, "stroke-width", "1.5");
  put(m, "stroke-linecap", "round");
  put(m, "stroke-linejoin", "round");
  for (const prop in edge.style) put(m, prop, edge.style[prop]);
  return m;
}

function edgeLabelDecls(x: number, y: number): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "position", "absolute");
  put(m, "left", px(x));
  put(m, "top", px(y));
  put(m, "transform", "translate(-50%, -50%)");
  put(m, "padding", "1px 5px");
  put(m, "border-radius", "4px");
  put(m, "background", "#fff");
  put(m, "font-size", "12px");
  put(m, "line-height", "1.35");
  put(m, "white-space", "pre-wrap");
  put(m, "color", "oklch(0.25 0.005 90)");
  put(m, "pointer-events", "none");
  return m;
}

/**
 * Every edge, routed on the LAID scene (§3.9) — a connector into a flex child
 * must land where the canvas draws it. Returns the whole `<svg>` layer as one
 * multi-line string (`null` when no edge draws at all) and each label `<div>`
 * as its own one-line string, both already indented at `pad`.
 */
function buildEdgeSvg(ctx: Ctx, laid: Scene, pad: string): { svg: string | null; labels: string[] } {
  const pad2 = `${pad}  `;
  const pad3 = `${pad}    `;
  const markers = new Map<string, number>();
  const markerLines: string[] = [];
  const pathLines: string[] = [];
  const labelLines: string[] = [];
  const obstacles = sceneObstacles(laid);

  for (const edge of laid.edges) {
    const fromNode = findNode(laid, edge.from);
    const toNode = findNode(laid, edge.to);
    const hiddenSkip = (!!fromNode && isOmitted(ctx, fromNode)) || (!!toNode && isOmitted(ctx, toNode));
    const points =
      fromNode && toNode && !hiddenSkip ? edgePoints(laid, edge, obstaclesFor(obstacles, edge)) : null;
    if (!points) {
      ctx.notes.push({
        id: edge.id,
        note: fromNode && toNode ? "edge skipped: from/to hidden" : "edge skipped: from/to not in scene",
      });
      continue;
    }

    const stroke = rv(ctx, edge.style.stroke?.trim() || EDGE_LINE_DEFAULT);
    let index = markers.get(stroke);
    if (index === undefined) {
      index = markers.size;
      markers.set(stroke, index);
      const markerId = `${ctx.prefix}-arrow-${index}`;
      const markerAttrs =
        ctx.f.attr("id", markerId) +
        ctx.f.attr("viewBox", ARROW_MARKER.viewBox) +
        ctx.f.attr("refX", ARROW_MARKER.refX, true) +
        ctx.f.attr("refY", ARROW_MARKER.refY, true) +
        ctx.f.attr("markerWidth", ARROW_MARKER.markerWidth, true) +
        ctx.f.attr("markerHeight", ARROW_MARKER.markerHeight, true) +
        ctx.f.attr("orient", "auto-start-reverse") +
        ctx.f.attr("markerUnits", "userSpaceOnUse", true);
      const arrowPathAttrs = `${ctx.f.attr("d", ARROW_MARKER.d)}${ctx.f.attr("fill", stroke)}`;
      const arrowPath = ctx.f.jsx ? `<path${arrowPathAttrs} />` : `<path${arrowPathAttrs}/>`;
      markerLines.push(`${pad3}<marker${markerAttrs}>${arrowPath}</marker>`);
    }

    const d = pointsToPath(points);
    const style = ctx.f.styleAttr(ctx, edgeLineDecls(edge));
    const id = idAttr(ctx, "data-nt-id", edge.id);
    const markerEnd = ctx.f.attr("marker-end", `url(#${ctx.prefix}-arrow-${index})`, true);
    const pathAttrs = `${id}${ctx.f.attr("d", d)}${style}${markerEnd}`;
    pathLines.push(`${pad2}<path${pathAttrs}${ctx.f.jsx ? " /" : "/"}>`);

    if (edge.label !== "") {
      const at = polylineMidpoint(points);
      const labelId = idAttr(ctx, "data-nt-edge-label", edge.id);
      const labelStyle = ctx.f.styleAttr(ctx, edgeLabelDecls(at.x, at.y));
      labelLines.push(`${pad}<div${labelId}${labelStyle}>${ctx.f.text(edge.label)}</div>`);
    }
  }

  if (pathLines.length === 0) return { svg: null, labels: labelLines };

  const svgAttrs = `${ctx.f.styleAttr(ctx, edgeSvgDecls())}${ctx.f.attr("aria-hidden", "true")}`;
  const svg =
    `${pad}<svg${svgAttrs}>\n` +
    `${pad2}<defs>\n${markerLines.join("\n")}\n${pad2}</defs>\n` +
    `${pathLines.join("\n")}\n` +
    `${pad}</svg>`;
  return { svg, labels: labelLines };
}

// ---------------------------------------------------------------------------
// The root (§3.12)
// ---------------------------------------------------------------------------

/** The root's box, and how far right the content moves to sit in it. */
type RootBox = { w: number; h: number; dx: number };

/**
 * A frame — a storyboard shot, an old root — states its own size. A band is
 * the page's: the column's width, or the wide width with the text's left edge
 * `WIDE_MARGIN` in from the root's, and as tall as it is drawn.
 */
function rootBox(scene: Scene): RootBox {
  if (scene.w > 0) return { w: scene.w, h: scene.h, dx: 0 };
  return { w: bandWidth(scene), h: bandHeight(scene), dx: -bandLeft(scene) };
}

function shiftX(scene: Scene, dx: number): Scene {
  return dx ? { ...scene, nodes: scene.nodes.map((node) => ({ ...node, x: node.x + dx })) } : scene;
}

function rootDecls(ctx: Ctx, scene: Scene, w: number, h: number): Map<string, string> {
  const m = new Map<string, string>();
  put(m, "position", "relative");
  put(m, "isolation", "isolate");
  for (const prop in scene.style) {
    if (ctx.resolveVarsOn && prop.startsWith("--")) continue;
    put(m, prop, scene.style[prop]);
  }
  put(m, "width", px(w));
  put(m, "height", px(h));
  if (ctx.clip) put(m, "overflow", "hidden");
  return m;
}

// ---------------------------------------------------------------------------
// Public API (§2.2)
// ---------------------------------------------------------------------------

/** Scene → markup. Pure and synchronous. */
export function compileScene(scene: Scene, opts: CompileOptions = {}): Compiled {
  return compileIn(scene, rootBox(scene), opts);
}

function compileIn(scene: Scene, { w, h, dx }: RootBox, opts: CompileOptions): Compiled {
  const laid = laidOutScene(shiftX(scene, dx));
  const notes: CompileNote[] = [];
  const ctx: Ctx = {
    f: flavourOf(opts.flavour),
    ids: opts.ids ?? true,
    clip: opts.clip ?? false,
    resolveVarsOn: opts.resolveVars ?? false,
    vars: opts.resolveVars ? customProperties(scene.style) : [],
    prefix: resolvePrefix(scene, opts.idPrefix),
    notes,
    flow: computeFlow(laid.nodes),
  };

  const pad = "  ";
  const { svg, labels } = buildEdgeSvg(ctx, laid, pad);
  const nodeLines = laid.nodes
    .filter((n) => !isOmitted(ctx, n))
    .map((n) => renderNode(ctx, n, undefined, 1))
    .filter((s): s is string => s !== null);

  const lines = [...(svg ? [svg] : []), ...labels, ...nodeLines];
  const rootId = ctx.ids && scene.id ? ctx.f.attr("data-nt-id", scene.id) : "";
  const style = ctx.f.styleAttr(ctx, rootDecls(ctx, scene, w, h));

  const code =
    lines.length === 0
      ? `<div${rootId}${style}></div>`
      : `<div${rootId}${style}>\n${lines.join("\n")}\n</div>`;

  return { code, notes };
}

/** `parseScene(html)` → {@link compileScene}. The input is canonical NML as
 *  stored — no adopt, no migrate. */
export function compileNml(html: string, opts?: CompileOptions & { parseHtml?: ParseHtml }): Compiled {
  const scene = parseScene(html, opts?.parseHtml);
  return compileScene(scene, opts);
}

/** The selected nodes that are live and not inside another selected node —
 *  `engine/shortcuts.ts`'s private `topSelection`, re-derived rather than
 *  imported from a `"use client"` module (§9 of the spec). */
function topSelectionOf(scene: Scene, ids: readonly NodeId[]): SceneNode[] {
  const wanted = new Set(ids);
  return selectedNodes(scene, ids).filter(
    (node) => !nodePath(scene, node.id).slice(0, -1).some((ancestor) => wanted.has(ancestor.id)),
  );
}

/**
 * The selection as a self-contained fragment — copy-as-HTML. Each outermost
 * selected node is flattened to scene space (`absoluteRect`/`absoluteRotation`
 * on the laid scene), the root is sized to their union and translated so that
 * box's top-left is 0,0; an edge with BOTH ends inside the copy comes along;
 * the root style carries only the diagram's own `--*` declarations.
 */
export function compileSelection(scene: Scene, ids: readonly NodeId[], opts?: CompileOptions): Compiled | null {
  const laid = laidOutScene(scene);
  const top = topSelectionOf(laid, ids);
  if (top.length === 0) return null;

  const flattened = top.map((node) => {
    const box = absoluteRect(laid, node.id);
    return { ...node, x: box.x, y: box.y, rot: absoluteRotation(laid, node.id) };
  });
  const bounds = absoluteSelectionBounds(laid, top.map((node) => node.id));
  const translated = flattened.map((node) => ({ ...node, x: node.x - bounds.x, y: node.y - bounds.y }));

  const carried = new Set<NodeId>();
  walk(translated, (node) => void carried.add(node.id));
  const edges = laid.edges.filter((edge) => carried.has(edge.from) && carried.has(edge.to));

  const rootStyle: StyleMap = {};
  for (const v of customProperties(scene.style)) rootStyle[v.name] = v.value;

  const fragment: Scene = { w: bounds.w, h: bounds.h, style: rootStyle, nodes: translated, edges, attrs: {} };
  return compileIn(fragment, { w: bounds.w, h: bounds.h, dx: 0 }, opts ?? {});
}

function hasBooleanIn(nodes: readonly SceneNode[]): boolean {
  let found = false;
  walk(nodes, (node) => {
    if (isBoolean(node)) found = true;
  });
  return found;
}

/** `await loadClipper()` when the scene holds a boolean group, then
 *  {@link compileScene}. */
export async function compileSceneReady(scene: Scene, opts?: CompileOptions): Promise<Compiled> {
  if (hasBooleanIn(scene.nodes)) await loadClipper();
  return compileScene(scene, opts);
}

/** `await loadClipper()` when the SELECTION holds a boolean group, then
 *  {@link compileSelection} — the gate `compileToHtml`'s `ids` branch needs
 *  for a boolean shape to compile with its true outline. */
async function compileSelectionReady(
  scene: Scene,
  ids: readonly NodeId[],
  opts?: CompileOptions,
): Promise<Compiled | null> {
  const laid = laidOutScene(scene);
  const top = topSelectionOf(laid, ids);
  if (hasBooleanIn(top)) await loadClipper();
  return compileSelection(scene, ids, opts);
}

/**
 * The adapter `get_html` (the TOOLS slice) calls: `ids`, when given, compiles
 * only those subtrees in a wrapper sized to their union — {@link
 * compileSelection} under the hood, not a filtered {@link compileScene}, so
 * an id inside a group with an unselected sibling still comes out flattened
 * to scene space the way copy-as-HTML does. Async: a diagram may hold a
 * boolean group, which needs `await loadClipper()` before its true outline
 * exists.
 */
export async function compileToHtml(
  scene: Scene,
  opts?: { jsx?: boolean; ids?: readonly NodeId[] },
): Promise<{ code: string; warnings: string[] }> {
  const flavour: Flavour = opts?.jsx ? "jsx" : "html";
  const result = opts?.ids
    ? ((await compileSelectionReady(scene, opts.ids, { flavour })) ?? { code: "", notes: [] })
    : await compileSceneReady(scene, { flavour });
  return { code: result.code, warnings: result.notes.map((n) => n.note) };
}
