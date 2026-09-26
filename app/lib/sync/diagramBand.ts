import * as Y from "yjs";
import {
  applySceneDiff,
  CANVAS_MIRROR_KEY,
  canvasMapName,
  hasCanvasState,
  materializeCanvas,
  mirrorStamp,
} from "@/app/components/editor/canvas/collab/ymap";
import { isLegacyRoot, normalizeDiagram } from "@/app/components/editor/canvas/scene/band";
import { detectCanvasFormat, migrateLegacyCanvas, readCanvasSource } from "@/app/components/editor/canvas/scene/migrate";
import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import {
  NML_YJS_ROOT,
  NML_YJS_STRUCTURE_KEY,
  nmlCanvasAttrs,
  nmlCanvasFromY,
  nmlCanvasToY,
  nmlYMapOf,
} from "@/app/lib/nml/yjs";

/**
 * Every diagram a page's Y.Doc stores, rewritten as a band — the one-time
 * migration's per-document step, shared by the Node runner (`convex/
 * diagramBand.ts`) and by the browser's legacy conversion (`sync/migrate.ts`),
 * so a document converted after the deploy is born in the form the runner
 * would have written.
 *
 * A diagram is stored up to three times, and each copy is normalized from
 * itself — nothing is carried from one copy into another, so the copies agree
 * afterwards exactly where they agreed before:
 *
 *  - its CRDT maps (`canvas:<blockId>`), the truth, when an editor has ever
 *    mounted it. Rewritten through `applySceneDiff` against what they
 *    materialize to, which touches only the keys that move and leaves a
 *    hoisted parent pointer or a dangling edge where it is;
 *  - its block prop, the maps' mirror — rewritten from the maps and stamped,
 *    so an open tab takes it for a collaborator's mirror rather than an
 *    outside author; or, with no maps, from itself, and no maps are made;
 *  - the canonical NML root's copy, when the page has one.
 *
 * The maps' `edit` token is never written: nobody did anything, and a peer
 * that sees the diagram move under an unmoved token keeps its undo history.
 * Storyboards are not diagrams and are never visited.
 *
 * Nothing here but the doc and the parser it is handed, so the same code runs
 * under Node and in the browser. The whole rewrite is one transaction: a
 * caller listening for the doc's `update` hears at most one — and none when
 * nothing needed changing.
 */

const PM_FRAGMENT = "prosemirror";

/** Markup a diagram block could have written — anything else it holds is left be. */
const DIAGRAM_ROOT = /^\s*<nt-diagram[\s/>]/i;

const ORIGIN = "diagram-band";

/** How many before/after root tags a report keeps, for checking by eye. */
const SAMPLES = 3;

export type DiagramBandReport = {
  /** Diagram blocks on the page. */
  diagrams: number;
  /** Diagrams whose maps were rewritten. */
  maps: number;
  /** Diagrams whose block prop was rewritten. */
  props: number;
  /** NML copies rewritten. */
  nml: number;
  /** Diagrams that came out wide. */
  wide: number;
  samples: { blockId: string; before: string; after: string }[];
};

export function normalizeDiagramsInDoc(doc: Y.Doc, parseHtml: ParseHtml): DiagramBandReport {
  const report: DiagramBandReport = { diagrams: 0, maps: 0, props: 0, nml: 0, wide: 0, samples: [] };
  // Decoded before anything is written: an NML copy that will not decode
  // throws here, with the doc as it was.
  const copies = nmlRewrites(doc);
  doc.transact(() => {
    for (const block of canvasBlocks(doc)) rewriteBlock(doc, block, parseHtml, report);
    for (const copy of copies) writeNmlScene(copy);
    report.nml = copies.length;
  }, ORIGIN);
  return report;
}

function canvasBlocks(doc: Y.Doc): Y.XmlElement[] {
  if (!doc.share.has(PM_FRAGMENT)) return [];
  const walker = doc
    .getXmlFragment(PM_FRAGMENT)
    .createTreeWalker((node) => node instanceof Y.XmlElement && node.nodeName === "canvas");
  return [...walker] as Y.XmlElement[];
}

/** BlockNote keeps a block's id on the container its content node sits in. */
function blockIdOf(block: Y.XmlElement): string | null {
  const container = block.parent;
  const id = container instanceof Y.XmlElement ? container.getAttribute("id") : undefined;
  return typeof id === "string" && id ? id : null;
}

