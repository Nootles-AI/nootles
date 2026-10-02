import { BlockNoteEditor } from "@blocknote/core";
import { yXmlFragmentToBlocks } from "@blocknote/core/yjs";
import { DOMParser, parseHTML } from "linkedom";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readerSchema } from "@/app/lib/ai/readerSchema";
import {
  applySceneDiff,
  CANVAS_EDIT_KEY,
  CANVAS_LOCAL,
  CANVAS_MIGRATE,
  CANVAS_MIRROR_KEY,
  canvasMapName,
  materializeCanvas,
  mirrorStamp,
  populateCanvas,
} from "@/app/components/editor/canvas/collab/ymap";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import { createNmlYDoc, decodeNmlDocument, executeNmlCommands, type NmlDocument } from ".";
import { NmlLegacyMirror } from "./mirror";
import { blockNoteNmlMirrorHost } from "./mirrorBlockNote";
import { writeCompatibilityRoot } from "./serverMirror";
import { compileCanvasSceneChange } from "./view/canvas";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}
if (typeof globalThis.DOMParser === "undefined") Object.assign(globalThis, { DOMParser });

/**
 * NT-129: a served page's diagram is drawn on its `canvas:<id>` maps, and
 * canonical NML has to follow them — through the real BlockNote fragment, as
 * the served editor's mirror runs it.
 */

const SOURCE = `<nt-diagram h="300">
  <nt-rect id="a1" x="10" y="20" w="100" h="50">Start</nt-rect>
  <nt-rect id="b2" x="200" y="20" w="100" h="50">End</nt-rect>
  <nt-edge id="e1" from="a1" to="b2"></nt-edge>
</nt-diagram>`;

const fixture = (scene: Scene): NmlDocument => ({
  schemaVersion: 1,
  documentId: "served-diagram",
  blocks: [
    { id: "intro", type: "paragraph", props: {}, children: [], content: [{ type: "text", text: "Intro", marks: [] }] },
    { id: "diagram", type: "canvas", props: {}, children: [], scene },
  ],
});

const editors: BlockNoteEditor[] = [];
function served(scene = migrateLegacyCanvas(SOURCE), options: { isRemote?: (t: Y.Transaction) => boolean } = {}) {
  const editor = BlockNoteEditor.create({ schema: readerSchema }) as unknown as BlockNoteEditor;
  editors.push(editor);
  const doc = createNmlYDoc(fixture(scene));
  const mirror = new NmlLegacyMirror(doc, blockNoteNmlMirrorHost(editor, doc), {
    actor: { kind: "human", userId: "drawer" },
    ...options,
  }).start();
  const maps = doc.getMap<unknown>(canvasMapName("diagram"));
  return { editor, doc, mirror, maps };
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor._tiptapEditor?.destroy());
});

/** The canvas binding attaching: the prop populates the maps once. */
function attach(doc: Y.Doc, maps: Y.Map<unknown>, html: string) {
  doc.transact(() => populateCanvas(maps, migrateLegacyCanvas(html)), CANVAS_MIGRATE);
}

/** A committed gesture, as `CanvasCollab`'s live writer streams it. */
function draw(doc: Y.Doc, maps: Y.Map<unknown>, change: (scene: Scene) => void) {
  const before = materializeCanvas(maps);
  const after = structuredClone(before);
  change(after);
  doc.transact(() => applySceneDiff(maps, before, after), CANVAS_LOCAL);
}

const nmlScene = (doc: Y.Doc): Scene => {
  const block = decodeNmlDocument(doc).blocks.find((b) => b.id === "diagram");
  if (block?.type !== "canvas") throw new Error("no diagram");
  return block.scene;
};
const shape = (scene: Scene, id: string) => scene.nodes.find((node) => node.id === id)!;
const prop = (editor: BlockNoteEditor, doc: Y.Doc): string => {
  const blocks = yXmlFragmentToBlocks(editor, doc.getXmlFragment("prosemirror")) as Array<{ id: string; props: { data?: string } }>;
  return blocks.find((block) => block.id === "diagram")!.props.data!;
};
const same = (doc: Y.Doc, maps: Y.Map<unknown>) =>
  expect(serializeScene({ ...nmlScene(doc), id: undefined })).toBe(serializeScene({ ...materializeCanvas(maps), id: undefined }));

