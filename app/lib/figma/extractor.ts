import { Buffer } from "node:buffer";

import { canonicalJson, cloneJson, deepFreeze, sha256Bytes, sha256Text } from "./canonical";
import { inspectExtraction, sortDiagnostics } from "./report";
import {
  FIGMA_EXTRACTION_BUNDLE_SCHEMA,
  FIGMA_EXTRACTION_REPORT_SCHEMA,
  FIGMA_EXTRACTOR_VERSION,
  FIGMA_RAW_SNAPSHOT_SCHEMA,
  type ExtractionArtifact,
  type ExtractionDiagnostic,
  type FigmaExtractionBundle,
  type FigmaExtractionCache,
  type FigmaExtractionOptions,
  type FigmaExtractionResult,
  type FigmaExtractorDependencies,
  type JsonObject,
  type JsonValue,
  type NormalizedFigmaExtractionOptions,
  type RawFigmaSnapshot,
  type ReferenceRender,
  type VolatileField,
} from "./types";

const DEFAULT_API_BASE = "https://api.figma.com";
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_NODE_IDS = 100;

const asJsonValue = (value: unknown) => value as JsonValue;
const isObject = (value: unknown): value is JsonObject =>
  !!value && typeof value === "object" && !Array.isArray(value);

export class FigmaExtractionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaExtractionInputError";
  }
}

export class FigmaContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaContractError";
  }
}

export class FigmaHttpError extends Error {
  constructor(
    readonly endpoint: "file" | "nodes" | "renders",
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly planTier: string | null,
    readonly rateLimitType: string | null,
    readonly upgradeUrl: string | null,
  ) {
    super(
      `Figma ${endpoint} request failed with HTTP ${status}${
        retryAfterSeconds === null ? "" : ` (Retry-After: ${retryAfterSeconds}s)`
      }.`,
    );
    this.name = "FigmaHttpError";
  }
}

function httpError(
  endpoint: "file" | "nodes" | "renders",
  response: Response,
  after: number | null,
): FigmaHttpError {
  return new FigmaHttpError(
    endpoint,
    response.status,
    after,
    response.headers.get("x-figma-plan-tier"),
    response.headers.get("x-figma-rate-limit-type"),
    response.headers.get("x-figma-upgrade-link"),
  );
}

export class FigmaTransportError extends Error {
  constructor(readonly endpoint: "file" | "nodes" | "renders") {
    super(`Figma ${endpoint} request failed before an HTTP response was received.`);
    this.name = "FigmaTransportError";
  }
}

export class FigmaCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FigmaCacheError";
  }
}

function nonempty(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new FigmaExtractionInputError(`${label} is required.`);
  return trimmed;
}

function uniqueIds(values: readonly string[] | undefined, label: string): string[] {
  const ids = [...new Set((values ?? []).map((value) => nonempty(value, label)))].sort();
  if (ids.length > MAX_NODE_IDS) {
    throw new FigmaExtractionInputError(`${label} accepts at most ${MAX_NODE_IDS} unique entries per extraction.`);
  }
  return ids;
}

