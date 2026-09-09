import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { TextSelection } from "prosemirror-state";
import { schema } from "../app/components/editor/schema";
import { ReadOnlyContext } from "../app/components/editor/readOnly";
import { NmlEditableView, NmlPlainTextView, NmlReadOnlyView } from "../app/components/editor/nml/NmlReadOnlyView";
import { convertLegacyDocument, type LegacyDocumentInput } from "../app/lib/nml/legacy";
import { createNmlYDoc, decodeNmlDocument } from "../app/lib/nml/yjs";
import { executeNmlCommands, type NmlCommand } from "../app/lib/nml/commands";
import {
  EditableNmlBridge,
  PlainTextNmlBridge,
  ReadOnlyNmlBridge,
  nmlInlineOffsetToPm,
  type BridgeDiagnostic,
  type BridgeRequestUpdate,
} from "../app/lib/nml/view";
import type { NmlDocument } from "../app/lib/nml/schema";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import rich from "../app/lib/nml/__fixtures__/legacy/rich-text.json";
import table from "../app/lib/nml/__fixtures__/legacy/table.json";
import code from "../app/lib/nml/__fixtures__/legacy/code-math.json";
import media from "../app/lib/nml/__fixtures__/legacy/media.json";
import domains from "../app/lib/nml/__fixtures__/legacy/domains.json";
import canvas from "../app/lib/nml/__fixtures__/legacy/canvas-html.json";
import oldCanvas from "../app/lib/nml/__fixtures__/legacy/canvas-legacy-json.json";
import edges from "../app/lib/nml/__fixtures__/legacy/edge-cases.json";
import "@blocknote/mantine/style.css";

const fixtures: Record<string, LegacyDocumentInput> = { rich, table, code, media, domains, canvas, oldCanvas, edges };
const convex = new ConvexReactClient("https://nml-view-test.invalid", { skipConvexDeploymentUrlCheck: true });
let root: Root | undefined;
let bridge: ReadOnlyNmlBridge | PlainTextNmlBridge | EditableNmlBridge;
let ydoc: Y.Doc;
let awareness: Awareness | undefined;
let initial: Uint8Array;
let updates = 0;
let sequence = 0;
let requests: BridgeRequestUpdate[] = [];
let diagnostics: BridgeDiagnostic[] = [];
let authorization: "allow" | "deny" | "defer" = "allow";
let resolveAuthorization: ((allowed: boolean) => void) | undefined;

function mount(name: string) {
  root?.unmount();
  bridge?.destroy();
  ydoc?.destroy();
  awareness = undefined;
  const fixture = fixtures[name];
  let id = 0;
  const converted = convertLegacyDocument(fixture, { createId: () => `fixture-${id++}` });
  if (!converted.document) throw new Error("Invalid fixture");
  ydoc = createNmlYDoc(converted.document);
  initial = Y.encodeStateAsUpdate(ydoc);
  updates = 0;
  ydoc.on("update", () => updates++);
  bridge = new ReadOnlyNmlBridge(ydoc);
  const editor = BlockNoteEditor.create({ schema, initialContent: fixture.blocks as never });
  root = createRoot(document.getElementById("app")!);
  root.render(<StrictMode><ConvexProvider client={convex}><ReadOnlyContext.Provider value={true}>
    <section><h2>NML read-only bridge</h2><div id="bridge"><NmlReadOnlyView bridge={bridge} /></div></section>
    <section><h2>Current editor · read-only</h2><div id="legacy" className="nt-editor"><BlockNoteView editor={editor} editable={false} theme="light" formattingToolbar={false} slashMenu={false} sideMenu={false} /></div></section>
  </ReadOnlyContext.Provider></ConvexProvider></StrictMode>);
}

