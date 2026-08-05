"use client";

import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { api } from "@/convex/_generated/api";
import { schema } from "../editor/schema";
import "../editor/editor.css";

type EditorInstance = typeof schema.BlockNoteEditor;

/**
 * The real editor, reading a shared page. Same schema, same sync document, so a
 * viewer sees exactly what the author sees — including edits landing live. What
 * it does not mount is everything that authors: toolbars, menus, the AI layer.
 * The custom blocks turn themselves read-only via `ReadOnlyContext`, provided
 * by `SharedProject` above.
 */
export function SharedEditor({ docId }: { docId: string }) {
  const sync = useBlockNoteSync<EditorInstance>(api.prosemirror, docId, {
    editorOptions: { schema },
  });

  // A page whose document was never opened has nothing to show — unlike the
  // authoring editor, a viewer must not create one.
  if (!sync.editor) return <div className="min-h-[40vh]" aria-hidden />;

  return (
    <BlockNoteView
      editor={sync.editor}
      editable={false}
      theme="light"
      className="nt-editor"
      sideMenu={false}
      slashMenu={false}
      formattingToolbar={false}
    />
  );
}
