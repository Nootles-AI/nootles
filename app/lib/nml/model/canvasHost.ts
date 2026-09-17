import type * as Y from "yjs";
import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { loadIconCatalog } from "@/app/components/editor/canvas/icons/registry";
import {
  refused,
  type CanvasHost,
  type CanvasRead,
  type Refusal,
  type WriteReceipt,
} from "@/app/lib/ai/canvas/host";
import { executeNmlCommands, type ExecuteNmlCommandsOptions } from "../commands";
import type { NmlBlock } from "../schema";
import { decodeNmlDocument } from "../yjs";
import { compileCanvasSceneChange } from "../view/canvas";

type ServedCanvasDocument = { pageId: string; doc: Y.Doc };

export type NmlCanvasHostOptions = {
  resolveDocument: (pageId?: string) => Promise<ServedCanvasDocument | null> | ServedCanvasDocument | null;
  actor: ExecuteNmlCommandsOptions["origin"]["actor"];
  authorize: ExecuteNmlCommandsOptions["authorize"];
  createRequestId?: () => string;
  createId?: ExecuteNmlCommandsOptions["createId"];
  prepareParse?: () => Promise<void>;
  parseHtml?: ParseHtml;
};

const SHOT_ADDRESS = /^(.+):(\d+)$/;
let requestSequence = 0;

function findBlock(blocks: NmlBlock[], id: string): NmlBlock | null {
  for (const block of blocks) {
    if (block.id === id) return block;
    const nested = findBlock(block.children, id);
    if (nested) return nested;
  }
  return null;
}

function requestId(options: NmlCanvasHostOptions): string {
  return options.createRequestId?.() ?? globalThis.crypto?.randomUUID?.() ?? `nml-canvas-${++requestSequence}`;
}

/**
 * CanvasHost over the canonical served scene. The 13 diagram planners stay
 * transport-agnostic; only this adapter knows that the scene lives in NML/Yjs.
 */
export function createNmlCanvasHost(options: NmlCanvasHostOptions): CanvasHost {
  return {
    async readScene(blockId, pageId): Promise<CanvasRead | Refusal | null> {
      const resolved = await options.resolveDocument(pageId);
      if (!resolved) return null;
      const document = decodeNmlDocument(resolved.doc);
      const shot = SHOT_ADDRESS.exec(blockId);
      if (shot && findBlock(document.blocks, shot[1])?.type === "storyboard") {
        return refused(
          `The "${blockId}" address is a storyboard shot; shots are rewritten whole through edit_page for now.`,
        );
      }
      const block = findBlock(document.blocks, blockId);
      if (!block || block.type !== "canvas") return null;
      return { pageId: resolved.pageId, blockId, scene: structuredClone(block.scene) };
    },

    async writeScene(read, next): Promise<WriteReceipt | Refusal> {
      const resolved = await options.resolveDocument(read.pageId);
      if (!resolved) return refused("The page is no longer available, so nothing on the diagram changed.");
      const block = findBlock(decodeNmlDocument(resolved.doc).blocks, read.blockId);
      if (!block || block.type !== "canvas") {
        return refused(`This page has no diagram with id "${read.blockId}".`);
      }
      const compiled = compileCanvasSceneChange(read.blockId, read.scene, next);
      if (!compiled.commands.length) return { added: 0, removed: 0, changed: 0, hunks: 0 };
      const id = requestId(options);
      try {
        await executeNmlCommands({
          doc: resolved.doc,
          documentId: decodeNmlDocument(resolved.doc).documentId,
          commands: compiled.commands,
          origin: {
            version: 1,
            transactionId: `transaction-${id}`,
            requestId: id,
            batchId: id,
            actor: options.actor,
            command: "canvas-tool",
          },
          idempotencyKey: id,
          authorize: options.authorize,
          createId: options.createId,
        });
      } catch {
        return refused(
          [
            "The change could not be applied just now — nothing on the diagram changed, and",
            "this was not a problem with what you sent. Call the same tool once more with the",
            "SAME arguments.",
          ].join("\n"),
        );
      }
      // The legacy review layer sees a canvas update as one changed block/hunk;
      // keep the same receipt even though NML merged it per shape underneath.
      return { added: 0, removed: 0, changed: 1, hunks: 1 };
    },

    async prepareParse() {
      if (options.prepareParse) await options.prepareParse();
      else await loadIconCatalog();
    },

    ...(options.parseHtml ? { parseHtml: options.parseHtml } : {}),
  };
}
