import { safeHref } from "@/app/lib/ai/html/parse";
import { iconFor } from "../icons/registry";
import { labelOfElement } from "./label";
import { scalePath } from "./path";
import {
  FULL_ARC,
  isEdgeAttr,
  isEdgeTag,
  isReservedAttr,
  kindForTag,
  type Scene,
  type SceneEdge,
  type SceneNode,
  type SceneNodeBase,
  type SceneNodeKind,
  type StyleMap,
} from "./types";

/**
 * Canvas HTML → {@link Scene}.
 *
 * Strict in what {@link serializeScene} writes, liberal in what this reads: the
 * grammar is authored by hand and by a model, so a `<rectangle>` where the
 * canonical tag is `<nt-rect>`, a `style` broken across lines, `x="40px"`, or a
 * wrapper `<div>` around the shapes are all naming preferences rather than
 * errors. Everything that is *not* understood — attributes outside
 * `RESERVED_ATTRS`, CSS properties nothing reads — is carried through verbatim
 * instead of dropped, which is what makes the round trip lossless.
 *
 * Normalisation happens here, not in the serializer: parsing lands on exactly
 * the values the serializer would have written, so
 * `serializeScene(parseScene(html)) === html` for canonical html.
 */

/** Browsers give us DOMParser; the round-trip harness injects one. */
export type ParseHtml = (html: string) => Document;

const defaultParseHtml: ParseHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html");

/** Tags accepted as the surface element. `nt-diagram` is the one we write. */
const ROOT_TAGS = new Set([
  "nt-diagram",
  "nt-canvas",
  "nt-scene",
  "diagram",
  "canvas",
  "scene",
  "flowchart",
]);

/** Non-canonical tags a model plausibly reaches for, and the kind they mean. */
const KIND_ALIASES: Record<string, SceneNodeKind> = {
  rect: "rect",
  rectangle: "rect",
  "nt-rectangle": "rect",
  box: "rect",
  "nt-box": "rect",
  ellipse: "ellipse",
  circle: "ellipse",
  "nt-circle": "ellipse",
  oval: "ellipse",
  polygon: "polygon",
  ngon: "polygon",
  "nt-ngon": "polygon",
  text: "text",
  "nt-label": "text",
  image: "image",
  img: "image",
  "nt-img": "image",
  path: "path",
  group: "group",
  "nt-frame": "group",
  frame: "group",
};

function kindOf(tag: string): SceneNodeKind | null {
  const t = tag.toLowerCase();
  return kindForTag(t) ?? KIND_ALIASES[t] ?? null;
}

/** Spellings of the geometry attributes that are read but never written back. */
const GEOMETRY_ALIASES: Record<string, string> = {
  width: "w",
  height: "h",
  left: "x",
  top: "y",
  rotation: "rot",
};

/**
 * A number attribute, with the unit a model might have written stripped —
 * `x="40px"` and `rot="15deg"` mean what they say. Anything unreadable falls
 * back rather than poisoning the geometry with NaN.
 */
