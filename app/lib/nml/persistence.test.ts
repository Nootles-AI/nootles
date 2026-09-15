import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { canvasMapName, populateCanvas } from "@/app/components/editor/canvas/collab/ymap";
import {
  canvasSceneFromMirror,
  createNmlYDoc,
  decodeNmlDocument,
  detectNmlDivergence,
  migrateStoredDocument,
  nmlRootPresent,
  NML_YJS_ROOT,
  readStoredNml,
  serializeDocument,
  storedNmlVersions,
  type LegacyBlock,
  type LegacyDocumentInput,
} from ".";

const fixturesDir = fileURLToPath(new URL("./__fixtures__/legacy", import.meta.url));
const loadFixture = (name: string): LegacyDocumentInput =>
  JSON.parse(readFileSync(`${fixturesDir}/${name}`, "utf8")) as LegacyDocumentInput;

/** Deterministic ID minter so a conversion and its re-conversion mint identical IDs. */
const counter = () => {
  let n = 0;
  return () => `mint-${n++}`;
};
const options = () => ({ createId: counter() });

/** A stored page Y.Doc that already carries a ProseMirror root, like production. */
function baseWithProseMirror(): { doc: Y.Doc; updates: Uint8Array[]; pmText: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("legacy body")]);
  fragment.insert(0, [paragraph]);
  return { doc, updates: [Y.encodeStateAsUpdate(doc)], pmText: fragment.toString() };
}

