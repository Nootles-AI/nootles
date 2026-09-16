/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { joinUpdateRows, splitUpdate } from "./yshape";
import componentSchema from "../node_modules/@convex-dev/prosemirror-sync/src/component/schema";
import {
  decodeNmlDocument,
  migrateStoredDocument,
  NML_YJS_ROOT,
  writeNmlDocument,
  type LegacyBlock,
  type NmlBlock,
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
const INTERNAL = { subject: "user_internal" };

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

/** A project + page owned by an arbitrary subject — for owner-scoped eligibility. */
async function docOwnedBy(t: TestConvex<typeof schema>, subject: string) {
  return await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", { ownerId: subject, title: "P", createdAt: 1 });
    const docId = crypto.randomUUID();
    await ctx.db.insert("pages", { ownerId: subject, projectId, title: "", order: 0, docId, createdAt: 1 });
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

/** Elect the well-formed migration the browser engine produces. */
async function electGood(as: ReturnType<TestConvex<typeof schema>["withIdentity"]>, docId: string, base: ArrayBuffer) {
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
}

/**
 * The delta a *dishonest* client could produce: a structurally valid NML root
 * that decodes fine but holds 10,001 blocks, past the v1 count limit. It is
 * built with the real `writeNmlDocument` (which runs only the structural schema,
 * not the count limit), so `migrateStoredDocument` would have rejected it but
 * this hand-built update sidesteps that and is what the server must re-catch.
 */
function oversizedNmlDelta(docId: string, base: ArrayBuffer): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(base));
  const before = Y.encodeStateVector(doc);
  const blocks: NmlBlock[] = Array.from({ length: 10_001 }, (_, i) => ({
    id: `p${i}`,
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: "x", marks: [] }],
    children: [],
  }));
  writeNmlDocument(doc, { schemaVersion: 1, documentId: docId, blocks });
  const delta = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return delta;
}

