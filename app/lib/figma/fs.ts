import { Buffer } from "node:buffer";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson } from "./canonical";
import { FigmaCacheError, verifyFigmaExtractionBundle } from "./extractor";
import {
  FIGMA_EXTRACTION_MANIFEST_SCHEMA,
  FIGMA_EXTRACTOR_VERSION,
  type FigmaExtractionBundle,
  type FigmaExtractionCache,
  type JsonValue,
} from "./types";

const asJsonValue = (value: unknown) => value as JsonValue;

async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertCompatible(path: string, contents: string | Uint8Array): Promise<void> {
  try {
    const actual = typeof contents === "string"
      ? await readFile(path, "utf8")
      : Buffer.from(await readFile(path)).toString("base64");
    const wanted = typeof contents === "string" ? contents : Buffer.from(contents).toString("base64");
    if (actual !== wanted) throw new FigmaCacheError(`Refusing to replace different extraction bytes at ${path}.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

/**
 * Write without ever replacing different bytes. A completed extraction is an
 * immutable content-addressed artifact, including when two processes race.
 */
async function writeImmutable(path: string, contents: string | Uint8Array): Promise<void> {
  const existing = await readTextIfPresent(path);
  const wanted = typeof contents === "string" ? contents : Buffer.from(contents).toString("base64");
  if (existing !== null) {
    const actual = typeof contents === "string" ? existing : Buffer.from(await readFile(path)).toString("base64");
    if (actual !== wanted) throw new FigmaCacheError(`Refusing to replace different extraction bytes at ${path}.`);
    return;
  }

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, path);
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    const actual = typeof contents === "string"
      ? await readFile(path, "utf8")
      : Buffer.from(await readFile(path)).toString("base64");
    if (actual !== wanted) throw new FigmaCacheError(`Refusing to replace different extraction bytes at ${path}.`);
    await unlink(temporary);
  }
}

function assertCacheKey(cacheKey: string): void {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new FigmaCacheError("Extraction cache key must be a SHA-256 hex digest.");
}

export class DirectoryFigmaExtractionCache implements FigmaExtractionCache {
  constructor(readonly root: string) {}

  async get(cacheKey: string): Promise<FigmaExtractionBundle | null> {
    assertCacheKey(cacheKey);
    const source = await readTextIfPresent(join(this.root, cacheKey, "bundle.json"));
    if (source === null) return null;
    let bundle: FigmaExtractionBundle;
    try {
      bundle = JSON.parse(source) as FigmaExtractionBundle;
    } catch {
      throw new FigmaCacheError(`Cached extraction ${cacheKey} is not valid JSON.`);
    }
    await verifyFigmaExtractionBundle(bundle);
    if (bundle.cacheKey !== cacheKey) throw new FigmaCacheError("Cache path key does not match the extraction bundle.");
    return bundle;
  }

  async put(cacheKey: string, bundle: FigmaExtractionBundle): Promise<void> {
    assertCacheKey(cacheKey);
    await verifyFigmaExtractionBundle(bundle);
    if (bundle.cacheKey !== cacheKey) throw new FigmaCacheError("Cache write key does not match the extraction bundle.");
    await writeImmutable(join(this.root, cacheKey, "bundle.json"), `${canonicalJson(asJsonValue(bundle))}\n`);
  }
}

export async function writeFigmaExtraction(
  root: string,
  bundle: FigmaExtractionBundle,
): Promise<{ snapshotPath: string; reportPath: string; manifestPath: string }> {
  await verifyFigmaExtractionBundle(bundle);
  const snapshotPath = join(root, "snapshot.json");
  const reportPath = join(root, "report.json");
  const manifestPath = join(root, "manifest.json");
  const writes: Array<{ path: string; contents: string | Uint8Array }> = [];
  const artifactManifest = Object.values(bundle.artifacts)
    .map((artifact) => {
      const render = Object.values(bundle.snapshot.referenceRenders)
        .find((entry) => entry.status === "captured" && entry.artifact.sha256 === artifact.sha256);
      if (!render || render.status !== "captured") throw new FigmaCacheError("Artifact manifest is incomplete.");
      writes.push({
        path: join(root, render.artifact.path),
        contents: Buffer.from(artifact.dataBase64, "base64"),
      });
      return {
        sha256: artifact.sha256,
        byteLength: artifact.byteLength,
        mediaType: artifact.mediaType,
        path: render.artifact.path,
      };
    })
    .sort((a, b) => a.sha256.localeCompare(b.sha256));
  const manifest = {
    schemaVersion: FIGMA_EXTRACTION_MANIFEST_SCHEMA,
    extractorVersion: FIGMA_EXTRACTOR_VERSION,
    cacheKey: bundle.cacheKey,
    snapshotHash: bundle.report.snapshotHash,
    snapshot: "snapshot.json",
    report: "report.json",
    artifacts: artifactManifest,
  };
  writes.push(
    { path: snapshotPath, contents: `${canonicalJson(asJsonValue(bundle.snapshot))}\n` },
    { path: reportPath, contents: `${canonicalJson(asJsonValue(bundle.report))}\n` },
    { path: manifestPath, contents: `${canonicalJson(asJsonValue(manifest))}\n` },
  );
  for (const write of writes) await assertCompatible(write.path, write.contents);
  for (const write of writes) await writeImmutable(write.path, write.contents);
  return { snapshotPath, reportPath, manifestPath };
}
