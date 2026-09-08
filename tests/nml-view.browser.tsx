import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { ReadOnlyContext } from "../app/components/editor/readOnly";
import { NmlPlainTextView, NmlReadOnlyView } from "../app/components/editor/nml/NmlReadOnlyView";
import { convertLegacyDocument, type LegacyDocumentInput } from "../app/lib/nml/legacy";
import { createNmlYDoc, decodeNmlDocument } from "../app/lib/nml/yjs";
import { executeNmlCommands, type NmlCommand } from "../app/lib/nml/commands";
import { PlainTextNmlBridge, ReadOnlyNmlBridge, type BridgeDiagnostic, type BridgeRequestUpdate } from "../app/lib/nml/view";
import type { NmlDocument } from "../app/lib/nml/schema";
import * as Y from "yjs";
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
let bridge: ReadOnlyNmlBridge | PlainTextNmlBridge;
let ydoc: Y.Doc;
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
  }, (entry) => diagnostics.push(entry));
  bridge.subscribe((event) => { if (event.request) requests.push(event.request); });
  root = createRoot(document.getElementById("app")!);
  root.render(<StrictMode><section><h2>NML plain-text editor</h2><div id="bridge"><NmlPlainTextView bridge={bridge as PlainTextNmlBridge} /></div></section></StrictMode>);
}

async function command(commands: NmlCommand[]) {
  const id = `browser-${++sequence}`;
  await executeNmlCommands({ doc: ydoc, documentId: decodeNmlDocument(ydoc).documentId, commands, idempotencyKey: id, origin: { version: 1, transactionId: id, actor: { userId: "fixture", kind: "human" }, command: "browser-test" }, authorize: () => true });
}

const harness = {
  mount,
  mountEditable,
  inspect: () => ({ status: bridge.status(), parity: bridge.checkDrift(), updates, unchanged: initial.toString() === Y.encodeStateAsUpdate(ydoc).toString(), ast: decodeNmlDocument(ydoc), pm: bridge.state.doc.toJSON(), requests, diagnostics, performance: bridge.performance() }),
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
  setAuthorization: (mode: "allow" | "deny" | "defer") => { authorization = mode; },
  resolveAuthorization: (allowed: boolean) => { const resolve = resolveAuthorization; resolveAuthorization = undefined; authorization = "allow"; resolve?.(allowed); },
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
  destroy: () => { root?.unmount(); bridge.destroy(); ydoc.destroy(); void convex.close(); },
};
declare global { interface Window { nmlHarness: typeof harness } }
window.nmlHarness = harness;
mount("rich");
