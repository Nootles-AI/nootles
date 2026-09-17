import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { createNmlYDoc, decodeNmlDocument, executeNmlCommands, type NmlDocument } from "../app/lib/nml";
import { NmlLegacyMirror } from "../app/lib/nml/mirror";
import { blockNoteNmlMirrorHost } from "../app/lib/nml/mirrorBlockNote";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

const EXTENSIONS = [completionExtension, reviewExtension, hintExtension, arrivalFlashExtension, blockSelectionExtension];
type Editor = typeof schema.BlockNoteEditor;

let root: Root | undefined;
let editor: Editor;
let doc: Y.Doc;
let awareness: Awareness;
let mirror: NmlLegacyMirror;
let sequence = 0;

const source = (): NmlDocument => ({
  schemaVersion: 1,
  documentId: "browser-parity",
  blocks: [
    { id: "paragraph", type: "paragraph", props: {}, content: [{ type: "text", text: "Ready", marks: [] }], children: [] },
    { id: "code", type: "codeBlock", props: { language: "typescript" }, code: "const x = 1", children: [] },
    { id: "image", type: "image", props: { source: { kind: "url", url: "#old.png" }, caption: "Old" }, children: [] },
  ],
});

function mount() {
  root?.unmount();
  mirror?.stop();
  awareness?.destroy();
  doc?.destroy();
  doc = createNmlYDoc(source());
  awareness = new Awareness(doc);
  editor = BlockNoteEditor.create(withCollaboration({
    schema,
    extensions: EXTENSIONS,
    collaboration: {
      fragment: doc.getXmlFragment("prosemirror"),
      user: { name: "Browser", color: "#6544e9" },
      provider: { awareness },
    },
  })) as unknown as Editor;
  mirror = new NmlLegacyMirror(doc, blockNoteNmlMirrorHost(editor, doc), {
    actor: { kind: "human", userId: "browser" },
    createRequestId: () => `browser-${++sequence}`,
  }).start();
  root = createRoot(document.getElementById("app")!);
  root.render(<BlockNoteView editor={editor} theme="light" />);
}

const harness = {
  mount,
  async settle() { await mirror.settle(); },
  canonical: () => decodeNmlDocument(doc),
  legacy: () => editor.document,
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  insertAtoms() {
    editor.setTextCursorPosition("paragraph", "end");
    editor.insertInlineContent([
      { type: "math", props: { latex: "x^2" } },
      { type: "pageMention", props: { pageId: "page-2", title: "Second page" } },
    ]);
  },
  updateDomains() {
    editor.updateBlock("code", { props: { language: "python" } });
    editor.updateBlock("image", {
      props: { url: "#new.png", caption: "New caption" },
    });
  },
  async directCanonical() {
    await executeNmlCommands({
      doc,
      documentId: "browser-parity",
      commands: [{
        type: "replaceInline",
        nodeId: "paragraph",
        range: { from: 0, to: 5 },
        content: [{ type: "text", text: "Direct", marks: ["bold"] }],
      }],
      idempotencyKey: `direct-${++sequence}`,
      origin: {
        version: 1,
        transactionId: `direct-${sequence}`,
        actor: { kind: "model", userId: "agent" },
        command: "browser-direct",
      },
      authorize: () => true,
    });
  },
};

declare global {
  interface Window { nmlParity: typeof harness }
}
window.nmlParity = harness;
mount();
