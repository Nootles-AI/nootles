import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { migrateStoredDocument } from "./persistence";
import { executeNmlCommands, type NmlCommand } from "./commands";
import { decodeNmlDocument, NML_YJS_ROOT } from "./yjs";
import type { LegacyBlock } from "./legacy";

/**
 * Step 13 — serving NML. The one property the served editor must hold that the
 * migration alone does not: once authority moves to the NML root, human edits
 * commit NML commands against that root and the legacy `prosemirror` root is
 * never written again (NML is the cohort's sole tree). In production this is
 * structural — `NmlServedEditor` mounts the NML view, not BlockNote, so nothing
 * touches the ProseMirror fragment — and at the data layer it holds because the
 * command executor writes only the `nml` root. This pins that.
 */
const authorize = () => true;

const BLOCKS: LegacyBlock[] = [
  { id: "p1", type: "paragraph", content: [{ type: "text", text: "hello", styles: {} }] },
];

function legacyDoc() {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("legacy body")]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  return doc;
}

describe("serving NML — the legacy root is never written again", () => {
  it("keeps the ProseMirror root byte-stable across a post-migration NML edit", async () => {
    // A legacy page, migrated to carry a canonical NML root beside it.
    const base = legacyDoc();
    const migrated = migrateStoredDocument({
      baseUpdates: [Y.encodeStateAsUpdate(base)],
      blocks: BLOCKS,
      documentId: "doc-1",
    });
    base.destroy();
    if (migrated.status !== "migrated") throw new Error(`expected migration: ${migrated.reason}`);

    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(legacyDoc()));
    Y.applyUpdate(doc, migrated.update);
    const proseMirrorBefore = doc.getXmlFragment("prosemirror").toString();

    // A served human edit: an NML command against the canonical root.
    const commands: NmlCommand[] = [
      { type: "replaceInline", nodeId: "p1", range: { from: 0, to: 0 }, content: [{ type: "text", text: "edited ", marks: [] }] },
    ];
    await executeNmlCommands({
      doc,
      documentId: "doc-1",
      commands,
      origin: { version: 1, transactionId: "t1", actor: { userId: "u1", kind: "human" }, command: "plain-text-edit" },
      idempotencyKey: "r1",
      authorize,
    });

    // The NML root took the edit…
    const block = decodeNmlDocument(doc).blocks[0];
    const text = "content" in block ? block.content.map((n) => (n.type === "text" ? n.text : "")).join("") : "";
    expect(text).toBe("edited hello");
    expect(doc.getMap(NML_YJS_ROOT).size).toBeGreaterThan(0);
    // …and the legacy ProseMirror root did not move.
    expect(doc.getXmlFragment("prosemirror").toString()).toBe(proseMirrorBefore);
    doc.destroy();
  });
});
