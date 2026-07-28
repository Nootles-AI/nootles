"use client";

import { useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { schema } from "./schema";
import { BlockSideMenu } from "./BlockSideMenu";
import { SubstrateHarness } from "./ai/SubstrateHarness";
import { completionExtension } from "./ai/completionExtension";
import { useTabCompletion } from "./ai/useTabCompletion";
import "./editor.css";

type EditorInstance = typeof schema.BlockNoteEditor;

function filterItems(
  items: DefaultReactSuggestionItem[],
  query: string,
): DefaultReactSuggestionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      i.aliases?.some((a) => a.toLowerCase().includes(q)),
  );
}

// Our custom insert items, grouped separately from the default "Basic blocks".
function customSlashItems(editor: EditorInstance): DefaultReactSuggestionItem[] {
  return [
    {
      title: "Diagram",
      subtext: "Draw a canvas with shapes and connectors",
      aliases: ["diagram", "canvas", "draw", "flowchart", "board", "graph"],
      group: "Canvas",
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "canvas", props: { data: "" } });
      },
    },
    {
      title: "Math equation",
      subtext: "Inline LaTeX equation",
      aliases: ["math", "math-equation", "equation", "latex", "tex", "inline math"],
      group: "Math",
      onItemClick: () => {
        editor.insertInlineContent([{ type: "math", props: { latex: "" } }, " "]);
      },
    },
    {
      title: "Math block",
      subtext: "Reactive equations with live variables",
      aliases: ["math-block", "mathblock", "calc", "variables", "compute", "notebook"],
      group: "Math",
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "mathBlock", props: { source: "" } });
      },
    },
  ];
}

/**
 * The block editor for a single page, bound to its prosemirror-sync document.
 * Steps + snapshots are persisted by the Convex prosemirror-sync component, so
 * this stays a thin client: the hook owns the collaborative state, we own the
 * presentation and the (custom) schema. The slash menu's "Code Block" item
 * targets our `codeBlock` type, which is the CodeMirror-backed block.
 */
export function Editor({
  docId,
  pageId,
}: {
  docId: string;
  pageId?: Id<"pages">;
}) {
  const sync = useBlockNoteSync<EditorInstance>(api.prosemirror, docId, {
    editorOptions: { schema, extensions: [completionExtension] },
  });

  useTabCompletion(sync.editor, pageId);

  // First open of a page has no document yet — create an empty one seamlessly.
  // Guarded per-docId so StrictMode's double-invoke can't create twice.
  const createdFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sync.isLoading && !sync.editor && createdFor.current !== docId) {
      createdFor.current = docId;
      void sync.create({ type: "doc", content: [] });
    }
  }, [sync, docId]);

  if (!sync.editor) {
    return <div className="min-h-[40vh]" aria-hidden />;
  }

  const editor = sync.editor;
  return (
    <>
      <BlockNoteView
        editor={editor}
        theme="light"
        className="ab-editor"
        sideMenu={false}
        slashMenu={false}
      >
        <BlockSideMenu />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterItems(
              [...getDefaultReactSlashMenuItems(editor), ...customSlashItems(editor)],
              query,
            )
          }
        />
      </BlockNoteView>
      {process.env.NODE_ENV !== "production" && pageId && (
        <SubstrateHarness editor={editor} pageId={pageId} />
      )}
    </>
  );
}