function normalizedApiBase(value: string | undefined): string {
  const raw = (value ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FigmaExtractionInputError("apiBaseUrl must be an absolute URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new FigmaExtractionInputError("apiBaseUrl must use HTTPS (HTTP is allowed only for localhost fixtures).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new FigmaExtractionInputError("apiBaseUrl cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") throw new FigmaExtractionInputError("apiBaseUrl cannot contain a path.");
  return url.toString().replace(/\/$/, "");
}

export function normalizeFigmaExtractionOptions(
  options: FigmaExtractionOptions,
): NormalizedFigmaExtractionOptions {
  const fileKey = nonempty(options.fileKey, "fileKey");
  const version = nonempty(options.version, "version");
  if (version.toLowerCase() === "latest") {
    throw new FigmaExtractionInputError('version must be an exact Figma version ID, not "latest".');
  }
  const nodeIds = uniqueIds(options.nodeIds, "nodeIds");
  const pluginData = uniqueIds(options.pluginData, "pluginData");
  const geometry = options.geometry ?? "paths";
  if (geometry !== "paths" && geometry !== "none") {
    throw new FigmaExtractionInputError("geometry must be paths or none.");
  }
  const depth = options.depth ?? null;
  if (depth !== null && (!Number.isSafeInteger(depth) || depth < 1)) {
    throw new FigmaExtractionInputError("depth must be a positive integer.");
  }
  const maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
  if (!Number.isSafeInteger(maxAssetBytes) || maxAssetBytes < 1) {
    throw new FigmaExtractionInputError("maxAssetBytes must be a positive integer.");
  }

  let renders: NormalizedFigmaExtractionOptions["renders"] = null;
  if (options.renders) {
    const renderIds = uniqueIds(options.renders.nodeIds, "renders.nodeIds");
    if (!renderIds.length) throw new FigmaExtractionInputError("renders.nodeIds cannot be empty.");
    const scale = options.renders.scale ?? 1;
    if (!Number.isFinite(scale) || scale < 0.01 || scale > 4) {
      throw new FigmaExtractionInputError("renders.scale must be between 0.01 and 4.");
    }
    const format = options.renders.format ?? "png";
    if (!["jpg", "png", "svg", "pdf"].includes(format)) {
      throw new FigmaExtractionInputError("renders.format must be jpg, png, svg, or pdf.");
    }
    renders = {
      nodeIds: renderIds,
      format,
      scale,
      contentsOnly: options.renders.contentsOnly ?? true,
      useAbsoluteBounds: options.renders.useAbsoluteBounds ?? false,
      svgOutlineText: options.renders.svgOutlineText ?? true,
      svgIncludeId: options.renders.svgIncludeId ?? false,
      svgIncludeNodeId: options.renders.svgIncludeNodeId ?? true,
      svgSimplifyStroke: options.renders.svgSimplifyStroke ?? true,
    };
  }

  return {
    fileKey,
    version,
    nodeIds,
    geometry,
    depth,
    pluginData,
    renders,
    apiBaseUrl: normalizedApiBase(options.apiBaseUrl),
    maxAssetBytes,
  };
}

export function figmaExtractionCacheKey(options: NormalizedFigmaExtractionOptions): string {
  return sha256Text(
    canonicalJson(
      asJsonValue({
        extractorVersion: FIGMA_EXTRACTOR_VERSION,
        request: options,
      }),
    ),
  );
}

function apiUrl(options: NormalizedFigmaExtractionOptions, endpoint: "file" | "nodes" | "renders"): URL {
  const encodedKey = encodeURIComponent(options.fileKey);
  const path =
    endpoint === "file"
      ? `/v1/files/${encodedKey}`
      : endpoint === "nodes"
        ? `/v1/files/${encodedKey}/nodes`
        : `/v1/images/${encodedKey}`;
  const url = new URL(path, `${options.apiBaseUrl}/`);
  url.searchParams.set("version", options.version);
  if (endpoint !== "renders" && options.geometry === "paths") url.searchParams.set("geometry", "paths");
  if (endpoint !== "renders" && options.depth !== null) url.searchParams.set("depth", String(options.depth));
  if (endpoint !== "renders" && options.pluginData.length) {
    url.searchParams.set("plugin_data", options.pluginData.join(","));
  }
  if (endpoint === "nodes") url.searchParams.set("ids", options.nodeIds.join(","));
  if (endpoint === "renders" && options.renders) {
    url.searchParams.set("ids", options.renders.nodeIds.join(","));
    url.searchParams.set("format", options.renders.format);
    url.searchParams.set("scale", String(options.renders.scale));
    url.searchParams.set("contents_only", String(options.renders.contentsOnly));
    url.searchParams.set("use_absolute_bounds", String(options.renders.useAbsoluteBounds));
    if (options.renders.format === "svg") {
      url.searchParams.set("svg_outline_text", String(options.renders.svgOutlineText));
      url.searchParams.set("svg_include_id", String(options.renders.svgIncludeId));
      url.searchParams.set("svg_include_node_id", String(options.renders.svgIncludeNodeId));
      url.searchParams.set("svg_simplify_stroke", String(options.renders.svgSimplifyStroke));
    }
  }
  return url;
}

function retryAfterSeconds(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

async function requestJson(
  endpoint: "file" | "nodes" | "renders",
  url: URL,
  fetchImpl: typeof fetch,
  accessToken: string | undefined,
  sleep: (milliseconds: number) => Promise<void>,
  maxRetries: number,
  maxRetryDelayMs: number,
): Promise<JsonObject> {
  let retries = 0;
  while (true) {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
      });
    } catch {
      if (retries >= maxRetries) throw new FigmaTransportError(endpoint);
      const delay = Math.min(1_000 * 2 ** retries, maxRetryDelayMs);
      retries += 1;
      await sleep(delay);
      continue;
    }

    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new FigmaContractError(`Figma ${endpoint} returned a non-JSON success response.`);
      }
      if (!isObject(body)) throw new FigmaContractError(`Figma ${endpoint} returned a non-object JSON response.`);
      return body;
    }

    const after = retryAfterSeconds(response);
    const retryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504;
    if (!retryable || retries >= maxRetries) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(endpoint, response, after);
    }
    const delay = response.status === 429 ? (after ?? 1) * 1_000 : 1_000 * 2 ** retries;
    if (delay > maxRetryDelayMs) {
      await response.body?.cancel().catch(() => undefined);
      throw httpError(endpoint, response, after);
    }
    await response.body?.cancel().catch(() => undefined);
    retries += 1;
    await sleep(delay);
  }
}

