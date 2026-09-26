import { DOMParser, parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { CanvasCollab } from "@/app/components/editor/canvas/collab/binding";
import { keyForIndex } from "@/app/components/editor/canvas/collab/order";
import {
  CANVAS_EDIT_KEY,
  CANVAS_MIRROR_KEY,
  canvasMapName,
  materializeCanvas,
  mirrorStamp,
  populateCanvas,
} from "@/app/components/editor/canvas/collab/ymap";
import { SceneStore } from "@/app/components/editor/canvas/engine/useScene";
import { normalizeDiagram } from "@/app/components/editor/canvas/scene/band";
import { emptyScene, migrateLegacyCanvas, readCanvasSource } from "@/app/components/editor/canvas/scene/migrate";
import type { ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import { canvasSceneFromMaps, compareScenes } from "@/app/lib/nml/legacy";
import {
  decodeNmlDocument,
  NML_YJS_ROOT,
  NML_YJS_STRUCTURE_KEY,
  nmlBlockToY,
  nmlCanvasFromY,
  nmlYMapOf,
  writeNmlDocument,
} from "@/app/lib/nml/yjs";
import type { NmlBlock, NmlDocument } from "@/app/lib/nml/schema";
import { FIXTURES } from "@/tests/canvas-fixtures";
import legacyHtml from "@/app/lib/nml/__fixtures__/legacy/canvas-html.json";
import legacyJson from "@/app/lib/nml/__fixtures__/legacy/canvas-legacy-json.json";
import { normalizeDiagramsInDoc } from "./diagramBand";

/**
 * The one-time rewrite of a page's diagrams, on a page that holds every kind
 * of copy there is: a diagram with maps, one only ever stored as its prop
 * (nested under a paragraph), the NML root's copies of both, a copy the NML
 * root has deleted, and a storyboard in each tree.
 */

// The binding parses mirrors itself, with no parser to inject.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const parseHtml: ParseHtml = (html) => parseHTML(html).document as unknown as Document;

/** Past the column, so it turns wide; its shapes stay where they are. */
const MAPPED = `<nt-diagram w="960" h="540">
  <nt-rect id="a" x="40" y="40" w="160" h="90" style="background: #f4c7c3"></nt-rect>
  <nt-rect id="b" x="820" y="40" w="120" h="90" style="background: #c3d7f4"></nt-rect>
  <nt-edge id="e" from="a" to="b"></nt-edge>
</nt-diagram>`;

/** Pinned by hand, and drawn above the top: it moves down into its band. */
const PROP_ONLY = `<nt-diagram w="640" h="360" data-width="fixed" data-height="fixed">
  <nt-rect id="x" x="-60" y="-20" w="100" h="50"></nt-rect>
</nt-diagram>`;

const SHOT = `<nt-diagram w="320" h="180"><nt-rect id="s" x="10" y="10" w="40" h="40"></nt-rect></nt-diagram>`;

const EDIT_TOKEN = "old.1";

function container(id: string, content: Y.XmlElement, children?: Y.XmlElement): Y.XmlElement {
  const block = new Y.XmlElement("blockContainer");
  block.setAttribute("id", id);
  block.insert(0, children ? [content, children] : [content]);
  return block;
}

function node(type: string, attrs: Record<string, string>): Y.XmlElement {
  const element = new Y.XmlElement(type);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function nmlCanvas(id: string, scene: Scene): NmlBlock {
  return { id, type: "canvas", props: {}, scene: { ...scene, id }, children: [] };
}

function page(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const nested = new Y.XmlElement("blockGroup");
    nested.insert(0, [container("p1", node("canvas", { data: PROP_ONLY }))]);
    const group = new Y.XmlElement("blockGroup");
    group.insert(0, [
      container("c1", node("canvas", { data: MAPPED })),
      container("s1", node("storyboard", { data: SHOT })),
      container("t1", node("paragraph", {}), nested),
    ]);
    doc.getXmlFragment("prosemirror").insert(0, [group]);

    const root = doc.getMap<unknown>(canvasMapName("c1"));
    populateCanvas(root, readCanvasSource(MAPPED, parseHtml));
    root.set(CANVAS_EDIT_KEY, EDIT_TOKEN);
    root.set(CANVAS_MIRROR_KEY, mirrorStamp(MAPPED));
  });

  const nml: NmlDocument = {
    schemaVersion: 1,
    documentId: "doc-1",
    blocks: [
      nmlCanvas("c1", readCanvasSource(MAPPED, parseHtml)),
      { id: "s1", type: "storyboard", props: {}, domain: { id: "s1", ratio: "16:9", shots: [{ scene: SHOT, note: "Shot" }] }, children: [] },
    ],
  };
  writeNmlDocument(doc, nml);
  doc.transact(() => {
    const structure = doc.getMap<unknown>(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<unknown>>;
    const registry = structure.get("registry")!;
    const placements = structure.get("placements")!;
    registry.set("p1", nmlBlockToY(nmlCanvas("p1", readCanvasSource(PROP_ONLY, parseHtml))));
    placements.set("p1", nmlYMapOf({ parentId: null, orderKey: keyForIndex(2) }));
    registry.set("gone", nmlBlockToY(nmlCanvas("gone", readCanvasSource(PROP_ONLY, parseHtml))));
    placements.set("gone", nmlYMapOf({ parentId: null, orderKey: keyForIndex(3) }));
    (structure.get("deletions") as Y.Map<unknown>).set("gone", true);
  });
  return doc;
}

/** A block's content node, by its container's id. */
function content(doc: Y.Doc, id: string): Y.XmlElement {
  const walker = doc
    .getXmlFragment("prosemirror")
    .createTreeWalker((n) => n instanceof Y.XmlElement && n.nodeName === "blockContainer" && n.getAttribute("id") === id);
  const found = [...walker][0] as Y.XmlElement;
  return found.get(0) as Y.XmlElement;
}

const prop = (doc: Y.Doc, id: string) => content(doc, id).getAttribute("data") as string;

function nmlScene(doc: Y.Doc, id: string): Scene {
  const block = decodeNmlDocument(doc).blocks.find((b) => b.id === id);
  if (block?.type !== "canvas") throw new Error(`no NML canvas ${id}`);
  return block.scene;
}

function rewrite(doc: Y.Doc) {
  const updates: Uint8Array[] = [];
  const listen = (update: Uint8Array) => void updates.push(update);
  doc.on("update", listen);
  const report = normalizeDiagramsInDoc(doc, parseHtml);
  doc.off("update", listen);
  return { report, updates };
}

describe("normalizeDiagramsInDoc", () => {
  test("rewrites every copy in one update, and reports it", () => {
    const doc = page();
    const { report, updates } = rewrite(doc);
    expect(updates).toHaveLength(1);
    expect(report).toMatchObject({ diagrams: 2, maps: 1, props: 2, nml: 2, wide: 2 });
    expect(report.samples).toEqual([
      { blockId: "c1", before: `<nt-diagram w="960" h="540">`, after: `<nt-diagram h="260" wide>` },
      {
        blockId: "p1",
        before: `<nt-diagram w="640" h="360" data-width="fixed" data-height="fixed">`,
        after: `<nt-diagram h="360" wide>`,
      },
    ]);
  });

  test("the maps become the band, and the prop their stamped mirror; the edit token stays", () => {
    const doc = page();
    rewrite(doc);
    const root = doc.getMap<unknown>(canvasMapName("c1"));
    const band = normalizeDiagram(readCanvasSource(MAPPED, parseHtml));
    expect(materializeCanvas(root)).toEqual(band);
    expect((root.get("meta") as Y.Map<unknown>).has("w")).toBe(false);
    expect(prop(doc, "c1")).toBe(serializeScene(band));
    expect(root.get(CANVAS_MIRROR_KEY)).toBe(mirrorStamp(prop(doc, "c1")));
    expect(root.get(CANVAS_EDIT_KEY)).toBe(EDIT_TOKEN);
  });

  test("a diagram stored only as its prop is rewritten there, and given no maps", () => {
    const doc = page();
    rewrite(doc);
    expect(prop(doc, "p1")).toBe(serializeScene(migrateLegacyCanvas(PROP_ONLY, parseHtml)));
    expect(migrateLegacyCanvas(prop(doc, "p1"), parseHtml).nodes[0]).toMatchObject({ x: -60, y: 0 });
    expect(doc.share.has(canvasMapName("p1"))).toBe(false);
  });

  test("each NML copy is normalized from itself, and parity holds", () => {
    const doc = page();
    rewrite(doc);
    expect(compareScenes(canvasSceneFromMaps(doc, "c1")!, nmlScene(doc, "c1"))).toEqual([]);
    expect(compareScenes(migrateLegacyCanvas(prop(doc, "p1"), parseHtml), nmlScene(doc, "p1"))).toEqual([]);
    const registry = (doc.getMap<unknown>(NML_YJS_ROOT).get(NML_YJS_STRUCTURE_KEY) as Y.Map<Y.Map<unknown>>).get("registry")!;
    const gone = registry.get("gone") as Y.Map<unknown>;
    expect(nmlCanvasFromY(gone.get("scene"), ["gone"])).toMatchObject({ w: 640, h: 360, attrs: { "data-width": "fixed" } });
  });

  test("storyboards are left as they were", () => {
    const doc = page();
    rewrite(doc);
    expect(prop(doc, "s1")).toBe(SHOT);
    const story = decodeNmlDocument(doc).blocks.find((b) => b.id === "s1");
    expect(story?.type === "storyboard" && story.domain.shots[0].scene).toBe(SHOT);
  });

  test("a second pass finds nothing to do", () => {
    const doc = page();
    rewrite(doc);
    const { report, updates } = rewrite(doc);
    expect(updates).toHaveLength(0);
    expect(report).toMatchObject({ diagrams: 2, maps: 0, props: 0, nml: 0, wide: 0, samples: [] });
  });

  test("maps already a band, ahead of a band prop, are left for their own mirror", () => {
    const doc = new Y.Doc();
    const band = normalizeDiagram(readCanvasSource(MAPPED, parseHtml));
    const behind = serializeScene(band);
    const ahead: Scene = { ...band, nodes: band.nodes.map((n) => (n.id === "a" ? { ...n, x: n.x + 20 } : n)) };
    doc.transact(() => {
      doc.getXmlFragment("prosemirror").insert(0, [container("c1", node("canvas", { data: behind }))]);
      const root = doc.getMap<unknown>(canvasMapName("c1"));
      populateCanvas(root, ahead);
      root.set(CANVAS_MIRROR_KEY, mirrorStamp(behind));
    });
    const { report, updates } = rewrite(doc);
    expect(updates).toHaveLength(0);
    expect(report).toMatchObject({ diagrams: 1, maps: 0, props: 0 });
    expect(prop(doc, "c1")).toBe(behind);

    // Under a prop still in the old form, the same maps do get their mirror.
    content(doc, "c1").setAttribute("data", MAPPED);
    expect(rewrite(doc).report).toMatchObject({ maps: 0, props: 1 });
    expect(prop(doc, "c1")).toBe(serializeScene(ahead));
    expect(doc.getMap<unknown>(canvasMapName("c1")).get(CANVAS_MIRROR_KEY)).toBe(mirrorStamp(serializeScene(ahead)));
  });

  test("a blank diagram is not given a band it never asked for", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("prosemirror").insert(0, [container("e1", node("canvas", { data: "" }))]);
    expect(rewrite(doc).updates).toHaveLength(0);
  });

  test("a prop that is a band already, or no diagram at all, is left as written", () => {
    const loose = `<nt-diagram  h="96"><nt-rect id="a" x="0" y="24" w="10" h="10"></nt-rect></nt-diagram>`;
    const stray = `<p>not a diagram</p>`;
    const doc = new Y.Doc();
    doc.getXmlFragment("prosemirror").insert(0, [
      container("b1", node("canvas", { data: loose })),
      container("x1", node("canvas", { data: stray })),
    ]);
    expect(rewrite(doc).updates).toHaveLength(0);
    expect([prop(doc, "b1"), prop(doc, "x1")]).toEqual([loose, stray]);
  });

  test("an old graph with nothing drawn becomes a blank band", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment("prosemirror").insert(0, [container("j1", node("canvas", { data: `{"nodes":[],"edges":[]}` }))]);
    rewrite(doc);
    expect(prop(doc, "j1")).toBe(serializeScene(normalizeDiagram(emptyScene())));
  });
});

