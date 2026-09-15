import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import {
  createNmlYDoc,
  NML_YJS_ROOT,
  verifyStoredNmlRoot,
  type NmlBlock,
} from ".";

/** A page Y.Doc that carries only a legacy ProseMirror root, like production. */
function baseWithProseMirror(): Uint8Array[] {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("legacy body")]);
  doc.getXmlFragment("prosemirror").insert(0, [paragraph]);
  const updates = [Y.encodeStateAsUpdate(doc)];
  doc.destroy();
  return updates;
}

const paragraph = (id: string, text: string): NmlBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, marks: [] }],
  children: [],
});

function rootUpdates(blocks: NmlBlock[]): Uint8Array[] {
  const doc = createNmlYDoc({ schemaVersion: 1, documentId: "doc-1", blocks });
  const updates = [Y.encodeStateAsUpdate(doc)];
  doc.destroy();
  return updates;
}

describe("verifyStoredNmlRoot — step 13 server-side re-assertion", () => {
  it("verifies a well-formed root and reports its declared versions", () => {
    const verdict = verifyStoredNmlRoot(rootUpdates([paragraph("p1", "hello")]));
    expect(verdict).toEqual({
      ok: true,
      reason: "verified",
      schemaVersion: 1,
      encodingVersion: 1,
      limitCodes: [],
      errorCodes: [],
    });
  });

  it("fails when there is no NML root at all (legacy-only page)", () => {
    const verdict = verifyStoredNmlRoot(baseWithProseMirror());
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("no-root");
  });

  it("fails a decodable root that exceeds a v1 size limit — the check the client can lie about", () => {
    // 10,001 blocks encodes and decodes fine (writeNmlDocument only runs the
    // structural Zod schema, not the count limit), so only validateDocument
    // catches it — exactly why the server must re-run validation, not trust the
    // migrator's limitOk flag.
    const blocks = Array.from({ length: 10_001 }, (_, i) => paragraph(`p${i}`, "x"));
    const verdict = verifyStoredNmlRoot(rootUpdates(blocks));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("limit-exceeded");
    expect(verdict.limitCodes).toContain("block_count_limit");
  });

  it("fails closed to unsupported on a newer encoding version (no downgrade read)", () => {
    const doc = createNmlYDoc({ schemaVersion: 1, documentId: "doc-1", blocks: [paragraph("p1", "x")] });
    doc.getMap<unknown>(NML_YJS_ROOT).set("encodingVersion", 2);
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();
    const verdict = verifyStoredNmlRoot(updates);
    expect(verdict).toMatchObject({ ok: false, reason: "unsupported" });
  });

  it("fails closed to unsupported on a structurally invalid root", () => {
    // A root whose declared schemaVersion is not the frozen v1 literal — decode
    // fails the runtime schema and must not be normalized or served.
    const doc = createNmlYDoc({ schemaVersion: 1, documentId: "doc-1", blocks: [paragraph("p1", "x")] });
    doc.getMap<unknown>(NML_YJS_ROOT).set("schemaVersion", 2);
    const updates = [Y.encodeStateAsUpdate(doc)];
    doc.destroy();
    const verdict = verifyStoredNmlRoot(updates);
    expect(verdict).toMatchObject({ ok: false, reason: "unsupported" });
  });
});