const ROOT_VOLATILE_FIELDS: Record<"file" | "nodes", Readonly<Record<string, VolatileField["reason"]>>> = {
  file: {
    name: "current-file-metadata",
    role: "caller-dependent",
    lastModified: "current-file-metadata",
    thumbnailUrl: "expiring-url",
    linkAccess: "caller-dependent",
    branches: "current-file-metadata",
  },
  nodes: {
    name: "current-file-metadata",
    role: "caller-dependent",
    lastModified: "current-file-metadata",
    thumbnailUrl: "expiring-url",
    linkAccess: "caller-dependent",
  },
};

function withoutVolatileRoot(
  input: JsonObject,
  endpoint: "file" | "nodes",
  omitted: VolatileField[],
): JsonObject {
  const output = cloneJson(input);
  for (const [field, reason] of Object.entries(ROOT_VOLATILE_FIELDS[endpoint])) {
    if (!(field in output)) continue;
    delete output[field];
    omitted.push({ endpoint, pointer: `/${field}`, reason });
  }
  return output;
}

function fallbackMediaType(format: NonNullable<NormalizedFigmaExtractionOptions["renders"]>["format"]): string {
  return format === "jpg"
    ? "image/jpeg"
    : format === "png"
      ? "image/png"
      : format === "svg"
        ? "image/svg+xml"
        : "application/pdf";
}

function artifactExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/svg+xml") return "svg";
  if (mediaType === "application/pdf") return "pdf";
  return "bin";
}

