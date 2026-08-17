"use client";

import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useYjsEditor } from "@/app/lib/sync/useYjsEditor";
import { collabColor } from "@/app/lib/sync/colors";
import { arrivalFlashExtension } from "../editor/arrivalFlash";
import { schema } from "../editor/schema";
import "../editor/editor.css";

type EditorInstance = typeof schema.BlockNoteEditor;

const YJS_ON = process.env.NEXT_PUBLIC_YJS === "1";

const placeholder = <div className="min-h-[40vh]" aria-hidden />;

// A page whose owner never opened it holds nothing — said plainly, in the
// voice of "This project has no pages", rather than as an indistinguishable
// forever-loading blank.
const empty = <p className="text-sm text-muted">This page is empty.</p>;

/**
 * The real editor, reading a shared page — on whichever pipeline the page
 * lives, decided by the same reactive `state` the workspace watches, so a
 * viewer flips over live the moment an editor migrates the doc. Same schema,
 * same document, so a viewer sees exactly what the author sees — including
 * edits landing live. What it does not mount is everything that authors:
 * toolbars, menus, the AI layer. The custom blocks turn themselves read-only
 * via `ReadOnlyContext`, provided by `SharedProject` above.
 */
export function SharedEditor({ docId }: { docId: string }) {
  const state = useQuery(api.ydoc.state, YJS_ON ? { docId } : "skip");
  if (YJS_ON && state === undefined) return placeholder;
  if (YJS_ON && state === "yjs") return <SharedYjs docId={docId} />;
  // Never opened — a viewer must not create it, so there is nothing to mount.
  if (YJS_ON && state === "empty") return empty;
  return <SharedLegacy docId={docId} />;
}

function SharedYjs({ docId }: { docId: string }) {
  const { editor } = useYjsEditor<EditorInstance>({
    docId,
    user: { name: "Anonymous", color: collabColor(docId) },
    // Viewers see arrivals too — an approved AI edit flashes for everyone.
    editorOptions: { schema, extensions: [arrivalFlashExtension] },
  });
  if (!editor) return placeholder;
  return <ReadOnlyView editor={editor} />;
}

function SharedLegacy({ docId }: { docId: string }) {
  const sync = useBlockNoteSync<EditorInstance>(api.prosemirror, docId, {
    editorOptions: { schema },
  });
  if (sync.isLoading) return placeholder;
  if (!sync.editor) return empty;
  return <ReadOnlyView editor={sync.editor} />;
}

function ReadOnlyView({ editor }: { editor: EditorInstance }) {
  return (
    <BlockNoteView
      editor={editor}
      editable={false}
      theme="light"
      className="nt-editor"
      sideMenu={false}
      slashMenu={false}
      formattingToolbar={false}
    />
  );
}
