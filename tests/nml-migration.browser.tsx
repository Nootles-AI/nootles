import * as Y from "yjs";
import {
  canvasSceneFromMirror,
  createNmlYDoc,
  decodeNmlDocument,
  detectNmlDivergence,
  migrateStoredDocument,
  NML_YJS_ROOT,
  readStoredNml,
  storedNmlVersions,
  type LegacyBlock,
} from "@/app/lib/nml";
import { canvasMapName, populateCanvas } from "@/app/components/editor/canvas/collab/ymap";
import canvasFixture from "@/app/lib/nml/__fixtures__/legacy/canvas-html.json";

/**
 * Step 12 in real Chromium. The migration engine, the mixed-version reader, and
 * rollback divergence detection all run in the browser runtime — canvas HTML is
 * parsed by the platform's own DOMParser, and a genuine two-Y.Doc collaboration
 * then a reload prove the dual root survives the real CRDT path. No backend, no
 * network, no keys: the Convex election/cohort/rollback logic is proven under
 * convex-test; this proves the browser half behaves the same as Node.
 */

const parseHtml = (html: string): Document => new DOMParser().parseFromString(html, "text/html");
const options = () => {
  let n = 0;
  return { createId: () => `mint-${n++}`, parseHtml };
};

const TEXT_BLOCKS: LegacyBlock[] = [
  { id: "h1", type: "heading", props: { level: 2 }, content: [{ type: "text", text: "Migrated heading", styles: {} }] },
  {
    id: "p1",
    type: "paragraph",
    content: [
      { type: "text", text: "Body with a ", styles: {} },
      { type: "link", href: "https://nootles.ai", content: [{ type: "text", text: "link", styles: {} }] },
    ],
  },
];

function toU8(u: Uint8Array): Uint8Array {
  return u;
}

function apply(updates: readonly Uint8Array[]): Y.Doc {
  const doc = new Y.Doc();
  for (const update of updates) Y.applyUpdate(doc, update);
  return doc;
}

/** A stored page Y.Doc with a ProseMirror root, and optionally live canvas maps. */
function baseDoc(canvas: boolean): { updates: Uint8Array[]; pmText: string } {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prosemirror");
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("legacy body")]);
  fragment.insert(0, [paragraph]);
  if (canvas) {
    const data = String((canvasFixture.blocks[0].props as { data: string }).data);
    populateCanvas(doc.getMap(canvasMapName("canvas1")) as Y.Map<unknown>, canvasSceneFromMirror(data, parseHtml));
  }
  const updates = [toU8(Y.encodeStateAsUpdate(doc))];
  const pmText = fragment.toString();
  doc.destroy();
  return { updates, pmText };
}

function paragraph(text: string): Y.XmlElement {
  const element = new Y.XmlElement("paragraph");
  element.insert(0, [new Y.XmlText(text)]);
  return element;
}

const api = {
  /** Migrate a text page; the delta must add the NML root and leave the PM root byte-stable. */
  migrateText() {
    const base = baseDoc(false);
    const result = migrateStoredDocument({ baseUpdates: base.updates, blocks: TEXT_BLOCKS, documentId: "doc-1", options: options() });
    if (result.status !== "migrated") return { status: result.status, reason: result.reason };
    const after = apply([...base.updates, result.update]);
    const decoded = decodeNmlDocument(after);
    const out = {
      status: "migrated" as const,
      ok: result.report.ok,
      pmIntact: after.getXmlFragment("prosemirror").toString() === base.pmText,
      nmlPresent: after.getMap(NML_YJS_ROOT).size > 0,
      firstBlockId: decoded.blocks[0].id,
      blockCount: decoded.blocks.length,
      versions: storedNmlVersions([...base.updates, result.update]),
    };
    after.destroy();
    return out;
  },

  /** Migrate a canvas page whose scene the platform DOMParser materializes; parity must hold. */
  migrateCanvas() {
    const base = baseDoc(true);
    const result = migrateStoredDocument({
      baseUpdates: base.updates,
      blocks: canvasFixture.blocks as LegacyBlock[],
      documentId: "doc-1",
      options: options(),
    });
    if (result.status !== "migrated") return { status: result.status, reason: result.reason, canvasMismatches: -1 };
    return { status: "migrated" as const, ok: result.report.ok, canvasMismatches: result.report.canvasMismatches.length };
  },

  /** Two clients edit the legacy root after migration; both edits converge and the NML root reloads. */
  collaborateReload() {
    const base = baseDoc(false);
    const migration = migrateStoredDocument({ baseUpdates: base.updates, blocks: TEXT_BLOCKS, documentId: "doc-1", options: options() });
    if (migration.status !== "migrated") return { migrated: false };
    const stored = [...base.updates, migration.update];

    const a = apply(stored);
    const b = apply(stored);
    const aBefore = Y.encodeStateVector(a);
    a.getXmlFragment("prosemirror").insert(1, [paragraph("A edit")]);
    const aUpdate = Y.encodeStateAsUpdate(a, aBefore);
    const bBefore = Y.encodeStateVector(b);
    b.getXmlFragment("prosemirror").insert(1, [paragraph("B edit")]);
    const bUpdate = Y.encodeStateAsUpdate(b, bBefore);
    Y.applyUpdate(a, bUpdate);
    Y.applyUpdate(b, aUpdate);
    const converged = a.getXmlFragment("prosemirror").toString() === b.getXmlFragment("prosemirror").toString();

    const reloaded = apply([...stored, aUpdate, bUpdate]);
    const body = reloaded.getXmlFragment("prosemirror").toString();
    const out = {
      migrated: true,
      converged,
      hasA: body.includes("A edit"),
      hasB: body.includes("B edit"),
      nmlPresent: reloaded.getMap(NML_YJS_ROOT).size > 0,
      decodeOk: decodeNmlDocument(reloaded).blocks[0].id === "h1",
    };
    a.destroy();
    b.destroy();
    reloaded.destroy();
    return out;
  },

  /** A newer encoding version reads as read-only rather than being downgrade-written. */
  downgrade() {
    const doc = createNmlYDoc({ schemaVersion: 1, documentId: "doc-1", blocks: [] });
    doc.getMap<unknown>(NML_YJS_ROOT).set("encodingVersion", 2);
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();
    return { read: readStoredNml(updates).status };
  },

  /** Rollback safety: an in-sync root vs one holding NML-only edits legacy cannot reproduce. */
  rollback() {
    const inSync = migrateStoredDocument({ baseUpdates: [], blocks: TEXT_BLOCKS, documentId: "doc-1", options: options() });
    if (inSync.status !== "migrated") return { ok: false };
    const inSyncResult = detectNmlDivergence({ baseUpdates: [inSync.update], blocks: TEXT_BLOCKS, options: options() });

    const edited = createNmlYDoc({
      schemaVersion: 1,
      documentId: "doc-1",
      blocks: [{ id: "p1", type: "paragraph", props: {}, content: [{ type: "text", text: "only in NML", marks: [] }], children: [] }],
    });
    const editedUpdates = [Y.encodeStateAsUpdate(edited)];
    edited.destroy();
    const divergedResult = detectNmlDivergence({ baseUpdates: editedUpdates, blocks: TEXT_BLOCKS, options: options() });

    return { ok: true, inSync: inSyncResult, diverged: divergedResult };
  },
};

declare global {
  interface Window {
    nmlMigration: typeof api;
  }
}

window.nmlMigration = api;
const root = document.getElementById("app");
if (root) root.dataset.ready = "true";
