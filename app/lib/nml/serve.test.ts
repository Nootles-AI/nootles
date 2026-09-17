import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { migrateStoredDocument } from "./persistence";
import { executeNmlCommands, type NmlCommand } from "./commands";
import { decodeNmlDocument, NML_YJS_ROOT } from "./yjs";
import type { LegacyBlock } from "./legacy";

/**
 * Step 13 — serving NML. The semantic command executor is deliberately isolated
 * from the derived BlockNote compatibility view: applying a command changes only
 * canonical NML. The production mirror subsequently projects that canonical
 * transaction into `prosemirror` for the full editor surface and stale clients.
 * This test pins the executor boundary; mirror convergence is covered separately
 * in `mirror.test.ts` and `mirrorBlockNote.test.ts`.
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

describe("serving NML — semantic executor boundary", () => {
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
    // …and the executor itself did not mutate the derived ProseMirror view.
    expect(doc.getXmlFragment("prosemirror").toString()).toBe(proseMirrorBefore);
    doc.destroy();
  });
});
