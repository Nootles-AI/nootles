/**
 * The Node half of nml-diagram.fullstack.mjs that needs app code: reading a
 * served page's stored history three ways — the canonical NML scene, the
 * per-shape maps the canvas draws on, and the block's `data` prop — and
 * writing the diagram an agent would send. Bundled by esbuild for Node.
 */
import { DOMParser } from "linkedom";
import * as Y from "yjs";
import { canvasMapName, hasCanvasState, materializeCanvas } from "../app/components/editor/canvas/collab/ymap";
import { migrateLegacyCanvas } from "../app/components/editor/canvas/scene/migrate";
import { serializeScene } from "../app/components/editor/canvas/scene/serialize";
import { walk, type Scene } from "../app/components/editor/canvas/scene/types";
import { fragmentCanvasData } from "../app/lib/nml/canvasMaps";
import type { NmlBlock } from "../app/lib/nml/schema";
import { decodeNmlDocument } from "../app/lib/nml/yjs";

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

function load(updates: ArrayBuffer[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, new Uint8Array(update));
  return doc;
}

function nmlScene(doc: Y.Doc, blockId: string): Scene | null {
  const find = (blocks: NmlBlock[]): NmlBlock | undefined => {
    for (const block of blocks) {
      if (block.id === blockId) return block;
      const nested = find(block.children);
      if (nested) return nested;
    }
  };
  const block = find(decodeNmlDocument(doc).blocks);
  return block?.type === "canvas" ? block.scene : null;
}

/** A scene as one comparable line: every shape's id, position and label, in tree order. */
function outline(scene: Scene | null): string {
  if (!scene) return "";
  const shapes: string[] = [];
  walk(scene.nodes, (node) => { shapes.push(`${node.id}@${Math.round(node.x)},${Math.round(node.y)}:${node.label}`); });
  return `${shapes.join(" ")} | ${scene.edges.map((edge) => edge.id).join(" ")}`;
}

/** The diagrams on the page, by block ID, as NML, the maps and the prop each hold them. */
export function diagrams(updates: ArrayBuffer[]) {
  const doc = load(updates);
  try {
    const props = fragmentCanvasData(doc.getXmlFragment("prosemirror"));
    const result: Record<string, { nml: string; maps: string; prop: string }> = {};
    for (const [id, data] of props) {
      const root = doc.getMap<unknown>(canvasMapName(id));
      result[id] = {
        nml: outline(nmlScene(doc, id)),
        maps: hasCanvasState(root) ? outline(materializeCanvas(root)) : "",
        prop: data ? outline(migrateLegacyCanvas(data)) : "",
      };
    }
    return result;
  } finally {
    doc.destroy();
  }
}

/** The whole diagram an agent would write back: NML's scene with one shape moved and relabelled. */
export function agentDiagram(updates: ArrayBuffer[], blockId: string, shapeId: string, dx: number, dy: number, label: string): string {
  const doc = load(updates);
  try {
    const scene = structuredClone(nmlScene(doc, blockId));
    if (!scene) throw new Error(`no diagram ${blockId}`);
    let found = false;
    walk(scene.nodes, (node) => {
      if (node.id !== shapeId) return;
      node.x += dx;
      node.y += dy;
      node.label = label;
      found = true;
    });
    if (!found) throw new Error(`no shape ${shapeId}`);
    return serializeScene(scene);
  } finally {
    doc.destroy();
  }
}