async function captureRenders(
  rawResponse: JsonObject,
  options: NormalizedFigmaExtractionOptions,
  fetchImpl: typeof fetch,
  omitted: VolatileField[],
): Promise<{
  response: JsonObject;
  renders: Record<string, ReferenceRender>;
  artifacts: Record<string, ExtractionArtifact>;
  diagnostics: ExtractionDiagnostic[];
}> {
  const renderOptions = options.renders;
  if (!renderOptions) return { response: {}, renders: {}, artifacts: {}, diagnostics: [] };
  const images = isObject(rawResponse.images) ? rawResponse.images : null;
  if (!images) throw new FigmaContractError("Figma renders response did not contain an images object.");

  const response = cloneJson(rawResponse);
  const storedImages: JsonObject = {};
  response.images = storedImages;
  const renders: Record<string, ReferenceRender> = {};
  const artifacts: Record<string, ExtractionArtifact> = {};
  const diagnostics: ExtractionDiagnostic[] = [];

  for (const nodeId of renderOptions.nodeIds) {
      const pointer = `/images/${nodeId.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      const source = images[nodeId];
      if (source === null) {
        renders[nodeId] = { status: "null" };
        storedImages[nodeId] = "render:null";
        diagnostics.push({
          severity: "warning",
          code: "render_null",
          message: "Figma returned null for a requested reference render.",
          nodeId,
          pointer,
        });
        continue;
      }
      if (typeof source !== "string") {
        renders[nodeId] = { status: "unavailable", httpStatus: null };
        storedImages[nodeId] = "render:missing";
        diagnostics.push({
          severity: "warning",
          code: "render_missing",
          message: "Figma omitted a requested node from its reference-render map.",
          nodeId,
          pointer,
        });
        continue;
      }

      omitted.push({ endpoint: "renders", pointer, reason: "expiring-url" });
      let url: URL;
      try {
        url = new URL(source);
      } catch {
        renders[nodeId] = { status: "invalid-url" };
        storedImages[nodeId] = "render:invalid-url";
        diagnostics.push({
          severity: "warning",
          code: "render_invalid_url",
          message: "Figma returned an invalid reference-render URL; the URL was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      if (url.protocol !== "https:") {
        renders[nodeId] = { status: "invalid-url" };
        storedImages[nodeId] = "render:invalid-url";
        diagnostics.push({
          severity: "warning",
          code: "render_insecure_url",
          message: "Figma returned a non-HTTPS reference-render URL; it was not fetched or retained.",
          nodeId,
          pointer,
        });
        continue;
      }

      let assetResponse: Response;
      try {
        assetResponse = await fetchImpl(url, { method: "GET", headers: { Accept: "*/*" } });
      } catch {
        renders[nodeId] = { status: "unavailable", httpStatus: null };
        storedImages[nodeId] = "render:unavailable";
        diagnostics.push({
          severity: "warning",
          code: "render_download_failed",
          message: "A reference-render asset could not be downloaded; its expiring URL was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      if (!assetResponse.ok) {
        await assetResponse.body?.cancel().catch(() => undefined);
        renders[nodeId] = { status: "unavailable", httpStatus: assetResponse.status };
        storedImages[nodeId] = `render:http-${assetResponse.status}`;
        diagnostics.push({
          severity: "warning",
          code: "render_asset_unavailable",
          message: "A reference-render asset was unavailable or expired; its expiring URL was not retained.",
          nodeId,
          pointer,
          httpStatus: assetResponse.status,
        });
        continue;
      }

      const contentLengthHeader = assetResponse.headers.get("content-length");
      const statedLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader) ? Number(contentLengthHeader) : null;
      if (statedLength !== null && statedLength > options.maxAssetBytes) {
        await assetResponse.body?.cancel().catch(() => undefined);
        renders[nodeId] = { status: "too-large", byteLength: statedLength };
        storedImages[nodeId] = "render:too-large";
        diagnostics.push({
          severity: "warning",
          code: "render_asset_too_large",
          message: "A reference-render asset exceeded the configured byte limit and was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      const bytes = new Uint8Array(await assetResponse.arrayBuffer());
      if (bytes.byteLength > options.maxAssetBytes) {
        renders[nodeId] = { status: "too-large", byteLength: bytes.byteLength };
        storedImages[nodeId] = "render:too-large";
        diagnostics.push({
          severity: "warning",
          code: "render_asset_too_large",
          message: "A reference-render asset exceeded the configured byte limit and was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      const headerType = assetResponse.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const expectedMediaType = fallbackMediaType(renderOptions.format);
      if (headerType && headerType !== expectedMediaType) {
        renders[nodeId] = { status: "invalid-content-type", mediaType: headerType };
        storedImages[nodeId] = "render:invalid-content-type";
        diagnostics.push({
          severity: "warning",
          code: "render_content_type_mismatch",
          message: "A reference-render response had a content type that did not match the requested format and was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      if (!bytes.byteLength) {
        renders[nodeId] = { status: "unavailable", httpStatus: assetResponse.status };
        storedImages[nodeId] = "render:empty";
        diagnostics.push({
          severity: "warning",
          code: "render_asset_empty",
          message: "A reference-render response was empty and was not retained.",
          nodeId,
          pointer,
        });
        continue;
      }
      const sha256 = sha256Bytes(bytes);
      const mediaType = headerType || expectedMediaType;
      const artifact: ExtractionArtifact = {
        sha256,
        byteLength: bytes.byteLength,
        mediaType,
        dataBase64: Buffer.from(bytes).toString("base64"),
      };
      const existing = artifacts[sha256];
      if (
        existing &&
        (existing.byteLength !== artifact.byteLength ||
          existing.mediaType !== artifact.mediaType ||
          existing.dataBase64 !== artifact.dataBase64)
      ) {
        throw new FigmaContractError(`SHA-256 collision while capturing render ${nodeId}.`);
      }
      artifacts[sha256] = existing ?? artifact;
      const path = `assets/${sha256}.${artifactExtension(mediaType)}`;
      renders[nodeId] = {
        status: "captured",
        artifact: { sha256, byteLength: bytes.byteLength, mediaType, path },
      };
      storedImages[nodeId] = `artifact:sha256:${sha256}`;
  }

  for (const [nodeId, source] of Object.entries(images)) {
    if (nodeId in storedImages) continue;
    const pointer = `/images/${nodeId.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (typeof source === "string") omitted.push({ endpoint: "renders", pointer, reason: "expiring-url" });
    storedImages[nodeId] = "render:unrequested";
    diagnostics.push({
      severity: "info",
      code: "unrequested_render_returned",
      message: "Figma returned an unrequested render entry; its key was preserved and any URL was omitted.",
      nodeId,
      pointer,
    });
  }

  return { response, renders, artifacts, diagnostics };
}

function validateFileResponse(response: JsonObject, requestedVersion: string): {
  returnedVersion: string;
  apiSchemaVersion: number | null;
  editorType: string | null;
} {
  if (typeof response.version !== "string") throw new FigmaContractError("Figma file response omitted its version ID.");
  if (response.version !== requestedVersion) {
    throw new FigmaContractError(
      `Figma returned version ${JSON.stringify(response.version)} for requested version ${JSON.stringify(requestedVersion)}.`,
    );
  }
  if (!isObject(response.document) || response.document.type !== "DOCUMENT") {
    throw new FigmaContractError("Figma file response omitted its DOCUMENT root.");
  }
  return {
    returnedVersion: response.version,
    apiSchemaVersion: typeof response.schemaVersion === "number" ? response.schemaVersion : null,
    editorType: typeof response.editorType === "string" ? response.editorType : null,
  };
}

function validRetryCount(value: number | undefined): number {
  const count = value ?? 3;
  if (!Number.isSafeInteger(count) || count < 0 || count > 10) {
    throw new FigmaExtractionInputError("maxRetries must be an integer between 0 and 10.");
  }
  return count;
}

function validRetryDelay(value: number | undefined): number {
  const delay = value ?? 60_000;
  if (!Number.isSafeInteger(delay) || delay < 0) {
    throw new FigmaExtractionInputError("maxRetryDelayMs must be a non-negative integer.");
  }
  return delay;
}

export async function verifyFigmaExtractionBundle(bundle: FigmaExtractionBundle): Promise<void> {
  if (!bundle || typeof bundle !== "object" || bundle.schemaVersion !== FIGMA_EXTRACTION_BUNDLE_SCHEMA) {
    throw new FigmaCacheError("Cached extraction has an unsupported bundle schema.");
  }
  if (
    !bundle.snapshot ||
    bundle.snapshot.schemaVersion !== FIGMA_RAW_SNAPSHOT_SCHEMA ||
    bundle.snapshot.extractorVersion !== FIGMA_EXTRACTOR_VERSION ||
    !bundle.snapshot.request ||
    !bundle.report ||
    bundle.report.schemaVersion !== FIGMA_EXTRACTION_REPORT_SCHEMA ||
    bundle.report.extractorVersion !== FIGMA_EXTRACTOR_VERSION ||
    !bundle.artifacts ||
    typeof bundle.artifacts !== "object"
  ) {
    throw new FigmaCacheError("Cached extraction is missing a required versioned contract.");
  }
  const expectedKey = figmaExtractionCacheKey(bundle.snapshot.request);
  if (bundle.cacheKey !== expectedKey || bundle.report.cacheKey !== expectedKey) {
    throw new FigmaCacheError("Cached extraction key does not match its normalized request.");
  }
  const snapshotHash = sha256Text(canonicalJson(asJsonValue(bundle.snapshot)));
  if (bundle.report.snapshotHash !== snapshotHash) {
    throw new FigmaCacheError("Cached extraction snapshot hash does not match its contents.");
  }
  if (
    canonicalJson(asJsonValue(bundle.report.source)) !== canonicalJson(asJsonValue(bundle.snapshot.source)) ||
    bundle.snapshot.source.requestedVersion !== bundle.snapshot.source.returnedVersion ||
    bundle.snapshot.responses.file.version !== bundle.snapshot.source.returnedVersion
  ) {
    throw new FigmaCacheError("Cached extraction source metadata does not match its pinned file response.");
  }
  for (const [key, artifact] of Object.entries(bundle.artifacts)) {
    const bytes = new Uint8Array(Buffer.from(artifact.dataBase64, "base64"));
    if (
      Buffer.from(bytes).toString("base64") !== artifact.dataBase64 ||
      key !== artifact.sha256 ||
      sha256Bytes(bytes) !== key ||
      bytes.byteLength !== artifact.byteLength
    ) {
      throw new FigmaCacheError(`Cached extraction artifact ${key} failed its integrity check.`);
    }
  }
  for (const render of Object.values(bundle.snapshot.referenceRenders)) {
    if (render.status !== "captured") continue;
    const artifact = bundle.artifacts[render.artifact.sha256];
    if (
      !artifact ||
      artifact.byteLength !== render.artifact.byteLength ||
      artifact.mediaType !== render.artifact.mediaType
    ) {
      throw new FigmaCacheError(`Captured render ${render.artifact.sha256} has no matching artifact bytes.`);
    }
  }
}

export class MemoryFigmaExtractionCache implements FigmaExtractionCache {
  readonly #entries = new Map<string, FigmaExtractionBundle>();

  async get(cacheKey: string): Promise<FigmaExtractionBundle | null> {
    const value = this.#entries.get(cacheKey);
    return value ? (JSON.parse(JSON.stringify(value)) as FigmaExtractionBundle) : null;
  }

  async put(cacheKey: string, bundle: FigmaExtractionBundle): Promise<void> {
    if (cacheKey !== bundle.cacheKey) throw new FigmaCacheError("Cache write key does not match the extraction bundle.");
    const existing = this.#entries.get(cacheKey);
    const serialized = canonicalJson(asJsonValue(bundle));
    if (existing && canonicalJson(asJsonValue(existing)) !== serialized) {
      throw new FigmaCacheError(`Cache key ${cacheKey} already contains different extraction bytes.`);
    }
    this.#entries.set(cacheKey, JSON.parse(serialized) as FigmaExtractionBundle);
  }
}

export async function extractFigma(
  input: FigmaExtractionOptions,
  dependencies: FigmaExtractorDependencies = {},
): Promise<FigmaExtractionResult> {
  const options = normalizeFigmaExtractionOptions(input);
  const cacheKey = figmaExtractionCacheKey(options);
  const cached = await dependencies.cache?.get(cacheKey);
  if (cached) {
    await verifyFigmaExtractionBundle(cached);
    return { bundle: deepFreeze(cached), cacheHit: true };
  }

  const fetchImpl = dependencies.fetch ?? fetch;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxRetries = validRetryCount(dependencies.maxRetries);
  const maxRetryDelayMs = validRetryDelay(dependencies.maxRetryDelayMs);
  const fileResponse = await requestJson(
    "file",
    apiUrl(options, "file"),
    fetchImpl,
    dependencies.accessToken,
    sleep,
    maxRetries,
    maxRetryDelayMs,
  );
  const sourceMetadata = validateFileResponse(fileResponse, options.version);
  const nodesResponse = options.nodeIds.length
    ? await requestJson(
        "nodes",
        apiUrl(options, "nodes"),
        fetchImpl,
        dependencies.accessToken,
        sleep,
        maxRetries,
        maxRetryDelayMs,
      )
    : null;
  if (nodesResponse?.version !== undefined && nodesResponse.version !== options.version) {
    throw new FigmaContractError("Figma selected-node response did not match the requested version ID.");
  }
  const rawRenderResponse = options.renders
    ? await requestJson(
        "renders",
        apiUrl(options, "renders"),
        fetchImpl,
        dependencies.accessToken,
        sleep,
        maxRetries,
        maxRetryDelayMs,
      )
    : null;

  const volatile: VolatileField[] = [];
  const captured = rawRenderResponse
    ? await captureRenders(rawRenderResponse, options, fetchImpl, volatile)
    : { response: null, renders: {}, artifacts: {}, diagnostics: [] };
  const stableFile = withoutVolatileRoot(fileResponse, "file", volatile);
  const stableNodes = nodesResponse ? withoutVolatileRoot(nodesResponse, "nodes", volatile) : null;
  const inspected = inspectExtraction(stableFile, stableNodes, options.nodeIds, captured.renders);
  const diagnostics = sortDiagnostics([...inspected.diagnostics, ...captured.diagnostics]);
  const source: RawFigmaSnapshot["source"] = {
    provider: "figma-rest",
    fileKey: options.fileKey,
    requestedVersion: options.version,
    returnedVersion: sourceMetadata.returnedVersion,
    apiSchemaVersion: sourceMetadata.apiSchemaVersion,
    editorType: sourceMetadata.editorType,
  };
  const snapshot: RawFigmaSnapshot = {
    schemaVersion: FIGMA_RAW_SNAPSHOT_SCHEMA,
    extractorVersion: FIGMA_EXTRACTOR_VERSION,
    source,
    request: options,
    responses: { file: stableFile, nodes: stableNodes, renders: captured.response },
    referenceRenders: captured.renders,
    volatile: {
      omitted: [...volatile].sort((a, b) =>
        [a.endpoint, a.pointer, a.reason].join("\0").localeCompare([b.endpoint, b.pointer, b.reason].join("\0")),
      ),
    },
  };
  const snapshotHash = sha256Text(canonicalJson(asJsonValue(snapshot)));
  const report = {
    schemaVersion: FIGMA_EXTRACTION_REPORT_SCHEMA,
    extractorVersion: FIGMA_EXTRACTOR_VERSION,
    cacheKey,
    snapshotHash,
    status: diagnostics.length ? "complete-with-diagnostics" : "complete",
    source,
    coverage: inspected.coverage,
    diagnostics,
  } as const;
  const bundle: FigmaExtractionBundle = {
    schemaVersion: FIGMA_EXTRACTION_BUNDLE_SCHEMA,
    cacheKey,
    snapshot,
    report,
    artifacts: captured.artifacts,
  };
  await verifyFigmaExtractionBundle(bundle);
  const frozen = deepFreeze(bundle);
  await dependencies.cache?.put(cacheKey, frozen);
  return { bundle: frozen, cacheHit: false };
}