function applyAll(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

describe("nml persistence — migration", () => {
  it("adds an NML root beside the legacy ProseMirror root without touching it", () => {
    const base = baseWithProseMirror();
    const result = migrateStoredDocument({
      baseUpdates: base.updates,
      blocks: loadFixture("rich-text.json").blocks,
      documentId: "doc-1",
      options: options(),
    });
    expect(result.status).toBe("migrated");
    if (result.status !== "migrated") return;
    expect(result.report.ok).toBe(true);
    expect(result.schemaVersion).toBe(1);
    expect(result.encodingVersion).toBe(1);

    const after = applyAll([...base.updates, result.update]);
    // The delta only introduces the NML root; the ProseMirror body is byte-stable.
    expect(after.getXmlFragment("prosemirror").toString()).toBe(base.pmText);
    expect(after.getMap(NML_YJS_ROOT).size).toBeGreaterThan(0);
    expect(serializeDocument(decodeNmlDocument(after))).toBe(serializeDocument(result.document));
    base.doc.destroy();
    after.destroy();
  });

  it("re-migrating an already-migrated document is rejected, not double-written", () => {
    const base = baseWithProseMirror();
    const first = migrateStoredDocument({
      baseUpdates: base.updates,
      blocks: loadFixture("rich-text.json").blocks,
      documentId: "doc-1",
      options: options(),
    });
    expect(first.status).toBe("migrated");
    if (first.status !== "migrated") return;
    const migrated = [...base.updates, first.update];
    expect(nmlRootPresent(migrated)).toBe(true);

    const second = migrateStoredDocument({
      baseUpdates: migrated,
      blocks: loadFixture("rich-text.json").blocks,
      documentId: "doc-1",
      options: options(),
    });
    expect(second).toMatchObject({ status: "rejected", reason: "already-migrated" });
    base.doc.destroy();
  });

  it("rejects a document that exceeds the 10k-block limit and writes nothing", () => {
    const blocks: LegacyBlock[] = Array.from({ length: 10_001 }, (_, i) => ({
      id: `p${i}`,
      type: "paragraph",
      content: [{ type: "text", text: "x", styles: {} }],
    }));
    const result = migrateStoredDocument({ baseUpdates: [], blocks, documentId: "big", options: options() });
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("limit-exceeded");
    expect(result.report.limitViolations.some((v) => v.code === "block_count_limit")).toBe(true);
  });

  it("rejects a document nested deeper than the 4-level limit", () => {
    // Toggles own their children, so 6 nested toggles are 6 levels deep.
    let block: LegacyBlock = { id: "t5", type: "toggleListItem", content: [{ type: "text", text: "deep", styles: {} }] };
    for (let level = 4; level >= 0; level--) {
      block = { id: `t${level}`, type: "toggleListItem", content: [{ type: "text", text: "x", styles: {} }], children: [block] };
    }
    const result = migrateStoredDocument({ baseUpdates: [], blocks: [block], documentId: "deep", options: options() });
    expect(result).toMatchObject({ status: "rejected", reason: "limit-exceeded" });
  });
});

describe("nml persistence — mixed-version reader", () => {
  it("reads none, then the decoded document after migration, with its versions", () => {
    const base = baseWithProseMirror();
    expect(readStoredNml(base.updates)).toEqual({ status: "none" });
    expect(storedNmlVersions(base.updates)).toBeNull();

    const result = migrateStoredDocument({
      baseUpdates: base.updates,
      blocks: loadFixture("rich-text.json").blocks,
      documentId: "doc-1",
      options: options(),
    });
    if (result.status !== "migrated") throw new Error("expected migration");
    const migrated = [...base.updates, result.update];

    const read = readStoredNml(migrated);
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(serializeDocument(read.document)).toBe(serializeDocument(result.document));
    expect(storedNmlVersions(migrated)).toEqual({ encodingVersion: 1, schemaVersion: 1 });
    base.doc.destroy();
  });

  it("fails closed to read-only on a newer encoding version (no downgrade write)", () => {
    const doc = createNmlYDoc({ schemaVersion: 1, documentId: "doc-1", blocks: [] });
    doc.getMap<unknown>(NML_YJS_ROOT).set("encodingVersion", 2);
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();
    const read = readStoredNml(updates);
    expect(read.status).toBe("unsupported");
  });
});

describe("nml persistence — canvas parity", () => {
  it("passes when the live per-shape maps agree with the converted scene", () => {
    const input = loadFixture("canvas-html.json");
    const data = String((input.blocks[0].props as { data: string }).data);
    const doc = new Y.Doc();
    populateCanvas(doc.getMap(canvasMapName("canvas1")) as Y.Map<unknown>, canvasSceneFromMirror(data));
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();

    const result = migrateStoredDocument({ baseUpdates: updates, blocks: input.blocks, documentId: "doc-1", options: options() });
    expect(result.status).toBe("migrated");
    if (result.status === "migrated") expect(result.report.canvasMismatches).toEqual([]);
  });

  it("rejects when the live maps have drifted from the mirror the converter reads", () => {
    const input = loadFixture("canvas-html.json");
    const data = String((input.blocks[0].props as { data: string }).data);
    const scene = canvasSceneFromMirror(data);
    const drifted = { ...scene, nodes: scene.nodes.map((n, i) => (i === 0 ? { ...n, x: (n as { x: number }).x + 999 } : n)) };
    const doc = new Y.Doc();
    populateCanvas(doc.getMap(canvasMapName("canvas1")) as Y.Map<unknown>, drifted);
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();

    const result = migrateStoredDocument({ baseUpdates: updates, blocks: input.blocks, documentId: "doc-1", options: options() });
    expect(result).toMatchObject({ status: "rejected", reason: "canvas-divergence" });
  });
});

describe("nml persistence — rollback divergence", () => {
  it("reports in-sync when the NML root still matches a fresh legacy conversion", () => {
    const blocks = loadFixture("rich-text.json").blocks;
    const result = migrateStoredDocument({ baseUpdates: [], blocks, documentId: "doc-1", options: options() });
    if (result.status !== "migrated") throw new Error("expected migration");
    const divergence = detectNmlDivergence({ baseUpdates: [result.update], blocks, options: options() });
    expect(divergence).toMatchObject({ diverged: false, reason: "in-sync" });
  });

  it("flags NML-only edits the legacy tree cannot reproduce, so rollback preserves them", () => {
    const blocks = loadFixture("rich-text.json").blocks;
    // A persisted NML root carrying an edit that re-converting the legacy blocks
    // does not produce — the "edits legacy PM cannot represent" rollback case.
    const edited = createNmlYDoc({
      schemaVersion: 1,
      documentId: "doc-1",
      blocks: [{ id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "only in NML", marks: [] }], children: [] }],
    });
    const updates = [Y.encodeStateAsUpdate(edited)];
    edited.destroy();
    const divergence = detectNmlDivergence({ baseUpdates: updates, blocks, options: options() });
    expect(divergence.diverged).toBe(true);
    expect(divergence.reason).toBe("nml-only-edits");
  });

  it("stays in-sync across independent createId sequences (minted IDs are not divergence)", () => {
    // rich-text mints IDs for its inline math; a real rollback re-converts with a
    // fresh minter, so the check must be mint-insensitive rather than serialization equality.
    const blocks = loadFixture("rich-text.json").blocks;
    const result = migrateStoredDocument({ baseUpdates: [], blocks, documentId: "doc-1", options: { createId: counter() } });
    if (result.status !== "migrated") throw new Error("expected migration");
    const divergence = detectNmlDivergence({ baseUpdates: [result.update], blocks, options: { createId: counter() } });
    expect(divergence).toMatchObject({ diverged: false, reason: "in-sync" });
  });

  it("treats a no-root document as safe to roll back", () => {
    expect(detectNmlDivergence({ baseUpdates: [], blocks: [] })).toMatchObject({ diverged: false, reason: "no-nml-root" });
  });
});