describe("server authority — step 13", () => {
  test("a well-formed root, verified server-side, is granted authority", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    await electGood(as, docId, base);

    await t.action(internal.nmlVerify.run, { docId });

    const authority = await as.query(api.nmlMigration.nmlAuthority, { docId });
    expect(authority).toEqual({ serve: true, reason: "verified", schemaVersion: 1, encodingVersion: 1 });
    expect(await as.query(api.nmlMigration.nmlState, { docId })).toMatchObject({
      serverVerified: true,
      serverSchemaVersion: 1,
      serverEncodingVersion: 1,
    });
  });

  test("authority is withheld until the server verification has run", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    await electGood(as, docId, base);
    // electMigration only *schedules* the check; nothing has verified yet.
    const authority = await as.query(api.nmlMigration.nmlAuthority, { docId });
    expect(authority).toMatchObject({ serve: false, reason: "pending-verification" });
  });

  test("electMigration schedules the verification, which then grants authority", async () => {
    const t = harness();
    vi.useFakeTimers();
    try {
      const { docId, base, as } = await ready(t);
      await electGood(as, docId, base);
      // Run the function electMigration scheduled — no manual verify call.
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const authority = await as.query(api.nmlMigration.nmlAuthority, { docId });
      expect(authority.serve).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a lying client cannot get an over-limit root served: the server re-checks limits", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    // The client claims equivalence and limits are fine while shipping a root
    // that is not — exactly the trust electMigration extends and step 13 closes.
    const elected = await as.mutation(api.nmlMigration.electMigration, {
      docId,
      chunks: splitUpdate(oversizedNmlDelta(docId, base)),
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    expect(elected.elected).toBe(true); // stored on the client's word...

    await t.action(internal.nmlVerify.run, { docId });

    // ...but the independent server check refuses to serve it.
    const authority = await as.query(api.nmlMigration.nmlAuthority, { docId });
    expect(authority).toMatchObject({ serve: false, reason: "limit-exceeded" });
    expect(await as.query(api.nmlMigration.nmlState, { docId })).toMatchObject({
      serverVerified: false,
      serverVerifyError: "limit-exceeded",
    });
  });

  test("rollback withholds authority even after a passing verification", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    await electGood(as, docId, base);
    await t.action(internal.nmlVerify.run, { docId });
    expect((await as.query(api.nmlMigration.nmlAuthority, { docId })).serve).toBe(true);

    await as.mutation(api.nmlMigration.rollback, { docId, reason: "policy", diverged: false });
    expect(await as.query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({
      serve: false,
      reason: "rolled-back",
    });
  });

  test("a verified doc dropped from the cohort is no longer served", async () => {
    const t = harness();
    const { docId, base, as } = await ready(t);
    await electGood(as, docId, base);
    await t.action(internal.nmlVerify.run, { docId });
    expect((await as.query(api.nmlMigration.nmlAuthority, { docId })).serve).toBe(true);

    await as.mutation(api.nmlMigration.removeFromCohort, { scope: "doc", key: docId });
    expect(await as.query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({
      serve: false,
      reason: "not-in-cohort",
    });
  });
});

describe("internal-owner allowlist — phase 1", () => {
  test("a doc owned by an internal subject is eligible without cohort enrollment", async () => {
    const t = harness();
    const { docId } = await docOwnedBy(t, INTERNAL.subject);
    // Not eligible before enrollment — the allowlist is the only source here.
    expect(await t.withIdentity(INTERNAL).query(api.nmlMigration.inCohort, { docId })).toBe(false);
    await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject, note: "founder" });
    // Eligible now, with no `nmlCohorts` row anywhere.
    expect(await t.withIdentity(INTERNAL).query(api.nmlMigration.inCohort, { docId })).toBe(true);
  });

  test("a doc owned by a non-listed subject stays ineligible", async () => {
    const t = harness();
    await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
    const { docId } = await docOwnedBy(t, OWNER.subject);
    expect(await t.withIdentity(OWNER).query(api.nmlMigration.inCohort, { docId })).toBe(false);
  });

  test("owned-only: a doc an internal member can edit but does not own is not eligible", async () => {
    const t = harness();
    await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
    // Owned by OWNER (not internal), shared to the internal member as an editor.
    // The edit link must be live for the claim to grant access (see `auth.ts`).
    const { projectId, docId } = await docOwnedBy(t, OWNER.subject);
    await t.run(async (ctx) => {
      await ctx.db.patch(projectId, { editShareToken: "edit-tok" });
      await ctx.db.insert("shareClaims", {
        projectId,
        granteeId: INTERNAL.subject,
        role: "editor",
        grantedRole: "editor",
        createdAt: 1,
      });
    });
    // The internal member can READ it (editor), so `inCohort` resolves rather
    // than throwing — but eligibility is owned-only and the owner is not internal.
    expect(await t.withIdentity(INTERNAL).query(api.nmlMigration.inCohort, { docId })).toBe(false);
  });

  test("removing an internal owner makes their docs ineligible again (kill switch)", async () => {
    const t = harness();
    const { docId } = await docOwnedBy(t, INTERNAL.subject);
    await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
    expect(await t.withIdentity(INTERNAL).query(api.nmlMigration.inCohort, { docId })).toBe(true);
    const removed = await t.mutation(internal.nmlMigration.removeInternalOwner, { subject: INTERNAL.subject });
    expect(removed).toEqual({ removed: 1 });
    expect(await t.withIdentity(INTERNAL).query(api.nmlMigration.inCohort, { docId })).toBe(false);
  });

  test("addInternalOwner is idempotent and listInternalOwners reflects membership", async () => {
    const t = harness();
    const first = await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject, note: "founder" });
    const second = await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
    expect(first).toEqual({ added: true });
    expect(second).toEqual({ added: false });
    const list = await t.query(internal.nmlMigration.listInternalOwners, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ subject: INTERNAL.subject, note: "founder" });
  });

  test("allowlist eligibility alone lets a doc migrate and gain server authority", async () => {
    const t = harness();
    vi.useFakeTimers();
    try {
      const { docId } = await docOwnedBy(t, INTERNAL.subject);
      const as = t.withIdentity(INTERNAL);
      const base = encodedBase();
      await as.mutation(api.ydoc.init, { docId, update: base });
      // Eligibility comes ONLY from the allowlist — no addToCohort call.
      await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
      const result = nmlDelta(docId, base);
      const elected = await as.mutation(api.nmlMigration.electMigration, {
        docId,
        chunks: splitUpdate(result.update),
        nmlSchemaVersion: result.schemaVersion,
        nmlEncodingVersion: result.encodingVersion,
        equivalenceOk: true,
        mismatchClasses: [],
        limitOk: true,
      });
      expect(elected.elected).toBe(true);
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await as.query(api.nmlMigration.nmlAuthority, { docId })).serve).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("master serve switch — phase 2", () => {
  test("nmlServeEnabled defaults off and setNmlServe flips it both ways", async () => {
    const t = harness();
    expect(await t.query(api.nmlMigration.nmlServeEnabled, {})).toBe(false);
    expect(await t.mutation(internal.nmlMigration.setNmlServe, { enabled: true })).toEqual({ enabled: true });
    expect(await t.query(api.nmlMigration.nmlServeEnabled, {})).toBe(true);
    // Idempotent-ish upsert of the single row, and a real off switch.
    expect(await t.mutation(internal.nmlMigration.setNmlServe, { enabled: false })).toEqual({ enabled: false });
    expect(await t.query(api.nmlMigration.nmlServeEnabled, {})).toBe(false);
    // Still one row after repeated flips.
    const rows = await t.run((ctx) => ctx.db.query("nmlServeState").collect());
    expect(rows).toHaveLength(1);
  });
});

describe("migration stats & rollback rehearsal — phase 2", () => {
  test("nmlMigrationStats aggregates fleet health across every state", async () => {
    const t = harness();

    // Two docs migrated + server-verified → serving.
    for (let i = 0; i < 2; i++) {
      const { docId, base, as } = await ready(t);
      await electGood(as, docId, base);
      await t.action(internal.nmlVerify.run, { docId });
    }
    // One migrated, verification still pending.
    {
      const { docId, base, as } = await ready(t);
      await electGood(as, docId, base);
    }
    // One migrated then rolled back.
    {
      const { docId, base, as } = await ready(t);
      await electGood(as, docId, base);
      await as.mutation(api.nmlMigration.rollback, { docId, reason: "policy", diverged: false });
    }
    // One elected on a dishonest over-limit root → server verification fails.
    {
      const { docId, base, as } = await ready(t);
      await as.mutation(api.nmlMigration.electMigration, {
        docId,
        chunks: splitUpdate(oversizedNmlDelta(docId, base)),
        nmlSchemaVersion: 1,
        nmlEncodingVersion: 1,
        equivalenceOk: true,
        mismatchClasses: [],
        limitOk: true,
      });
      await t.action(internal.nmlVerify.run, { docId });
    }

    const stats = await t.query(internal.nmlMigration.nmlMigrationStats, {});
    expect(stats).toEqual({
      total: 5,
      migrated: 4,
      rolledBack: 1,
      verifyPending: 1,
      verifyPass: 2,
      verifyFail: 1,
      unsupportedVersion: 0,
      serving: 2,
      errorClasses: [{ reason: "limit-exceeded", count: 1 }],
    });
  });

  test("empty deployment reports all zeros", async () => {
    const t = harness();
    const stats = await t.query(internal.nmlMigration.nmlMigrationStats, {});
    expect(stats).toEqual({
      total: 0,
      migrated: 0,
      rolledBack: 0,
      verifyPending: 0,
      verifyPass: 0,
      verifyFail: 0,
      unsupportedVersion: 0,
      serving: 0,
      errorClasses: [],
    });
  });

  test("removeInternalOwner un-serves a verified doc at the authority gate (allowlist kill switch)", async () => {
    const t = harness();
    vi.useFakeTimers();
    try {
      const { docId } = await docOwnedBy(t, INTERNAL.subject);
      const as = t.withIdentity(INTERNAL);
      const base = encodedBase();
      await as.mutation(api.ydoc.init, { docId, update: base });
      await t.mutation(internal.nmlMigration.addInternalOwner, { subject: INTERNAL.subject });
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
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await as.query(api.nmlMigration.nmlAuthority, { docId })).serve).toBe(true);

      // Pull the owner off the allowlist — eligibility is recomputed per read,
      // so the doc immediately falls back to legacy authority (root retained).
      await t.mutation(internal.nmlMigration.removeInternalOwner, { subject: INTERNAL.subject });
      expect(await as.query(api.nmlMigration.nmlAuthority, { docId })).toMatchObject({
        serve: false,
        reason: "not-in-cohort",
      });
      // The NML root is left in place — the fall-back is authority only, lossless.
      const state = await as.query(api.nmlMigration.nmlState, { docId });
      expect(state).toMatchObject({ status: "migrated", serverVerified: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