function mountEditable() {
  root?.unmount();
  bridge?.destroy();
  ydoc?.destroy();
  const editableDocument: NmlDocument = {
    schemaVersion: 1,
    documentId: "browser-editing",
    blocks: [
      { id: "plain", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "Plain text", marks: [] }] },
      { id: "heading", type: "heading", props: { level: 2 }, children: [], content: [{ type: "text", text: "Heading", marks: [] }] },
      { id: "quote", type: "quote", props: {}, children: [], content: [{ type: "text", text: "Quote text", marks: [] }] },
      { id: "rich", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "Rich text", marks: ["bold"] }] },
      { id: "list", type: "bulletListItem", props: {}, children: [], content: [{ type: "text", text: "List text", marks: [] }] },
    ],
  };
  ydoc = createNmlYDoc(editableDocument);
  awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: "Browser fixture", color: "#777777" });
  initial = Y.encodeStateAsUpdate(ydoc);
  updates = 0;
  requests = [];
  diagnostics = [];
  authorization = "allow";
  resolveAuthorization = undefined;
  ydoc.on("update", () => updates++);
  bridge = new PlainTextNmlBridge(ydoc, {
    actor: { userId: "browser", kind: "human" },
    authorize: () => {
      if (authorization === "allow") return true;
      if (authorization === "deny") return false;
      return new Promise<boolean>((resolve) => { resolveAuthorization = resolve; });
    },
    createRequestId: () => `browser-request-${++sequence}`,
    awareness,
  }, (entry) => diagnostics.push(entry));
  bridge.subscribe((event) => { if (event.request) requests.push(event.request); });
  root = createRoot(document.getElementById("app")!);
  root.render(<StrictMode><section><h2>NML plain-text editor</h2><div id="bridge"><NmlPlainTextView bridge={bridge as PlainTextNmlBridge} /></div></section></StrictMode>);
}

function mountRichEditable() {
  root?.unmount();
  bridge?.destroy();
  ydoc?.destroy();
  const convertedDomains = convertLegacyDocument(domains, { createId: (() => { let id = 0; return () => `rich-domain-${++id}`; })() });
  if (!convertedDomains.document) throw new Error("Invalid domain fixture");
  const richDocument: NmlDocument = {
    schemaVersion: 1,
    documentId: "browser-rich-editing",
    blocks: [
      { id: "rich-full", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "Rich text", marks: ["bold"] }] },
      { id: "list-one", type: "bulletListItem", props: {}, children: [], content: [{ type: "text", text: "First item", marks: [] }] },
      { id: "list-two", type: "bulletListItem", props: {}, children: [], content: [{ type: "text", text: "Second item", marks: [] }] },
      {
        id: "table-rich", type: "table", props: { headerRows: 1 }, children: [], columns: [{ id: "table-column" }],
        rows: [{ id: "table-row", cells: [{ id: "table-cell", content: [{ type: "text", text: "Cell", marks: [] }] }] }],
      },
      { id: "code-rich", type: "codeBlock", props: { language: "typescript" }, children: [], code: "const value = 1" },
      { id: "math-rich", type: "mathBlock", props: {}, children: [], rows: [{ id: "math-row", latex: "x" }] },
      { id: "audio-rich", type: "audio", props: {}, children: [] },
      ...convertedDomains.document.blocks,
    ],
  };
  ydoc = createNmlYDoc(richDocument);
  awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name: "Browser fixture", color: "#777777" });
  initial = Y.encodeStateAsUpdate(ydoc);
  updates = 0;
  requests = [];
  diagnostics = [];
  authorization = "allow";
  resolveAuthorization = undefined;
  ydoc.on("update", () => updates++);
  bridge = new EditableNmlBridge(ydoc, {
    actor: { userId: "browser", kind: "human" },
    authorize: () => true,
    createRequestId: () => `browser-request-${++sequence}`,
    awareness,
  }, (entry) => diagnostics.push(entry));
  bridge.subscribe((event) => { if (event.request) requests.push(event.request); });
  root = createRoot(document.getElementById("app")!);
  root.render(<StrictMode><ConvexProvider client={convex}>
    <section><h2>NML rich editor</h2><div id="bridge"><NmlEditableView bridge={bridge as EditableNmlBridge} /></div></section>
  </ConvexProvider></StrictMode>);
}

async function command(commands: NmlCommand[]) {
  const id = `browser-${++sequence}`;
  await executeNmlCommands({ doc: ydoc, documentId: decodeNmlDocument(ydoc).documentId, commands, idempotencyKey: id, origin: { version: 1, transactionId: id, actor: { userId: "fixture", kind: "human" }, command: "browser-test" }, authorize: () => true });
}

