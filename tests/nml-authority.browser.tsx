/**
 * Step 13 browser client for the NML authority gate.
 *
 * Runs in real Chromium against a throwaway local Convex backend (the harness
 * in `nml-authority.browser.mjs` boots it, pushes the functions, and mints the
 * auth token). This is the actual user path the convex-test suite can only
 * approximate: a signed-in reactive client migrates a document, the backend
 * verifies the persisted root on its own, and `nmlAuthority` flips over the
 * wire — with the scheduled verification running by itself, no manual trigger.
 *
 * The client also proves the gate holds against a dishonest migrator (an
 * over-limit root shipped with `limitOk: true`), a rollback, and a document
 * dropped from the cohort. No paid API is ever touched.
 */
import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";
import * as Y from "yjs";
import { migrateStoredDocument, writeNmlDocument, type LegacyBlock, type NmlBlock } from "@/app/lib/nml";

type Authority = { serve: boolean; reason: string; schemaVersion?: number; encodingVersion?: number };

type Config = {
  url: string;
  jwt: string;
  baseB64: string;
  blocks: LegacyBlock[];
  docGood: string;
  docLying: string;
  docDrop: string;
};

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Row-sized ArrayBuffer chunks, well under Convex's 1MiB value cap. */
function toChunks(u8: Uint8Array): ArrayBuffer[] {
  const size = 700 * 1024;
  const out: ArrayBuffer[] = [];
  for (let at = 0; at < u8.byteLength; at += size) {
    const part = u8.slice(at, at + size);
    out.push(part.buffer.slice(part.byteOffset, part.byteOffset + part.byteLength));
  }
  return out.length ? out : [new ArrayBuffer(0)];
}

/** The well-formed NML-root delta the real engine produces for this base. */
function goodDelta(base: Uint8Array, blocks: LegacyBlock[], docId: string) {
  const result = migrateStoredDocument({ baseUpdates: [base], blocks, documentId: docId });
  if (result.status !== "migrated") throw new Error(`expected migration, got ${result.reason}`);
  return result;
}

/** A structurally valid root that decodes fine but blows the 10k-block limit. */
function oversizedDelta(base: Uint8Array, docId: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
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

/** A reactive subscription with an awaitable predicate over its latest value. */
function watch<T>(client: ConvexClient, ref: unknown, args: Record<string, unknown>) {
  let latest: T | undefined;
  const waiters = new Set<(v: T) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unsub = client.onUpdate(ref as any, args, (v: T) => {
    latest = v;
    for (const w of [...waiters]) w(v);
  });
  return {
    latest: () => latest,
    until(pred: (v: T | undefined) => boolean, ms = 15000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (pred(latest)) return resolve(latest as T);
        const timer = setTimeout(() => {
          waiters.delete(w);
          reject(new Error(`timeout waiting; last=${JSON.stringify(latest)}`));
        }, ms);
        const w = (v: T) => {
          if (pred(v)) {
            clearTimeout(timer);
            waiters.delete(w);
            resolve(v);
          }
        };
        waiters.add(w);
      });
    },
    stop: unsub,
  };
}

async function run(cfg: Config) {
  const client = new ConvexClient(cfg.url);
  client.setAuth(async () => cfg.jwt);
  const base = fromB64(cfg.baseB64);
  const api = anyApi.nmlMigration;
  const results: Record<string, unknown> = {};

  // 1. A well-formed migration, verified server-side, is served — then a
  //    rollback withdraws authority. No manual verify: the backend schedules it.
  {
    const auth = watch<Authority>(client, api.nmlAuthority, { docId: cfg.docGood });
    results.goodBeforeElect = auth.latest() ?? null;
    await client.mutation(api.addToCohort, { scope: "doc", key: cfg.docGood });
    const d = goodDelta(base, cfg.blocks, cfg.docGood);
    await client.mutation(api.electMigration, {
      docId: cfg.docGood,
      chunks: toChunks(d.update),
      nmlSchemaVersion: d.schemaVersion,
      nmlEncodingVersion: d.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    results.goodPending = auth.latest() ?? null;
    results.goodServed = await auth.until((v) => !!v && v.serve === true);
    await client.mutation(api.rollback, { docId: cfg.docGood, reason: "policy", diverged: false });
    results.goodAfterRollback = await auth.until((v) => !!v && v.serve === false && v.reason === "rolled-back");
    auth.stop();
  }

  // 2. A dishonest client ships an over-limit root claiming limitOk — the
  //    independent server check refuses to serve it.
  {
    const auth = watch<Authority>(client, api.nmlAuthority, { docId: cfg.docLying });
    await client.mutation(api.addToCohort, { scope: "doc", key: cfg.docLying });
    await client.mutation(api.electMigration, {
      docId: cfg.docLying,
      chunks: toChunks(oversizedDelta(base, cfg.docLying)),
      nmlSchemaVersion: 1,
      nmlEncodingVersion: 1,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    results.lyingVerdict = await auth.until((v) => !!v && v.serve === false && v.reason === "limit-exceeded");
    auth.stop();
  }

  // 3. A verified doc dropped from the cohort stops being served.
  {
    const auth = watch<Authority>(client, api.nmlAuthority, { docId: cfg.docDrop });
    await client.mutation(api.addToCohort, { scope: "doc", key: cfg.docDrop });
    const d = goodDelta(base, cfg.blocks, cfg.docDrop);
    await client.mutation(api.electMigration, {
      docId: cfg.docDrop,
      chunks: toChunks(d.update),
      nmlSchemaVersion: d.schemaVersion,
      nmlEncodingVersion: d.encodingVersion,
      equivalenceOk: true,
      mismatchClasses: [],
      limitOk: true,
    });
    await auth.until((v) => !!v && v.serve === true);
    await client.mutation(api.removeFromCohort, { scope: "doc", key: cfg.docDrop });
    results.afterCohortDrop = await auth.until((v) => !!v && v.serve === false && v.reason === "not-in-cohort");
    auth.stop();
  }

  client.close();
  return results;
}

declare global {
  interface Window {
    __nmlAuthority: { run: (cfg: Config) => Promise<Record<string, unknown>> };
  }
}

window.__nmlAuthority = { run };
document.getElementById("app")?.setAttribute("data-ready", "true");