function rewriteBlock(doc: Y.Doc, block: Y.XmlElement, parseHtml: ParseHtml, report: DiagramBandReport) {
  report.diagrams += 1;
  const data = block.getAttribute("data");
  const prop = typeof data === "string" ? data : "";
  const blockId = blockIdOf(block);
  const name = blockId === null ? null : canvasMapName(blockId);
  // Looked up rather than got: `getMap` would invent an empty root for a
  // diagram no editor has mounted.
  const root = name !== null && doc.share.has(name) ? doc.getMap<unknown>(name) : null;
  const mapped = root !== null && hasCanvasState(root);

  let was: Scene;
  let next: Scene;
  let html: string;
  if (mapped) {
    was = materializeCanvas(root);
    next = normalizeDiagram(was);
    if (next !== was) {
      applySceneDiff(root, was, next);
      report.maps += 1;
    }
    html = serializeScene(next === was ? was : materializeCanvas(root));
  } else {
    // Blank, or nothing any reader can make out as a diagram: there is no band
    // to write, and replacing the string would only lose it.
    const format = detectCanvasFormat(prop);
    if (format === "empty" || (format === "html" && !DIAGRAM_ROOT.test(prop))) return;
    was = readCanvasSource(prop, parseHtml);
    next = normalizeDiagram(was);
    // A band already: re-serializing it would only restyle it.
    if (next === was && !isLegacyRoot(was)) return;
    html = serializeScene(next);
  }
  if (next.wide && !was.wide) report.wide += 1;
  if (html === prop) return;
  // Maps that were already a band, under a prop that is one too, are only
  // ahead of their mirror: the client that edited them flushes it. Rewriting
  // it here would be a change nobody needed, on every pass while anyone edits.
  if (mapped && next === was && serializeScene(migrateLegacyCanvas(prop, parseHtml)) === prop) return;

  block.setAttribute("data", html);
  if (mapped) root.set(CANVAS_MIRROR_KEY, mirrorStamp(html));
  report.props += 1;
  if (report.samples.length < SAMPLES) {
    report.samples.push({ blockId: blockId ?? "", before: rootTag(prop), after: rootTag(html) });
  }
}

/** A stored source's root tag — the part the migration changes. */
function rootTag(source: string): string {
  return /^\s*(<[^>]*>)/.exec(source)?.[1] ?? source.slice(0, 80);
}

type NmlRewrite = { block: Y.Map<unknown>; was: Scene; next: Scene };

/**
 * The NML copies that are not bands yet. Found the way the decoder finds
 * blocks — the legacy array and the structure's registry, recursively, a
 * later copy of an id standing in for an earlier one, deleted ids skipped —
 * so exactly the copies a reader would decode are the ones rewritten.
 */
function nmlRewrites(doc: Y.Doc): NmlRewrite[] {
  if (!doc.share.has(NML_YJS_ROOT)) return [];
  const root = doc.getMap<unknown>(NML_YJS_ROOT);
  if (root.size === 0) return [];
  const structure = root.get(NML_YJS_STRUCTURE_KEY);
  const registry = structure instanceof Y.Map ? structure.get("registry") : null;
  const deletions = structure instanceof Y.Map ? structure.get("deletions") : null;

  const blocks = new Map<string, Y.Map<unknown>>();
  const collect = (value: unknown) => {
    if (!(value instanceof Y.Map)) return;
    const id = value.get("id");
    if (typeof id === "string") blocks.set(id, value);
    const children = value.get("children");
    if (children instanceof Y.Array) children.forEach(collect);
  };
  const legacy = root.get("blocks");
  if (legacy instanceof Y.Array) legacy.forEach(collect);
  if (registry instanceof Y.Map) registry.forEach(collect);

  const out: NmlRewrite[] = [];
  for (const [id, block] of blocks) {
    if (block.get("type") !== "canvas") continue;
    if (deletions instanceof Y.Map && deletions.get(id) === true) continue;
    const was = nmlCanvasFromY(block.get("scene"), [NML_YJS_ROOT, id, "scene"]);
    const next = normalizeDiagram(was);
    if (next !== was) out.push({ block, was, next });
  }
  return out;
}

const ROOT_FIELDS = ["w", "h", "style", "attrs"] as const;

/**
 * Root fields only when that is all that moved — the common case, and the
 * shape of NML's own `updateCanvas`. A diagram whose content had to be moved
 * or scaled into its band is replaced whole.
 */
function writeNmlScene({ block, was, next }: NmlRewrite) {
  if (next.nodes !== was.nodes || next.edges !== was.edges) {
    block.set("scene", nmlCanvasToY(next));
    return;
  }
  const scene = block.get("scene") as Y.Map<unknown>;
  const fields = (s: Scene) => ({ w: s.w, h: s.h, style: s.style, attrs: nmlCanvasAttrs(s) });
  const before = fields(was);
  const after = fields(next);
  for (const key of ROOT_FIELDS) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    const value = after[key];
    scene.set(key, typeof value === "number" ? value : nmlYMapOf(value));
  }
}
