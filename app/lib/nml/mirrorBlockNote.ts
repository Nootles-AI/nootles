"use client";

import {
  blocksToYXmlFragment,
  yXmlFragmentToBlocks,
} from "@blocknote/core/yjs";
import type {
  BlockNoteEditor,
  BlockSchema,
  InlineContentSchema,
  StyleSchema,
} from "@blocknote/core";
import * as Y from "yjs";
import type { LegacyBlock } from "./legacy";
import {
  NML_LEGACY_MIRROR_ORIGIN,
  type NmlLegacyMirrorHost,
} from "./mirror";

/** Browser adapter for the tested mirror state machine. */
export function blockNoteNmlMirrorHost<
  BSchema extends BlockSchema,
  ISchema extends InlineContentSchema,
  SSchema extends StyleSchema,
>(
  editor: BlockNoteEditor<BSchema, ISchema, SSchema>,
  doc: Y.Doc,
): NmlLegacyMirrorHost {
  const fragment = doc.getXmlFragment("prosemirror");
  return {
    readBlocks: () => yXmlFragmentToBlocks(editor, fragment) as unknown as LegacyBlock[],
    writeBlocks: (blocks, origin) => {
      doc.transact(() => {
        blocksToYXmlFragment(editor, blocks as never, fragment);
      }, origin);
    },
    subscribe: (listener) => {
      const observe = (_events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
        listener(transaction.origin);
      };
      fragment.observeDeep(observe);
      return () => fragment.unobserveDeep(observe);
    },
  };
}

export { NML_LEGACY_MIRROR_ORIGIN };
