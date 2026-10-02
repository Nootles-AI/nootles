import * as Y from "yjs";
import {
  applySceneDiff,
  CANVAS_EDIT_KEY,
  CANVAS_MIRROR_KEY,
  canvasMapName,
  hasCanvasState,
  isCanvasMapName,
  materializeCanvas,
  mirrorStamp,
} from "@/app/components/editor/canvas/collab/ymap";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import type { NmlCommand } from "./commands";
import type { LegacyBlock } from "./legacy";
import type { NmlBlock, NmlCanvasBlock, NmlDocument } from "./schema";
import { compileCanvasSceneChange } from "./view/canvas";

/**
 * A served page's diagram lives twice in its Y.Doc: under its canonical NML
 * canvas block, and in the per-shape `canvas:<blockId>` maps the canvas binds
 * to (`canvas/collab/`). The maps are what the person draws on, so every local
 * write to them is carried into NML here (NT-129); a server-side canonical
 * write carries its diagram changes the other way, into the maps
 * (`writeCanvasMaps`). The block's `data` prop stays the binding's stamped,
 * trailing mirror on both sides — never a projection of NML.
 */

export function canvasBlocks(document: NmlDocument): Map<string, NmlCanvasBlock> {
  const result = new Map<string, NmlCanvasBlock>();
  const visit = (blocks: NmlBlock[]) => blocks.forEach((block) => {
    if (block.type === "canvas") result.set(block.id, block);
    visit(block.children);
  });
  visit(document.blocks);
  return result;
}

/** A diagram's maps when they hold it, without defining a root for any other ID. */
function heldMaps(doc: Y.Doc, blockId: string): Y.Map<unknown> | null {
  const name = canvasMapName(blockId);
  if (!doc.share.has(name)) return null;
  const root = doc.getMap<unknown>(name);
  return hasCanvasState(root) ? root : null;
}

/** The maps' diagram when they hold one, addressed the way NML addresses it. */
function mapsScene(doc: Y.Doc, blockId: string): Scene | null {
  const root = heldMaps(doc, blockId);
  return root && { ...materializeCanvas(root), id: blockId };
}

/** The commands that make a canvas block's NML scene what its maps hold. */
export function canvasFromMapsCommands(doc: Y.Doc, block: NmlCanvasBlock): NmlCommand[] {
  const scene = mapsScene(doc, block.id);
  return scene ? compileCanvasSceneChange(block.id, block.scene, scene).commands : [];
}

/**
 * The diagrams whose maps a transaction changed, by block ID. A change to the
 * binding's own bookkeeping alone (the mirror stamp, the edit token) moved no
 * shape and is left out.
 */
export function changedCanvasIds(doc: Y.Doc, transaction: Y.Transaction): string[] {
  const ids: string[] = [];
  for (const [name, type] of doc.share) {
    if (!isCanvasMapName(name)) continue;
    const events = transaction.changedParentTypes.get(type);
    if (!events?.length) continue;
    const bookkeeping = events.every((event) =>
      event.target === type &&
      [...(event as Y.YMapEvent<unknown>).keysChanged].every(
        (key) => key === CANVAS_MIRROR_KEY || key === CANVAS_EDIT_KEY,
      ));
    if (!bookkeeping) ids.push(name.slice(canvasMapName("").length));
  }
  return ids;
}

/**
 * A canonical write made with no canvas open — an MCP edit, its undo — puts
 * each diagram it changed into that diagram's maps, as the delta between the
 * two NML scenes, so a shape someone moved that NML had not heard of yet stays
 * where they put it. The edit token marks it as somebody's work, and the
 * returned mirror is stamped, so an open canvas adopts the maps and reads the
 * prop as a mirror rather than as a whole diagram to diff back in.
 */
export function writeCanvasMaps(doc: Y.Doc, before: NmlDocument, after: NmlDocument): Map<string, string> {
  const prior = canvasBlocks(before);
  const mirrors = new Map<string, string>();
  for (const [id, block] of canvasBlocks(after)) {
    const was = prior.get(id);
    const root = heldMaps(doc, id);
    if (!was || !root) continue;
    if (serializeScene(was.scene) === serializeScene(block.scene)) continue;
    applySceneDiff(root, was.scene, block.scene);
    root.set(CANVAS_EDIT_KEY, `nml.${Math.random().toString(36).slice(2, 10)}`);
    const html = serializeScene(materializeCanvas(root));
    root.set(CANVAS_MIRROR_KEY, mirrorStamp(html));
    mirrors.set(id, html);
  }
  return mirrors;
}

/**
 * The compatibility blocks with each diagram's `data` taken from `canvasData`
 * where it answers. A canvas the maps hold keeps the mirror its binding wrote:
 * projecting NML over it would rewrite a whole diagram per canonical change and
 * hand the binding an unstamped prop to read as an outside author.
 */
export function withCanvasData(
  blocks: LegacyBlock[],
  canvasData: (blockId: string) => string | undefined,
): LegacyBlock[] {
  for (const block of blocks) {
    if (block.type === "canvas" && block.id) {
      const data = canvasData(block.id);
      if (data !== undefined) block.props = { ...block.props, data };
    }
    if (block.children) withCanvasData(block.children, canvasData);
  }
  return blocks;
}

/** Whether a diagram's maps hold it — when its prop is the binding's mirror to keep. */
export function mapsHoldCanvas(doc: Y.Doc, blockId: string): boolean {
  return heldMaps(doc, blockId) !== null;
}

/** Each diagram block's `data` prop as the compatibility fragment holds it. */
export function fragmentCanvasData(fragment: Y.XmlFragment): Map<string, string> {
  const result = new Map<string, string>();
  for (const node of fragment.createTreeWalker((item) => item instanceof Y.XmlElement && item.nodeName === "canvas")) {
    const element = node as Y.XmlElement;
    const container = element.parent;
    const id = container instanceof Y.XmlElement ? container.getAttribute("id") : undefined;
    const data = element.getAttribute("data");
    if (typeof id === "string") result.set(id, typeof data === "string" ? data : "");
  }
  return result;
}
