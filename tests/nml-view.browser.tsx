import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { ReadOnlyContext } from "../app/components/editor/readOnly";
import { NmlReadOnlyView } from "../app/components/editor/nml/NmlReadOnlyView";
import { convertLegacyDocument, type LegacyDocumentInput } from "../app/lib/nml/legacy";
import { createNmlYDoc, decodeNmlDocument } from "../app/lib/nml/yjs";
import { executeNmlCommands, type NmlCommand } from "../app/lib/nml/commands";
import { ReadOnlyNmlBridge } from "../app/lib/nml/view";
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
let bridge: ReadOnlyNmlBridge;
let ydoc: Y.Doc;
let initial: Uint8Array;
let updates = 0;
let sequence = 0;

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

async function command(commands: NmlCommand[]) {
  const id = `browser-${++sequence}`;
  await executeNmlCommands({ doc: ydoc, documentId: decodeNmlDocument(ydoc).documentId, commands, idempotencyKey: id, origin: { version: 1, transactionId: id, actor: { userId: "fixture", kind: "human" }, command: "browser-test" }, authorize: () => true });
}

const harness = {
  mount,
  inspect: () => ({ status: bridge.status(), parity: bridge.checkDrift(), updates, unchanged: initial.toString() === Y.encodeStateAsUpdate(ydoc).toString(), ast: decodeNmlDocument(ydoc), pm: bridge.state.doc.toJSON() }),
  tryEdit: () => bridge.dispatch(bridge.state.tr.insertText("UNAUTHORIZED", 1).setMeta("nmlBridge", { direction: "nml-to-pm" })),
  remoteText: async () => {
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(ydoc));
    await executeNmlCommands({ doc: replica, documentId: decodeNmlDocument(replica).documentId, commands: [{ type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "Remote update: ", marks: [] }] }], idempotencyKey: "remote", origin: { version: 1, transactionId: "remote", actor: { userId: "remote", kind: "human" }, command: "browser-test" }, authorize: () => true });
    Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(replica));
    replica.destroy();
  },
  command,
  corrupt: () => { ydoc.getMap("nml").set("schemaVersion", 99); },
  drift: () => bridge.checkDrift(bridge.state.tr.insertText("drift", 1).doc),
  destroy: () => { root?.unmount(); bridge.destroy(); ydoc.destroy(); void convex.close(); },
};
declare global { interface Window { nmlHarness: typeof harness } }
window.nmlHarness = harness;
mount("rich");