async function typeIntro(doc: Y.Doc, text: string) {
  await executeNmlCommands({
    doc,
    documentId: "served-diagram",
    commands: [{ type: "replaceInline", nodeId: "intro", range: { from: 5, to: 5 }, content: [{ type: "text", text, marks: [] }] }],
    idempotencyKey: `type-${text}`,
    origin: { version: 1, transactionId: `type-${text}`, actor: { kind: "human", userId: "drawer" }, command: "type" },
    authorize: () => true,
  });
}

describe("served diagram ↔ canonical NML (NT-129)", () => {
  it("carries a move into NML, and an edit elsewhere leaves the block's mirror alone", async () => {
    const { editor, doc, mirror, maps } = served();
    const mirrored = prop(editor, doc);
    attach(doc, maps, mirrored);
    await mirror.settle();

    draw(doc, maps, (scene) => { shape(scene, "a1").x += 100; shape(scene, "a1").y += 20; });
    await mirror.settle();
    expect(shape(nmlScene(doc), "a1")).toMatchObject({ x: 110, y: 40 });
    same(doc, maps);

    // Typing in a paragraph re-projects NML; the diagram's prop is the
    // binding's trailing mirror, never NML written back over it.
    await typeIntro(doc, " one");
    await mirror.settle();
    expect(prop(editor, doc)).toBe(mirrored);

    draw(doc, maps, (scene) => { shape(scene, "b2").x = 400; });
    await typeIntro(doc, " two");
    await mirror.settle();
    expect(shape(nmlScene(doc), "a1")).toMatchObject({ x: 110, y: 40 });
    expect(shape(nmlScene(doc), "b2")).toMatchObject({ x: 400 });
    expect(prop(editor, doc)).toBe(mirrored);
    same(doc, maps);
    mirror.stop();
  });

  it("carries a drawn shape, a label, a connector and a delete", async () => {
    const { editor, doc, mirror, maps } = served();
    attach(doc, maps, prop(editor, doc));
    draw(doc, maps, (scene) => {
      scene.nodes.push({ ...structuredClone(shape(scene, "b2")), id: "c3", x: 400, label: "Later" });
      scene.edges.push({ ...structuredClone(scene.edges[0]), id: "e2", from: "b2", to: "c3" });
      shape(scene, "a1").label = "Begin";
    });
    await mirror.settle();
    same(doc, maps);
    expect(shape(nmlScene(doc), "c3").label).toBe("Later");
    expect(nmlScene(doc).edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);

    draw(doc, maps, (scene) => {
      scene.nodes = scene.nodes.filter((node) => node.id !== "b2");
      scene.edges = [];
    });
    await mirror.settle();
    same(doc, maps);
    expect(nmlScene(doc).nodes.map((node) => node.id)).toEqual(["a1", "c3"]);
    mirror.stop();
  });

  it("brings a scene NML fell behind on back into step when the page opens", async () => {
    const stale = migrateLegacyCanvas(SOURCE);
    const editor = BlockNoteEditor.create({ schema: readerSchema }) as unknown as BlockNoteEditor;
    editors.push(editor);
    const doc = createNmlYDoc(fixture(stale));
    const maps = doc.getMap<unknown>(canvasMapName("diagram"));
    attach(doc, maps, SOURCE);
    draw(doc, maps, (scene) => { shape(scene, "a1").x = 300; });
    expect(shape(nmlScene(doc), "a1").x).toBe(10);

    const mirror = new NmlLegacyMirror(doc, blockNoteNmlMirrorHost(editor, doc), {
      actor: { kind: "human", userId: "drawer" },
    }).start();
    await mirror.settle();
    expect(shape(nmlScene(doc), "a1").x).toBe(300);
    same(doc, maps);
    mirror.stop();
  });

  it("leaves a collaborator's diagram writes to the collaborator", async () => {
    const remote = new Set<unknown>(["provider"]);
    const { editor, doc, mirror, maps } = served(undefined, { isRemote: (t) => remote.has(t.origin) });
    attach(doc, maps, prop(editor, doc));
    await mirror.settle();
    const writes: unknown[] = [];
    doc.on("afterTransaction", (t: Y.Transaction) => {
      if ((t.origin as { command?: string } | null)?.command === "canvas-mirror") writes.push(t.origin);
    });

    // Their client sends its maps and its own NML write together.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    const peerMaps = peer.getMap<unknown>(canvasMapName("diagram"));
    const start = Y.encodeStateVector(peer);
    const before = materializeCanvas(peerMaps);
    const after = structuredClone(before);
    shape(after, "b2").y = 120;
    peer.transact(() => applySceneDiff(peerMaps, before, after), CANVAS_LOCAL);
    await executeNmlCommands({
      doc: peer,
      documentId: "served-diagram",
      commands: compileCanvasSceneChange("diagram", nmlScene(peer), { ...after, id: "diagram" }).commands,
      idempotencyKey: "peer",
      origin: { version: 1, transactionId: "peer", actor: { kind: "human", userId: "peer" }, command: "canvas-mirror" },
      authorize: () => true,
    });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, start), "provider");
    await mirror.settle();
    expect(writes).toEqual([]);
    expect(shape(nmlScene(doc), "b2").y).toBe(120);
    same(doc, maps);

    // A review's kept change is merged in as an update too, but it is ours.
    draw(peer, peerMaps, (scene) => { shape(scene, "a1").x = 50; });
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), "kept-change");
    await mirror.settle();
    expect(writes).toHaveLength(1);
    expect(shape(nmlScene(doc), "a1").x).toBe(50);
    mirror.stop();
    peer.destroy();
  });
});

