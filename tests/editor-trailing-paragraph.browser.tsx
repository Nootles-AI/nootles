import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { schema } from "../app/components/editor/schema";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import { blockSelection, blockSelectionExtension } from "../app/components/editor/blockSelection";
import { useBlockMarquee } from "../app/components/editor/useBlockMarquee";
import { applyBatch } from "../app/lib/ai/apply";
import { isEmptyParagraphBlock } from "../app/lib/documentTail";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

type Editor = typeof schema.BlockNoteEditor;
type PartialBlock = (typeof schema.PartialBlock);

let root: Root | undefined;
let editor: Editor;
let peer: Editor | undefined;
let ydoc: Y.Doc | undefined;
let remoteDoc: Y.Doc | undefined;

function Surface({ value }: { value: Editor }) {
  const surface = useRef<HTMLDivElement>(null);
  const selection = blockSelection(value);
  useBlockMarquee({ surfaceRef: surface, selection, enabled: true });
  return (
    <main id="pane" style={{ height: "100vh", overflow: "auto" }}>
      <div style={{ minHeight: "100%", maxWidth: 760, padding: "80px 56px", boxSizing: "border-box" }}>
        <div ref={surface} className="nt-marquee-surface">
          <BlockNoteView
            editor={value}
            theme="light"
            className="nt-editor"
            sideMenu={false}
            slashMenu={false}
            formattingToolbar={false}
          />
        </div>
      </div>
    </main>
  );
}

const extensions = () => [
  blockSelectionExtension,
  trailingParagraphExtension({ enabled: () => true }),
];

function render() {
  root ??= createRoot(document.getElementById("app")!);
  root.render(<Surface value={editor} />);
}

function mountStatic(initialContent: PartialBlock[]) {
  editor = BlockNoteEditor.create({
    schema,
    initialContent,
    extensions: extensions(),
  }) as Editor;
  render();
}

function mountCollaborative() {
  ydoc = new Y.Doc();
  remoteDoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: extensions(),
      collaboration: {
        fragment: ydoc.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness },
      },
    } as never),
  ) as unknown as Editor;
  peer = BlockNoteEditor.create(
    withCollaboration({
      schema,
      collaboration: {
        fragment: remoteDoc.getXmlFragment("prosemirror"),
        user: { name: "Peer", color: "#cc6633" },
        provider: { awareness: new Awareness(remoteDoc) },
      },
    } as never),
  ) as unknown as Editor;
  const peerHost = document.createElement("div");
  peerHost.hidden = true;
  document.body.appendChild(peerHost);
  peer.mount(peerHost);

  const relay = Symbol("remote-fixture");
  Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(ydoc), relay);
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc), relay);
  ydoc.on("update", (update, origin) => {
    if (origin !== relay) Y.applyUpdate(remoteDoc!, update, relay);
  });
  remoteDoc.on("update", (update, origin) => {
    if (origin !== relay) Y.applyUpdate(ydoc!, update, relay);
  });
  render();
}

function seedCollaborative(initialContent: PartialBlock[]) {
  editor.replaceBlocks(editor.document, initialContent);
}

function text(block: Editor["document"][number]): string {
  if (!Array.isArray(block.content)) return "";
  return block.content.map((inline) => inline.type === "text" ? inline.text : "").join("");
}

function summary() {
  const blocks = editor.document;
  const last = blocks.at(-1);
  return {
    ids: blocks.map((block) => block.id),
    types: blocks.map((block) => block.type),
    texts: blocks.map(text),
    realTail: !!last && isEmptyParagraphBlock(last),
    widgetCount: document.querySelectorAll(".bn-trailing-block").length,
    blockCount: document.querySelectorAll(".bn-block-outer[data-id]").length,
    band: !!document.querySelector(".nt-block-marquee"),
  };
}

function tailPoint() {
  const id = editor.document.at(-1)!.id;
  const rect = document.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
  return { x: rect.left + 20, y: (rect.top + rect.bottom) / 2 };
}

function tailRect() {
  const id = editor.document.at(-1)!.id;
  const rect = document.querySelector<HTMLElement>(`.bn-block-outer[data-id="${id}"]`)!.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function fillTail(content = "Typed") {
  editor.updateBlock(editor.document.at(-1)!, { content });
}

function convertTail() {
  editor.updateBlock(editor.document.at(-1)!, {
    type: "heading",
    props: { level: 2 },
    content: "Converted",
  });
}

function turnTailIntoDivider() {
  editor.updateBlock(editor.document.at(-1)!, { type: "divider", props: {} });
}

function turnTailIntoListItem() {
  editor.updateBlock(editor.document.at(-1)!, {
    type: "bulletListItem",
    props: {},
    content: "List item",
  });
}

function deleteTail() {
  const id = editor.document.at(-1)!.id;
  editor.removeBlocks([id]);
  return id;
}

function replaceAll() {
  editor.replaceBlocks(editor.document, [{ type: "quote", content: "Replacement" }]);
}

function insertAtEnd() {
  const tailId = editor.document.at(-1)!.id;
  applyBatch(editor, {
    ops: [
      {
        kind: "insertBlocks",
        at: { at: "docEnd" },
        blocks: [{ tempId: "$end", type: "paragraph", content: [{ type: "text", text: "At end" }] }],
      },
      {
        kind: "insertBlocks",
        at: { at: "after", ref: tailId },
        blocks: [{ tempId: "$after", type: "paragraph", content: [{ type: "text", text: "After tail" }] }],
      },
    ],
  });
  return tailId;
}

async function remoteFill() {
  if (!peer) throw new Error("Collaborative fixture is not mounted");
  const tailId = editor.document.at(-1)!.id;
  const deadline = performance.now() + 5_000;
  while (!peer.getBlock(tailId)) {
    if (performance.now() > deadline) throw new Error("Peer did not load the shared tail");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const before = peer.document.map(text);
  peer.updateBlock(tailId, { content: "Remote" });
  return before;
}

const harness = {
  mountStatic,
  mountCollaborative,
  seedCollaborative,
  summary,
  tailPoint,
  tailRect,
  fillTail,
  convertTail,
  turnTailIntoDivider,
  turnTailIntoListItem,
  deleteTail,
  replaceAll,
  insertAtEnd,
  remoteFill,
  undo: () => editor.undo(),
  redo: () => editor.redo(),
  selectedIds: () => blockSelection(editor).getSnapshot().ids,
};

declare global {
  interface Window {
    trailingHarness: typeof harness;
  }
}

window.trailingHarness = harness;
