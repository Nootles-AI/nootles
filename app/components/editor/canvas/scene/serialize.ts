import {
  EDGE_TAG,
  LAYOUT_STYLE_PROPS,
  SCENE_TAG,
  TAG_BY_KIND,
  hasText,
  isEdgeAttr,
  isReservedAttr,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneNodeKind,
  type StyleMap,
} from "./types";

/**
 * {@link Scene} → canvas HTML, in exactly one form.
 *
 * The canonical form is what the parser normalises to, which is what makes
 * `serializeScene(parseScene(html)) === html` a fact rather than a hope:
 *
 *  - canonical tags only, one node per line, two-space indent per level;
 *  - a fixed attribute order — `id`, `x`, `y`, `w`, `h`, `rot`, `name`,
 *    `locked`, `hidden`, then the kind's own (`sides`, the ellipse's
 *    `start`/`sweep`/`inner`, `src`, `d`), then anything carried in `attrs`,
 *    and `style` last, where the eye expects the long value;
 *  - defaults are silence: `rot="0"`, `locked="false"`, `hidden="false"`, an
 *    empty `style` and an absent `name` are all written by omission;
 *  - declarations keep the order they were authored in. Sorting them would be
 *    just as stable and would rewrite every hand-written diagram the first time
 *    it was touched.
 *
 * The one thing that is not written back is a child's `x`/`y` inside an
 * auto-layout group: the layout engine computes those, so authoring them would
 * put a second, stale source of truth in the file.
 */

const INDENT = "  ";

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function escAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

function escText(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

function attr(name: string, value: string): string {
  return ` ${name}="${escAttr(value)}"`;
}

/** Non-finite geometry is a bug upstream; it must not become `NaN` in a file. */
function numAttr(name: string, n: number): string {
  return attr(name, Number.isFinite(n) ? String(n) : "0");
}

/**
 * Declarations as one line. Empty values are dropped rather than written as
 * `prop: ;` — clearing a control is how a property is removed.
 */
export function serializeStyleAttr(decls: StyleMap): string {
  return Object.entries(decls)
    .filter(([prop, value]) => prop && value)
    .map(([prop, value]) => `${prop}: ${value}`)
    .join("; ");
}

function styleAttr(decls: StyleMap): string {
  const css = serializeStyleAttr(decls);
  return css ? attr("style", css) : "";
}

/** Carried attributes, minus anything the model already owns a column for. */
function extraAttrs(
  attrs: Record<string, string>,
  kind?: SceneNodeKind,
): string {
  return Object.entries(attrs)
    .filter(([name]) => !isReservedAttr(name, kind))
    .map(([name, value]) => attr(name, value))
    .join("");
}

function isAutoLayout(style: StyleMap): boolean {
  const display = style[LAYOUT_STYLE_PROPS.mode] ?? "";
  return display.includes("flex") || display.includes("grid");
}

/** `computed` marks a child whose position its parent's layout owns. */
function nodeHtml(node: SceneNode, depth: number, computed: boolean): string {
  const pad = INDENT.repeat(depth);
  const tag = TAG_BY_KIND[node.kind];

  let head = attr("id", node.id);
  if (!computed) head += numAttr("x", node.x) + numAttr("y", node.y);
  head += numAttr("w", node.w) + numAttr("h", node.h);
  if (node.rot !== 0) head += numAttr("rot", node.rot);
  if (node.name !== undefined) head += attr("name", node.name);
  if (node.locked) head += attr("locked", "true");
  if (node.hidden) head += attr("hidden", "true");
  // Always written, default or not: a polygon with no side count is a shape
  // whose form you have to know the parser to read.
  if (node.kind === "polygon") head += numAttr("sides", node.sides);
  // Written only when set. Absence is what makes a plain ellipse a plain
  // ellipse, so a full circle must not acquire `start="0" sweep="360"`.
  if (node.kind === "ellipse") {
    if (node.start !== undefined) head += numAttr("start", node.start);
    if (node.sweep !== undefined) head += numAttr("sweep", node.sweep);
    if (node.inner !== undefined) head += numAttr("inner", node.inner);
  }
  if (node.kind === "image" && node.src) head += attr("src", node.src);
  // Path data is written raw. Its grammar is digits, letters and separators —
  // nothing an attribute has to escape — and escaping it would leave `&amp;`
  // sitting in a `d` that a renderer hands straight to the SVG parser.
  if (node.kind === "path" && node.d) head += ` d="${node.d}"`;
  head += extraAttrs(node.attrs, node.kind) + styleAttr(node.style);

  const open = `${pad}<${tag}${head}>`;
  if (node.kind === "group") {
    if (node.children.length === 0) return `${open}</${tag}>`;
    const auto = isAutoLayout(node.style);
    const inner = node.children
      .map((child) => nodeHtml(child, depth + 1, auto))
      .join("\n");
    return `${open}\n${inner}\n${pad}</${tag}>`;
  }
  // The label is already canonical inline markup — escaped text with any
  // `<nt-ref>` elements intact (see scene/label.ts) — so it is written raw;
  // escaping it again would turn every `&amp;` into `&amp;amp;`.
  return `${open}${hasText(node) ? node.label : ""}</${tag}>`;
}

/**
 * A connector, always at the root and always after the shapes — it names two
 * of them, so it reads as a statement about a document you have already seen.
 * No geometry: where the line runs is worked out from the two boxes.
 */
function edgeHtml(edge: SceneEdge, depth: number): string {
  const head =
    attr("id", edge.id) +
    attr("from", edge.from) +
    attr("to", edge.to) +
    Object.entries(edge.attrs)
      .filter(([name]) => !isEdgeAttr(name))
      .map(([name, value]) => attr(name, value))
      .join("") +
    styleAttr(edge.style);
  return `${INDENT.repeat(depth)}<${EDGE_TAG}${head}>${escText(edge.label)}</${EDGE_TAG}>`;
}

export function serializeScene(scene: Scene): string {
  const head =
    (scene.id ? attr("id", scene.id) : "") +
    numAttr("w", scene.w) +
    numAttr("h", scene.h) +
    extraAttrs(scene.attrs) +
    styleAttr(scene.style);

  const open = `<${SCENE_TAG}${head}>`;
  const lines = [
    ...scene.nodes.map((node) => nodeHtml(node, 1, false)),
    ...scene.edges.map((edge) => edgeHtml(edge, 1)),
  ];
  if (lines.length === 0) return `${open}</${SCENE_TAG}>`;
  return `${open}\n${lines.join("\n")}\n</${SCENE_TAG}>`;
}