describe("a server-side write to a diagram (NT-129)", () => {
  function stored() {
    const scene = migrateLegacyCanvas(SOURCE);
    const document: NmlDocument = {
      ...fixture(scene),
      blocks: [...fixture(scene).blocks, { id: "other", type: "canvas", props: {}, children: [], scene: migrateLegacyCanvas(SOURCE) }],
    };
    const doc = createNmlYDoc(document);
    writeCompatibilityRoot(doc, document);
    for (const id of ["diagram", "other"]) {
      doc.transact(() => populateCanvas(doc.getMap<unknown>(canvasMapName(id)), migrateLegacyCanvas(SOURCE)), CANVAS_MIGRATE);
    }
    return doc;
  }

  it("puts the agent's change into the maps, keeps shapes NML had not heard of, and stamps the prop", async () => {
    const editor = BlockNoteEditor.create({ schema: readerSchema }) as unknown as BlockNoteEditor;
    editors.push(editor);
    const doc = stored();
    const maps = doc.getMap<unknown>(canvasMapName("diagram"));
    const other = doc.getMap<unknown>(canvasMapName("other"));
    // A move made before NT-129 that never reached NML.
    draw(doc, maps, (scene) => { shape(scene, "b2").x = 500; });
    draw(doc, other, (scene) => { shape(scene, "a1").x = 77; });
    const otherProp = (yXmlFragmentToBlocks(editor, doc.getXmlFragment("prosemirror")) as Array<{ id: string; props: { data?: string } }>)
      .find((block) => block.id === "other")!.props.data;
    const edit = maps.get(CANVAS_EDIT_KEY);

    const before = decodeNmlDocument(doc);
    const moved = structuredClone(nmlScene(doc));
    shape(moved, "a1").y = 200;
    shape(moved, "a1").label = "Agent";
    await executeNmlCommands({
      doc,
      documentId: "served-diagram",
      commands: compileCanvasSceneChange("diagram", nmlScene(doc), moved).commands,
      idempotencyKey: "mcp",
      origin: { version: 1, transactionId: "mcp", actor: { kind: "model", userId: "drawer" }, command: "mcp-edit" },
      authorize: () => true,
    });
    writeCompatibilityRoot(doc, before);

    const now = materializeCanvas(maps);
    expect(shape(now, "a1")).toMatchObject({ y: 200, label: "Agent" });
    expect(shape(now, "b2").x).toBe(500);
    expect(maps.get(CANVAS_EDIT_KEY)).not.toBe(edit);
    const data = prop(editor, doc);
    expect(data).toBe(serializeScene(now));
    expect(maps.get(CANVAS_MIRROR_KEY)).toBe(mirrorStamp(data));
    // A diagram the write did not touch keeps the mirror its binding wrote.
    expect(materializeCanvas(other).nodes[0].x).toBe(77);
    expect((yXmlFragmentToBlocks(editor, doc.getXmlFragment("prosemirror")) as Array<{ id: string; props: { data?: string } }>)
      .find((block) => block.id === "other")!.props.data).toBe(otherProp);
    doc.destroy();
  });
});
