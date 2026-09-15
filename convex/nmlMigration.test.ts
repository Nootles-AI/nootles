/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { joinUpdateRows, splitUpdate } from "./yshape";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import {
  decodeNmlDocument,
  migrateStoredDocument,
  NML_YJS_ROOT,
  type LegacyBlock,
} from "@/app/lib/nml";

/**
 * Step 12 persistence + cohort migration under real auth. The heavy conversion
 * is the headless engine (unit-tested in `app/lib/nml/persistence.test.ts`);
 * here we drive the elected writer, the cohort gate, mixed-version reads, and
 * rollback exactly as the browser would, and prove a migrated document
 * collaborates and reloads with both roots intact.
 */

const modules = import.meta.glob("./**/*.ts");
const componentModules = import.meta.glob(
  "../node_modules/@convex-dev/prosemirror-sync/src/component/**/*.ts",
);

const OWNER = { subject: "user_owner" };
const GUEST = { subject: "user_guest" };

const BLOCKS: LegacyBlock[] = [
  { id: "p1", type: "paragraph", content: [{ type: "text", text: "hello", styles: {} }] },
];

const counter = () => {
  let n = 0;
  return () => `mint-${n++}`;
};

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("prosemirrorSync", componentSchema, componentModules);
  return t;
}

async function world(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: OWNER.subject, title: "P", createdAt: 1, editShareToken: "edit-tok" });
    const docId = crypto.randomUUID();
    await ctx.db.insert("pages", { ownerId: OWNER.subject, projectId, title: "", order: 0, docId, createdAt: 1 });
    return { projectId, docId };
  });
}

async function claimEditor(t: TestConvex<typeof schema>, projectId: Id<"projects">) {
  await t.run(async (ctx) => {
    await ctx.db.insert("shareClaims", { projectId, granteeId: GUEST.subject, role: "editor", grantedRole: "editor", createdAt: 1 });
  });
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** A stored page Y.Doc carrying a ProseMirror root, like a real legacy doc. */
function encodedBase(): ArrayBuffer {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prosemirror");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("legacy")]);
  fragment.insert(0, [p]);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return toArrayBuffer(update);
}

/** A concurrent legacy edit: another paragraph inserted onto the ProseMirror root. */
function editProseMirror(base: ArrayBuffer, text: string): ArrayBuffer {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(base));
  const before = Y.encodeStateVector(doc);
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(text)]);
  doc.getXmlFragment("prosemirror").insert(1, [p]);
  const delta = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return toArrayBuffer(delta);
}

/** The NML-root delta the browser engine would produce for this base + blocks. */
function nmlDelta(docId: string, base: ArrayBuffer) {
  const result = migrateStoredDocument({
    baseUpdates: [new Uint8Array(base)],
    blocks: BLOCKS,
    documentId: docId,
    options: { createId: counter() },
  });
  if (result.status !== "migrated") throw new Error(`expected migration, got ${result.reason}`);
  return result;
}

/** The document a reader rebuilds from stored snapshot + log. */
async function reload(
  as: ReturnType<TestConvex<typeof schema>["withIdentity"]>,
  docId: string,
): Promise<Y.Doc> {
  const meta = await as.query(api.ydoc.meta, { docId });
  const doc = new Y.Doc();
  if (meta && meta.snapshotParts > 0) {
    const parts: ArrayBuffer[] = [];
    for (let part = 0; part < meta.snapshotParts; part++) {
      const chunk = await as.query(api.ydoc.snapshot, { docId, gen: meta.snapshotSeq, part });
      if (chunk) parts.push(chunk);
    }
    const whole = new Uint8Array(parts.reduce((n, c) => n + c.byteLength, 0));
    let at = 0;
    for (const c of parts) {
      whole.set(new Uint8Array(c), at);
      at += c.byteLength;
    }
    Y.applyUpdate(doc, whole);
  }
  let cursor = meta ? meta.snapshotSeq : 0;
  for (;;) {
    const rows = await as.query(api.ydoc.updatesSince, { docId, afterSeq: cursor });
    if (!rows.length) break;
    for (const row of joinUpdateRows(rows)) {
      Y.applyUpdate(doc, new Uint8Array(row.update));
      cursor = Math.max(cursor, row.seq);
    }
    if (cursor < rows[rows.length - 1].seq) break;
  }
  return doc;
}

/** A doc initialized on the Yjs pipeline, in the cohort, ready to migrate. */
async function ready(t: TestConvex<typeof schema>) {
  const { projectId, docId } = await world(t);
  const base = encodedBase();
  const as = t.withIdentity(OWNER);
  await as.mutation(api.ydoc.init, { docId, update: base });
  await as.mutation(api.nmlMigration.addToCohort, { scope: "doc", key: docId });
  return { projectId, docId, base, as };
}