describe("a peer with the diagram open", () => {
  const RELAY = { relay: true };

  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  /** The server's copy and a peer's, each relaying its own updates to the other. */
  function network() {
    const server = page();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
    for (const [from, to] of [
      [server, peer],
      [peer, server],
    ]) {
      from.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== RELAY) Y.applyUpdate(to, update, RELAY);
      });
    }
    const collab = new CanvasCollab("c1");
    collab.attach(peer, prop(peer, "c1"));
    const store = new SceneStore(collab.seed(prop(peer, "c1")));
    store.setWriter((html, scene) => collab.writeLocal(html, scene));
    collab.setStore(store);
    let clears = 0;
    store.onHistory((event) => void (event.type === "clear" && (clears += 1)));
    return { server, peer, collab, store, clears: () => clears };
  }

  test("hears the rewrite of its maps as nothing new", () => {
    const { server, peer, collab, store, clears } = network();
    const before = store.getScene();
    expect(rewrite(server).report.maps).toBe(1);
    collab.adoptExternal(prop(peer, "c1"));
    expect(store.getScene()).toBe(before);
    expect(clears()).toBe(0);
  });

  test("mid-session, keeps its undo", () => {
    const { server, peer, collab, store, clears } = network();
    const a = store.getNode("a")!;
    store.begin();
    store.dispatch({ type: "resize", frames: [{ id: "a", x: 60, y: a.y, w: a.w, h: a.h }] });
    store.commit();
    const before = store.getScene();
    rewrite(server);
    collab.adoptExternal(prop(peer, "c1"));
    expect(store.getScene()).toBe(before);
    expect(store.canUndo()).toBe(true);
    expect(clears()).toBe(0);
    expect(migrateLegacyCanvas(prop(peer, "c1"), parseHtml).nodes[0]).toMatchObject({ id: "a", x: 60 });
  });
});

describe("linkedom reads what the migration writes", () => {
  const [legacyHtmlSource, legacyJsonSource] = [legacyHtml, legacyJson].map((fixture) => fixture.blocks[0].props.data);
  /** [name, source, whether the source is itself canonical — written by the serializer] */
  const sources: [string, string, boolean][] = [
    ...Object.entries(FIXTURES).map(([name, fixture]): [string, string, boolean] => [name, fixture.html, true]),
    ["legacy-html", legacyHtmlSource, false],
    ["legacy-json", legacyJsonSource, false],
    ["mapped", MAPPED, false],
    ["prop-only", PROP_ONLY, false],
  ];

  test.each(sources)("%s: read without loss, and the band it writes reads back as itself", (_name, source, canonical) => {
    if (canonical) expect(serializeScene(readCanvasSource(source, parseHtml))).toBe(source);
    const once = serializeScene(migrateLegacyCanvas(source, parseHtml));
    expect(serializeScene(readCanvasSource(once, parseHtml))).toBe(once);
    expect(serializeScene(migrateLegacyCanvas(once, parseHtml))).toBe(once);
  });
});
