import { useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { ySyncPluginKey } from "y-prosemirror";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { FormattingToolbarController } from "@blocknote/react";
import type { EditorView } from "prosemirror-view";
import { schema } from "../app/components/editor/schema";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelection, blockSelectionExtension } from "../app/components/editor/blockSelection";
import { useBlockMarquee } from "../app/components/editor/useBlockMarquee";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

// The production list, from `Editor.tsx`.
const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

type Editor = typeof schema.BlockNoteEditor;

/**
 * Stands in for `YConvexProvider`: every byte from the peer is applied with
 * the provider as origin, exactly as `pull()` applies the server's log.
 */
const PROVIDER = { provider: true };

let root: Root | undefined;
let editor: Editor;
let local: Y.Doc;
let peer: Y.Doc;
let history: Y.UndoManager;

function Surface({ editor }: { editor: Editor }) {
  const surface = useRef<HTMLDivElement>(null);
  const selected = blockSelection(editor);
  useBlockMarquee({ surfaceRef: surface, selection: selected, enabled: true });
  // PageSurface's pane: the one scroller, the full height of the window.
  return (
    <main id="pane" className="nt-pane" style={{ height: "100vh", overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ maxWidth: 760, width: "100%", padding: "80px 56px", flex: 1, display: "flex", flexDirection: "column", boxSizing: "border-box" }}>
        <div
          ref={surface}
          className="nt-marquee-surface"
          onMouseUp={() => requestAnimationFrame(() => selected.selectSpannedBlocks())}
        >
          <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false}>
            <FormattingToolbarController />
          </BlockNoteView>
        </div>
      </div>
    </main>
  );
}

const LINE = "The quick brown fox jumps over the lazy dog while the committee reviews the storyboard and debates the shot list. ";

function mount() {
  root?.unmount();
  local = new Y.Doc();
  peer = new Y.Doc();
  local.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== PROVIDER) Y.applyUpdate(peer, update, PROVIDER);
  });
  peer.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== PROVIDER) Y.applyUpdate(local, update, PROVIDER);
  });
  const awareness = new Awareness(local);
  const carets = createRemoteCarets(awareness);
  // The composition from `useYjsEditor.ts`.
  editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [...EXTENSIONS, remoteScrollExtension],
      collaboration: {
        fragment: local.getXmlFragment("prosemirror"),
        user: { name: "Local", color: "#3366cc" },
        provider: { awareness },
        showCursorLabels: "always",
        renderCursor: carets.render,
      },
    } as never),
  ) as unknown as Editor;
  // Configured as `textDomain.ts` configures the document's own manager.
  history = new Y.UndoManager(local.getXmlFragment("prosemirror"), {
    trackedOrigins: new Set([ySyncPluginKey]),
    captureTransaction: (tr) => tr.meta.get("addToHistory") !== false,
  });
  root = createRoot(document.getElementById("app")!);
  root.render(<Surface editor={editor} />);
  carets.attach();
}

function seed(paragraphs: number) {
  const blocks = Array.from({ length: paragraphs }, (_, i) => ({
    type: "paragraph" as const,
    content: `Paragraph ${i}. ${LINE.repeat(3)}`,
  }));
  editor.replaceBlocks(editor.document, blocks as never);
  return editor.document.length;
}

const view = (): EditorView => (editor as unknown as { prosemirrorView: EditorView }).prosemirrorView;
const pane = () => document.getElementById("pane")!;

/** Viewport point of character `offset` inside block `index`'s text. */
function textPoint(index: number, offset: number) {
  const id = editor.document[index]?.id;
  const content = document.querySelector(`[data-id="${id}"] .bn-inline-content`);
  if (!content) return null;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let left = offset;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent!.length;
    if (left <= length) {
      const range = document.createRange();
      range.setStart(node, left);
      range.collapse(true);
      const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    }
    left -= length;
  }
  return null;
}

/** The peer's own copy of the top-level block group and its containers. */
function peerGroup() {
  const group = peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement;
  return { group, ids: group.toArray().map((el) => (el as Y.XmlElement).getAttribute("id")) };
}

/** A collaborator typing at the end of block `index`, arriving through the provider. */
function peerType(index: number, text: string) {
  const id = editor.document[index]?.id;
  const { group, ids } = peerGroup();
  const container = group.get(ids.indexOf(id)) as Y.XmlElement;
  let target: Y.XmlText | null = null;
  for (const node of container.createTreeWalker((n) => n instanceof Y.XmlText)) {
    target = node as Y.XmlText;
    break;
  }
  if (!target) throw new Error(`no text for block ${index}`);
  const at = target.length;
  peer.transact(() => target!.insert(at, text), "peer");
}

/** A collaborator adding a whole paragraph before block `index`. */
function peerInsertParagraph(index: number, text: string) {
  const id = editor.document[index]?.id;
  const { group, ids } = peerGroup();
  const content = new Y.XmlText();
  content.insert(0, text);
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [content]);
  const container = new Y.XmlElement("blockContainer");
  container.setAttribute("id", `peer-${Date.now()}`);
  container.insert(0, [paragraph]);
  peer.transact(() => group.insert(ids.indexOf(id), [container]), "peer");
}

const harness = {
  mount,
  seed,
  textPoint,
  peerType,
  peerInsertParagraph,
  resetHistory: () => history.clear(),
  closeHistoryStep: () => history.stopCapturing(),
  undo: () => history.undo(),
  scrollTop: () => pane().scrollTop,
  setScrollTop: (top: number) => {
    pane().scrollTop = top;
  },
  paneRect: () => {
    const r = pane().getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  },
  blockRect: (index: number) => {
    const id = editor.document[index]?.id;
    const r = document.querySelector(`[data-id="${id}"]`)!.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  },
  headRect: () => {
    const r = view().coordsAtPos(view().state.selection.head);
    return { top: r.top, bottom: r.bottom };
  },
  anchorRect: () => {
    const r = view().coordsAtPos(view().state.selection.anchor);
    return { top: r.top, bottom: r.bottom };
  },
  selection: () => {
    const s = view().state.selection;
    return {
      kind: s.constructor.name,
      empty: s.empty,
      anchor: s.anchor,
      head: s.head,
      focused: view().hasFocus(),
    };
  },
  blockCount: () => editor.document.length,
  blockText: (index: number) =>
    ((editor.document[index]?.content ?? []) as { text?: string }[]).map((part) => part.text ?? "").join(""),
};

declare global {
  interface Window {
    scrollHarness: typeof harness;
  }
}
window.scrollHarness = harness;