const harness = {
  mount,
  mountEditable,
  mountRichEditable,
  inspect: () => ({ status: bridge.status(), parity: bridge.checkDrift(), updates, unchanged: initial.toString() === Y.encodeStateAsUpdate(ydoc).toString(), ast: decodeNmlDocument(ydoc), pm: bridge.state.doc.toJSON(), requests, diagnostics, performance: bridge.performance(), recovery: bridge.compositionRecovery(), awareness: awareness?.getLocalState()?.nmlSelection }),
  tryEdit: () => bridge.dispatch(bridge.state.tr.insertText("UNAUTHORIZED", 1).setMeta("nmlBridge", { direction: "nml-to-pm" })),
  remoteText: async () => {
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
    await executeNmlCommands({ doc: replica, documentId: decodeNmlDocument(replica).documentId, commands: [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "Remote update: ", marks: [] }] }], idempotencyKey: "remote", origin: { version: 1, transactionId: "remote", actor: { userId: "remote", kind: "human" }, command: "browser-test" }, authorize: () => true });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(replica));
    replica.destroy();
  },
  remoteEdit: async (nodeId: string, from: number, to: number, value: string) => {
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
    const id = `remote-${++sequence}`;
    await executeNmlCommands({ doc: replica, documentId: decodeNmlDocument(replica).documentId, commands: [{ type: "replaceInline", nodeId, range: { from, to }, content: value ? [{ type: "text", text: value, marks: [] }] : [] }], idempotencyKey: id, origin: { version: 1, transactionId: id, actor: { userId: "remote", kind: "human" }, command: "browser-test" }, authorize: () => true });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(replica));
    replica.destroy();
  },
  remoteDelete: async (nodeId: string) => {
    await command([{ type: "removeNodes", nodeIds: [nodeId] }]);
  },
  startComposition: (nodeId: string, from: number, to = from) => {
    const start = bridge.index.get(nodeId)?.contentStart;
    const editor = document.querySelector("#bridge .nt-nml-view");
    if (start === undefined || !editor) return false;
    bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(bridge.state.doc, start + from, start + to)));
    editor.dispatchEvent(new CompositionEvent("compositionstart", { data: "", bubbles: true, cancelable: true }));
    return true;
  },
  updateComposition: (nodeId: string, from: number, to: number, value: string) => {
    const start = bridge.index.get(nodeId)?.contentStart;
    const editor = document.querySelector("#bridge .nt-nml-view");
    if (start === undefined || !editor) return false;
    editor.dispatchEvent(new CompositionEvent("compositionupdate", { data: value, bubbles: true, cancelable: true }));
    return bridge.dispatch(bridge.state.tr.insertText(value, start + from, start + to).setMeta("composition", 1));
  },
  finishComposition: (value: string) => {
    const editor = document.querySelector("#bridge .nt-nml-view");
    return editor?.dispatchEvent(new CompositionEvent("compositionend", { data: value, bubbles: true, cancelable: true })) ?? false;
  },
  setAuthorization: (mode: "allow" | "deny" | "defer") => { authorization = mode; },
  resolveAuthorization: (allowed: boolean) => { const resolve = resolveAuthorization; resolveAuthorization = undefined; authorization = "allow"; resolve?.(allowed); },
  selectInline: (nodeId: string, from: number, to = from) => {
    if (!(bridge instanceof EditableNmlBridge)) return false;
    const entry = bridge.index.get(nodeId);
    const node = entry ? bridge.state.doc.nodeAt(entry.pmStart) : null;
    if (!entry?.contentStart || !node) return false;
    const changed = bridge.dispatch(bridge.state.tr.setSelection(TextSelection.create(
      bridge.state.doc,
      entry.contentStart + nmlInlineOffsetToPm(node, from, "after"),
      entry.contentStart + nmlInlineOffsetToPm(node, to, "before"),
    )));
    (document.querySelector("#bridge .nt-nml-view") as HTMLElement | null)?.focus();
    return changed;
  },
  setLink: (href: string | null) => bridge instanceof EditableNmlBridge && bridge.setLink(href),
  insertInlineMath: (latex: string) => bridge instanceof EditableNmlBridge && bridge.insertInlineMath(latex),
  insertPageReference: (pageId: string, title: string) => bridge instanceof EditableNmlBridge && bridge.insertPageReference(pageId, title),
  moveSelection: (direction: -1 | 1) => bridge instanceof EditableNmlBridge && bridge.moveSelection(direction),
  selectionOffset: (nodeId: string) => {
    const target = document.querySelector(`[data-nml-id="${nodeId}"]`);
    const selection = window.getSelection();
    if (!target || !selection?.anchorNode || !target.contains(selection.anchorNode)) return null;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    return range.toString().length;
  },
  stateSelectionOffset: (nodeId: string) => {
    const start = bridge.index.get(nodeId)?.contentStart;
    return start === undefined ? null : bridge.state.selection.from - start;
  },
  command,
  corrupt: () => { ydoc.getMap("nml").set("schemaVersion", 99); },
  drift: () => bridge.checkDrift(bridge.state.tr.insertText("drift", 1).doc),
  destroy: () => { root?.unmount(); bridge.destroy(); ydoc.destroy(); awareness = undefined; void convex.close(); },
};
declare global { interface Window { nmlHarness: typeof harness } }
window.nmlHarness = harness;
mount("rich");
