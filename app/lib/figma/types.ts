export const FIGMA_EXTRACTOR_VERSION = "1.0.0";
export const FIGMA_RAW_SNAPSHOT_SCHEMA = "nootles.raw-figma-snapshot.v1";
export const FIGMA_EXTRACTION_REPORT_SCHEMA = "nootles.figma-extraction-report.v1";
export const FIGMA_EXTRACTION_BUNDLE_SCHEMA = "nootles.figma-extraction-bundle.v1";
export const FIGMA_EXTRACTION_MANIFEST_SCHEMA = "nootles.figma-extraction-manifest.v1";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type FigmaRenderFormat = "jpg" | "png" | "svg" | "pdf";

export interface FigmaRenderOptions {
  readonly nodeIds: readonly string[];
  readonly format?: FigmaRenderFormat;
  readonly scale?: number;
  readonly contentsOnly?: boolean;
  readonly useAbsoluteBounds?: boolean;
  readonly svgOutlineText?: boolean;
  readonly svgIncludeId?: boolean;
  readonly svgIncludeNodeId?: boolean;
  readonly svgSimplifyStroke?: boolean;
}

export interface FigmaExtractionOptions {
  readonly fileKey: string;
  /** Required: the extractor never silently reads "latest". */
  readonly version: string;
  readonly nodeIds?: readonly string[];
  readonly geometry?: "paths" | "none";
  readonly depth?: number;
  readonly pluginData?: readonly string[];
  readonly renders?: FigmaRenderOptions;
  readonly apiBaseUrl?: string;
  readonly maxAssetBytes?: number;
}

export interface NormalizedFigmaExtractionOptions {
  readonly fileKey: string;
  readonly version: string;
  readonly nodeIds: readonly string[];
  readonly geometry: "paths" | "none";
  readonly depth: number | null;
  readonly pluginData: readonly string[];
  readonly renders: {
    readonly nodeIds: readonly string[];
    readonly format: FigmaRenderFormat;
    readonly scale: number;
    readonly contentsOnly: boolean;
    readonly useAbsoluteBounds: boolean;
    readonly svgOutlineText: boolean;
    readonly svgIncludeId: boolean;
    readonly svgIncludeNodeId: boolean;
    readonly svgSimplifyStroke: boolean;
  } | null;
  readonly apiBaseUrl: string;
  readonly maxAssetBytes: number;
}

export interface ExtractionArtifact {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly dataBase64: string;
}

export interface ArtifactReference {
  readonly sha256: string;
  readonly byteLength: number;
  readonly mediaType: string;
  readonly path: string;
}

export type ReferenceRender =
  | { readonly status: "captured"; readonly artifact: ArtifactReference }
  | { readonly status: "null" }
  | { readonly status: "unavailable"; readonly httpStatus: number | null }
  | { readonly status: "invalid-url" }
  | { readonly status: "invalid-content-type"; readonly mediaType: string }
  | { readonly status: "too-large"; readonly byteLength: number | null };

export interface VolatileField {
  readonly endpoint: "file" | "nodes" | "renders";
  readonly pointer: string;
  readonly reason: "caller-dependent" | "current-file-metadata" | "expiring-url";
}

export interface RawFigmaSnapshot {
  readonly schemaVersion: typeof FIGMA_RAW_SNAPSHOT_SCHEMA;
  readonly extractorVersion: typeof FIGMA_EXTRACTOR_VERSION;
  readonly source: {
    readonly provider: "figma-rest";
    readonly fileKey: string;
    readonly requestedVersion: string;
    readonly returnedVersion: string;
    readonly apiSchemaVersion: number | null;
    readonly editorType: string | null;
  };
  readonly request: NormalizedFigmaExtractionOptions;
  readonly responses: {
    /** Exact JSON except for fields enumerated in `volatile.omitted`. */
    readonly file: JsonObject;
    readonly nodes: JsonObject | null;
    /** Render URLs are replaced by deterministic artifact URIs or status strings. */
    readonly renders: JsonObject | null;
  };
  readonly referenceRenders: Readonly<Record<string, ReferenceRender>>;
  readonly volatile: {
    /** Values are deliberately not retained; their original JSON pointers remain explicit. */
    readonly omitted: readonly VolatileField[];
  };
}

export interface ExtractionDiagnostic {
  readonly severity: "info" | "warning";
  readonly code: string;
  readonly message: string;
  readonly nodeId?: string;
  readonly pointer?: string;
  readonly httpStatus?: number;
}

export interface ExtractionCoverage {
  readonly documentNodes: number;
  readonly malformedNodes: number;
  readonly components: number;
  readonly componentSets: number;
  readonly styles: number;
  readonly interactions: number;
  readonly imageFillReferences: number;
  readonly vectorGeometryEntries: number;
  readonly boundVariableReferences: number;
  readonly selectedNodesRequested: number;
  readonly selectedNodesCaptured: number;
  readonly selectedNodesMissing: number;
  readonly selectedComponentDependencies: number;
  readonly referenceRendersRequested: number;
  readonly referenceRendersCaptured: number;
  readonly referenceRendersMissing: number;
  /** The extractor is lossless for nonvolatile API JSON; unknown fields remain in the snapshot. */
  readonly unknownResponseFields: "preserved";
  /** Figma has no version parameter on its variable-definition endpoint. */
  readonly variables: "bound-references-only" | "none-observed";
}

export interface FigmaExtractionReport {
  readonly schemaVersion: typeof FIGMA_EXTRACTION_REPORT_SCHEMA;
  readonly extractorVersion: typeof FIGMA_EXTRACTOR_VERSION;
  readonly cacheKey: string;
  readonly snapshotHash: string;
  readonly status: "complete" | "complete-with-diagnostics";
  readonly source: RawFigmaSnapshot["source"];
  readonly coverage: ExtractionCoverage;
  readonly diagnostics: readonly ExtractionDiagnostic[];
}

export interface FigmaExtractionBundle {
  readonly schemaVersion: typeof FIGMA_EXTRACTION_BUNDLE_SCHEMA;
  readonly cacheKey: string;
  readonly snapshot: RawFigmaSnapshot;
  readonly report: FigmaExtractionReport;
  readonly artifacts: Readonly<Record<string, ExtractionArtifact>>;
}

export interface FigmaExtractionCache {
  get(cacheKey: string): Promise<FigmaExtractionBundle | null>;
  put(cacheKey: string, bundle: FigmaExtractionBundle): Promise<void>;
}

export interface FigmaExtractorDependencies {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly cache?: FigmaExtractionCache;
  readonly accessToken?: string;
  readonly maxRetries?: number;
  readonly maxRetryDelayMs?: number;
}

export interface FigmaExtractionResult {
  readonly bundle: FigmaExtractionBundle;
  readonly cacheHit: boolean;
}