describe("cohort gate", () => {
  test("a document outside the cohort cannot be migrated", async () => {
    const t = harness();
    const { projectId, docId } = await world(t);
    const base = encodedBase();
    const as = t.withIdentity(OWNER);
    await as.mutation(api.ydoc.init, { docId, update: base });
    const result = nmlDelta(docId, base);
    await expect(
      as.mutation(api.nmlMigration.electMigration, {
        docId,
        chunks: splitUpdate(result.update),
        nmlSchemaVersion: result.schemaVersion,
        nmlEncodingVersion: result.encodingVersion,
        equivalenceOk: true,
        mismatchClasses: [],
        limitOk: true,
      }),
    ).rejects.toThrow(/cohort/);
    expect(projectId).toBeDefined();
  });

  test("a project owner can opt a whole project in; a guest cannot", async () => {
    const t = harness();
    const { projectId, docId } = await world(t);
    await claimEditor(t, projectId);
    await expect(
      t.withIdentity(GUEST).mutation(api.nmlMigration.addToCohort, { scope: "project", key: projectId }),
    ).rejects.toThrow();
    await t.withIdentity(OWNER).mutation(api.nmlMigration.addToCohort, { scope: "project", key: projectId });
    expect(await t.withIdentity(OWNER).query(api.nmlMigration.inCohort, { docId })).toBe(true);
  });
});

describe("elected migrator", () => {
  test("first writer wins; a second migrator stands down without a duplicate root", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    const result = nmlDelta(docId, base);
    const first = await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(result.update),
      nmlSchemaVersion: result.schemaVersion,
      nmlEncodingVersion: result.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    expect(first.elected).toBe(true);

    const second = await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(nmlDelta(docId, base).update),
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    expect(second).toMatchObject({ elected: false, reason: "already-elected" });

    // Exactly one NML root append landed.
    const doc = await reload(as, docId);
    expect(doc.getMap(NML_YJS_ROOT).size).toBeGreaterThan(0);
    expect(doc.getXmlFragment("prosemirror").toString()).toContain("legacy");
    expect(decodeNmlDocument(doc).blocks[0].id).toBe("p1");
  });

  test("a root that failed equivalence or limits is refused, not stored", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    const result = nmlDelta(docId, base);
    await expect(
      as.mutation(api.nmlMigration.electMigration, {
        docId,
        chunks: splitUpdate(result.update),
        nmlSchemaVersion: 1,
        nmlEncodingVersion: 1,
        equivalenceOk: false,
        mismatchClasses: ["parent-mismatch"],
        limitOk: true,
      }),
    ).rejects.toThrow(/equivalence or limits/);
    expect(await as.query(api.nmlMigration.nmlState, { docId })).toBeNull();
  });
});

describe("mixed-version reader", () => {
  test("nmlState reports the declared versions and migrated status", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    const result = nmlDelta(docId, base);
    await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(result.update),
      nmlSchemaVersion: result.schemaVersion,
      nmlEncodingVersion: result.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    const state = await as.query(api.nmlMigration.nmlState, { docId });
    expect(state).toMatchObject({
      status: "migrated",
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      equivalenceOk: true,
      limitOk: true,
    });
  });
});

describe("collaborate and reload", () => {
  test("two editors' legacy edits converge and the NML root survives a reload", async () => {
    const t = harness();
    const { projectId, docId, base, as } = await ready(t);
    await claimEditor(t, projectId);

    // Migrate, then two people edit the still-authoritative legacy root.
    const result = nmlDelta(docId, base);
    await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(result.update),
      nmlSchemaVersion: result.schemaVersion,
      nmlEncodingVersion: result.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    await as.mutation(api.ydoc.append, { docId, update: editProseMirror(base, "owner-edit") });
    await t.withIdentity(GUEST).mutation(api.ydoc.append, { docId, update: editProseMirror(base, "guest-edit") });

    const doc = await reload(as, docId);
    const body = doc.getXmlFragment("prosemirror").toString();
    expect(body).toContain("owner-edit");
    expect(body).toContain("guest-edit");
    expect(doc.getMap(NML_YJS_ROOT).size).toBeGreaterThan(0);
    expect(decodeNmlDocument(doc).blocks[0].id).toBe("p1");
  });
});

describe("rollback", () => {
  test("returns authority to legacy while leaving the NML root recoverable", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    const result = nmlDelta(docId, base);
    await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(result.update),
      nmlSchemaVersion: result.schemaVersion,
      nmlEncodingVersion: result.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });

    const rolled = await as.mutation(api.nmlMigration.rollback, { docId, reason: "policy", diverged: true });
    expect(rolled).toEqual({ rolledBack: true, diverged: true });
    const state = await as.query(api.nmlMigration.nmlState, { docId });
    expect(state).toMatchObject({ status: "rolledBack", rolledBackDiverged: true, rollbackReason: "policy" });

    // The root is left in place: rollback is metadata, so nothing is lost.
    const doc = await reload(as, docId);
    expect(doc.getMap(NML_YJS_ROOT).size).toBeGreaterThan(0);

    // A rolled-back document does not re-elect on the next attempt.
    const again = await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(nmlDelta(docId, base).update),
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    expect(again.elected).toBe(false);
  });

  test("rolling back a document that never migrated is refused", async () => {
    const t = harness();
    const { docId, as } = await ready(t);
    await expect(as.mutation(api.nmlMigration.rollback, { docId, reason: "x", diverged: false })).rejects.toThrow(
      /no active migration/,
    );
  });
});