function num(el: Element, names: string[], fallback = 0): number {
  for (const name of names) {
    const raw = el.getAttribute(name);
    if (raw === null) continue;
    const n = Number.parseFloat(raw.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * A number attribute that is meaningful by its **presence**, not its value —
 * an ellipse's arc. Absent stays absent, so a plain ellipse parses to a node
 * with no arc fields and serializes back to the div it was. Present but
 * unreadable falls back to the default rather than vanishing, so the attribute
 * the author wrote is still there afterwards.
 */
function optNum(el: Element, name: string, fallback: number): number | undefined {
  const raw = el.getAttribute(name);
  if (raw === null) return undefined;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Only the fields the element actually carries, so absence survives the trip. */
function arcAttrs(el: Element): {
  start?: number;
  sweep?: number;
  inner?: number;
} {
  const start = optNum(el, "start", FULL_ARC.start);
  const sweep = optNum(el, "sweep", FULL_ARC.sweep);
  const inner = optNum(el, "inner", FULL_ARC.inner);
  return {
    ...(start === undefined ? {} : { start }),
    ...(sweep === undefined ? {} : { sweep: clamp(sweep, -360, 360) }),
    ...(inner === undefined ? {} : { inner: clamp(inner, 0, 1) }),
  };
}

/** `locked`, `locked=""` and `locked="true"` are all true; `"false"`/`"0"` are not. */
function bool(el: Element, name: string): boolean {
  const raw = el.getAttribute(name);
  if (raw === null) return false;
  const v = raw.trim().toLowerCase();
  return v !== "false" && v !== "0" && v !== "no";
}

/**
 * Everything the model does not name, kept verbatim. A geometry alias is not
 * one of those: `width` has already been read as `w`, and keeping it too would
 * serialize the same number twice, in two attributes, free to disagree.
 */
function attrsOf(el: Element, kind?: SceneNodeKind): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, value } of Array.from(el.attributes)) {
    const attr = name.toLowerCase();
    if (isReservedAttr(attr, kind) || attr in GEOMETRY_ALIASES) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Splits on a top-level separator, ignoring one inside quotes or parentheses.
 *
 * `;` is not always a declaration boundary: `background: url(data:image/png;base64,…)`
 * carries two of them inside one value, and a naive split turns a working image
 * into two broken declarations.
 */
function splitTop(css: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === sep && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/**
 * Whitespace runs → one space, outside quotes only. A `style` attribute written
 * across several indented lines and the same declaration written on one are the
 * same CSS, so they must parse to the same string — but `content: "a  b"` is
 * not, so quoted text is left alone.
 */
function collapseSpace(value: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < value.length) out += value[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) {
      if (out && !out.endsWith(" ")) out += " ";
      continue;
    }
    out += c;
  }
  return out.trim();
}

/**
 * A `style` attribute → declaration map. Property names are lowercased (custom
 * properties are case-sensitive, so `--Brand` keeps its case); values are kept
 * as authored, whitespace aside — including `!important`, functions and any
 * property this app has never heard of.
 */
export function parseStyleAttr(css: string): StyleMap {
  const out: StyleMap = {};
  for (const decl of splitTop(css, ";")) {
    const colon = decl.indexOf(":");
    if (colon <= 0) continue;
    const prop = decl.slice(0, colon).trim();
    const value = collapseSpace(decl.slice(colon + 1));
    if (!prop || !value) continue;
    out[prop.startsWith("--") ? prop : prop.toLowerCase()] = value;
  }
  return out;
}

/**
 * Ids are minted for nodes that arrive without one, or that repeat an id
 * already taken. Every operation addresses nodes by id, so a document written
 * without them — which a model will do — would otherwise parse into a scene
 * where selecting one shape selects several. Authored ids are never rewritten,
 * so canonical html still round-trips byte for byte.
 */
type Mint = { taken: Set<string>; used: Set<string>; n: number };

function collectIds(el: Element, taken: Set<string>): void {
  for (const child of Array.from(el.children)) {
    const id = child.getAttribute("id")?.trim();
    if (id) taken.add(id);
    collectIds(child, taken);
  }
}

function idFor(el: Element, mint: Mint, prefix = "n"): string {
  const id = el.getAttribute("id")?.trim() ?? "";
  if (id && !mint.used.has(id)) {
    mint.used.add(id);
    return id;
  }
  let fresh = `${prefix}${++mint.n}`;
  while (mint.taken.has(fresh) || mint.used.has(fresh)) {
    fresh = `${prefix}${++mint.n}`;
  }
  mint.used.add(fresh);
  return fresh;
}

/**
 * The label is trimmed but not otherwise collapsed. The serializer writes it
 * inline with no surrounding whitespace, so trimming absorbs the indentation of
 * hand-written html while a deliberate line break inside a two-line label
 * survives the round trip.
 *
 * Edges only. A shape's label goes through {@link labelOfElement}, which keeps
 * `<nt-ref>` page references as elements.
 */
function labelOf(el: Element): string {
  return (el.textContent ?? "").trim();
}

/** An inline image, which is what a paste produces and `safeHref` refuses. */
const DATA_IMAGE = /^data:image\/[a-z0-9.+-]+[,;]/i;

/**
 * Every src the grammar can carry passes through here, and a url refused at
 * this line cannot reach the DOM. Not theoretical: canvas html arrives from
 * whatever the model read.
 *
 * `safeHref` guards destinations someone can navigate to, so it allows only
 * http(s)/mailto/tel — correct for a link and wrong for a picture, because a
 * pasted image is a `data:` uri and dropping it would blank the shape. An image
 * data uri is not a navigation, so it is admitted here and nowhere else.
 */
function imageSrc(raw: string | null): string {
  const src = (raw ?? "").trim();
  if (DATA_IMAGE.test(src)) return src;
  return safeHref(src) ?? "";
}

function baseOf(el: Element, kind: SceneNodeKind, mint: Mint): SceneNodeBase {
  const name = el.getAttribute("name");
  return {
    id: idFor(el, mint),
    x: num(el, ["x", "left"]),
    y: num(el, ["y", "top"]),
    w: num(el, ["w", "width"]),
    h: num(el, ["h", "height"]),
    rot: num(el, ["rot", "rotation"]),
    style: parseStyleAttr(el.getAttribute("style") ?? ""),
    label: "",
    ...(name === null ? {} : { name }),
    locked: bool(el, "locked"),
    hidden: bool(el, "hidden"),
    attrs: attrsOf(el, kind),
  };
}

function elementToNode(
  el: Element,
  kind: SceneNodeKind,
  mint: Mint,
): SceneNode {
  const base = baseOf(el, kind, mint);
  switch (kind) {
    case "rect":
      return { ...base, kind: "rect", label: labelOfElement(el) };
    case "ellipse":
      return { ...base, kind: "ellipse", label: labelOfElement(el), ...arcAttrs(el) };
    case "polygon":
      return {
        ...base,
        kind: "polygon",
        label: labelOfElement(el),
        // Capped as well as floored: past a hundred sides it is a circle drawn
        // the expensive way, and nothing downstream should have to guard it.
        sides: clamp(Math.round(num(el, ["sides"], 3)), 3, 100),
      };
    case "text":
      return { ...base, kind: "text", label: labelOfElement(el) };
    case "image":
      return { ...base, kind: "image", src: imageSrc(el.getAttribute("src")) };
    case "path":
      return { ...base, kind: "path", d: (el.getAttribute("d") ?? "").trim() };
    case "group":
      return { ...base, kind: "group", children: childNodes(el, mint) };
  }
}

/** Tags accepted as an icon placement, canonical first. */
const ICON_TAGS = new Set(["nt-icon", "icon", "nt-glyph"]);

/**
 * `<nt-icon name="cat">` — a curated glyph, resolved into an ORDINARY path.
 *
 * The element is model dialect, never document content: what lands is the
 * icon's real geometry scaled into the box, painted by the authored style over
 * the mode's defaults — as selectable, recolorable and pen-editable as
 * anything drawn by hand, because it is the same kind of thing. The name rides
 * along twice, both free under existing contracts: as the node's layers-panel
 * `name`, and as a `data-icon` attribute the round trip carries verbatim.
 *
 * A name the catalog does not hold (or a catalog not yet loaded — the AI
 * lanes await it before parsing, so only a human pasting dialect can get here
 * early) becomes a visible crossed-box placeholder rather than a silent drop:
 * a wrong guess should look wrong, not vanish.
 */
function iconToNode(el: Element, mint: Mint): SceneNode {
  const base = baseOf(el, "path", mint);
  const name = (el.getAttribute("name") ?? "").trim().toLowerCase();
  const icon = iconFor(name);

  // The grammar requires w/h, but a model that omitted them should get a
  // legible icon rather than a zero box the adopt pass cannot rescue.
  let { w, h } = base;
  if (w <= 0 && h <= 0) {
    w = 48;
    h = icon ? (48 * icon.h) / icon.w : 48;
  } else if (w <= 0) {
    w = icon ? (h * icon.w) / icon.h : h;
  } else if (h <= 0) {
    h = icon ? (w * icon.h) / icon.w : w;
  }

  const d = icon
    ? scalePath(icon.d, w / icon.w, h / icon.h)
    : `M 0 0 H ${w} V ${h} H 0 Z M 0 0 L ${w} ${h} M ${w} 0 L 0 ${h}`;

  // Defaults under the authored declarations, mode-appropriate: a silhouette
  // paints its fill, a line icon its stroke. Anything the model wrote wins.
  const style: StyleMap = { ...base.style };
  const painted = "fill" in style || "background" in style || "stroke" in style;
  if (!painted) {
    if (!icon || icon.mode === "stroke") {
      style.fill = "none";
      style.stroke = "#2b2b28";
      style["stroke-width"] = "2";
    } else {
      style.fill = "#2b2b28";
    }
  }

  return {
    ...base,
    kind: "path",
    w,
    h,
    d,
    style,
    // Its own display name, so the layers panel reads "cat", not "Shape".
    ...(base.name === undefined && name ? { name } : {}),
    attrs: { ...base.attrs, ...(name ? { "data-icon": name } : {}) },
  };
}

/**
 * Element children as nodes, descending through anything that is not a shape.
 * A model that wraps its shapes in a `<div>` or a stray `<svg>` still meant the
 * shapes, and the wrapper carries nothing this model can hold.
 */
function childNodes(parent: Element, mint: Mint): SceneNode[] {
  const out: SceneNode[] = [];
  for (const el of Array.from(parent.children)) {
    if (isEdgeTag(el.tagName)) continue;
    if (ICON_TAGS.has(el.tagName.toLowerCase())) {
      out.push(iconToNode(el, mint));
      continue;
    }
    const kind = kindOf(el.tagName);
    if (kind) out.push(elementToNode(el, kind, mint));
    else out.push(...childNodes(el, mint));
  }
  return out;
}

/**
 * Connectors, from anywhere in the document.
 *
 * The serializer writes them at the root, but a hand-written or model-written
 * diagram may well tuck one inside the group whose shapes it joins — an edge
 * belongs to neither end, so there is no wrong place to have put it. They are
 * hoisted to the scene's flat list either way.
 */
function collectEdges(parent: Element, mint: Mint, out: SceneEdge[]): SceneEdge[] {
  for (const el of Array.from(parent.children)) {
    if (isEdgeTag(el.tagName)) out.push(elementToEdge(el, mint));
    else collectEdges(el, mint, out);
  }
  return out;
}

function elementToEdge(el: Element, mint: Mint): SceneEdge {
  const attrs: Record<string, string> = {};
  for (const { name, value } of Array.from(el.attributes)) {
    if (!isEdgeAttr(name)) attrs[name] = value;
  }
  return {
    id: idFor(el, mint, "e"),
    // Kept verbatim even when they name nothing: dropping a connector whose
    // end has gone would lose it from a file the author can still fix. The
    // renderer skips what it cannot resolve.
    from: (el.getAttribute("from") ?? "").trim(),
    to: (el.getAttribute("to") ?? "").trim(),
    label: labelOf(el),
    style: parseStyleAttr(el.getAttribute("style") ?? ""),
    attrs,
  };
}

function findRoot(el: Element): Element | null {
  for (const child of Array.from(el.children)) {
    if (ROOT_TAGS.has(child.tagName.toLowerCase())) return child;
    const nested = findRoot(child);
    if (nested) return nested;
  }
  return null;
}

/**
 * Parses a canvas document. A fragment of bare shapes with no surface element
 * around it is accepted too — that is what a paste and a model's partial edit
 * look like — and yields a scene sized 0×0 for the caller to place.
 */
export function parseScene(
  html: string,
  parseHtml: ParseHtml = defaultParseHtml,
): Scene {
  // Wrap explicitly: given a bare fragment, DOM implementations disagree about
  // whether content lands in <body> or at the document root.
  const doc = parseHtml(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = findRoot(doc.body) ?? doc.body;
  const taken = new Set<string>();
  collectIds(root, taken);
  const mint: Mint = { taken, used: new Set(), n: 0 };
  const id = root.getAttribute("id")?.trim();
  return {
    w: num(root, ["w", "width"]),
    h: num(root, ["h", "height"]),
    style: parseStyleAttr(root.getAttribute("style") ?? ""),
    nodes: childNodes(root, mint),
    edges: collectEdges(root, mint, []),
    ...(id ? { id } : {}),
    attrs: root === doc.body ? {} : attrsOf(root),
  };
}
