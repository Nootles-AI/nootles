// @vitest-environment node

import { Buffer } from "node:buffer";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import fileFixture from "./__fixtures__/recorded-file.json";
import nodesFixture from "./__fixtures__/recorded-nodes.json";
import { canonicalJson } from "./canonical";
import {
  extractFigma,
  FigmaCacheError,
  FigmaContractError,
  FigmaExtractionInputError,
  MemoryFigmaExtractionCache,
} from "./extractor";
import { writeFigmaExtraction } from "./fs";
import type { FigmaExtractionBundle, JsonObject, JsonValue } from "./types";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });

const fixture = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function recordedFetch(options: {
  file?: JsonObject;
  nodes?: JsonObject;
  renderUrl?: string;
  assetStatus?: number;
  nullRender?: boolean;
} = {}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.figma.test" && url.pathname === "/v1/files/file-key") {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
      expect(url.searchParams.get("version")).toBe("9001");
      expect(url.searchParams.get("geometry")).toBe("paths");
      return json(options.file ?? fixture(fileFixture));
    }
    if (url.hostname === "api.figma.test" && url.pathname === "/v1/files/file-key/nodes") {
      expect(url.searchParams.get("ids")).toBe("1:2,404:1");
      expect(url.searchParams.get("version")).toBe("9001");
      return json(options.nodes ?? fixture(nodesFixture));
    }
    if (url.hostname === "api.figma.test" && url.pathname === "/v1/images/file-key") {
      expect(url.searchParams.get("ids")).toBe("1:2,2:2");
      expect(url.searchParams.get("version")).toBe("9001");
      return json({
        images: {
          "1:2": options.renderUrl ?? "https://assets.figma.test/render-a",
          "2:2": options.nullRender === false ? "https://assets.figma.test/render-b" : null,
        },
      });
    }
    if (url.hostname === "assets.figma.test") {
      if (options.assetStatus && options.assetStatus !== 200) return new Response(null, { status: options.assetStatus });
      return new Response(Buffer.from("stable-png"), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "10" },
      });
    }
    throw new Error(`Unexpected request ${url}`);
  }) as typeof fetch;
}

const extractionOptions = {
  fileKey: "file-key",
  version: "9001",
  nodeIds: ["404:1", "1:2", "1:2"],
  renders: { nodeIds: ["2:2", "1:2"], format: "png" as const },
  apiBaseUrl: "https://api.figma.test",
};

describe("versioned Figma extraction", () => {
  it("captures recorded file/node responses and content-addressed reference renders", async () => {
    const result = await extractFigma(extractionOptions, {
      fetch: recordedFetch(),
      accessToken: "test-token",
    });
    const { bundle } = result;

    expect(result.cacheHit).toBe(false);
    expect(bundle.snapshot.source).toMatchObject({
      fileKey: "file-key",
      requestedVersion: "9001",
      returnedVersion: "9001",
      apiSchemaVersion: 0,
      editorType: "figma",
    });
    expect(bundle.report.coverage).toEqual({
      documentNodes: 7,
      malformedNodes: 0,
      components: 1,
      componentSets: 1,
      styles: 1,
      interactions: 1,
      imageFillReferences: 1,
      vectorGeometryEntries: 1,
      boundVariableReferences: 1,
      selectedNodesRequested: 2,
      selectedNodesCaptured: 1,
      selectedNodesMissing: 1,
      selectedComponentDependencies: 2,
      referenceRendersRequested: 2,
      referenceRendersCaptured: 1,
      referenceRendersMissing: 1,
      unknownResponseFields: "preserved",
      variables: "bound-references-only",
    });
    expect(bundle.snapshot.responses.file.document).toMatchObject({ futureDocumentField: "preserve-me" });
    expect(bundle.snapshot.responses.nodes).toMatchObject({
      nodes: { "1:2": { components: { "10:1": { key: "component-key" } } } },
    });
    expect(bundle.snapshot.responses.file).not.toHaveProperty("thumbnailUrl");
    expect(bundle.snapshot.volatile.omitted).toContainEqual({
      endpoint: "file",
      pointer: "/thumbnailUrl",
      reason: "expiring-url",
    });
    expect(bundle.report.diagnostics.map((entry) => entry.code)).toEqual([
      "bound_variable_references_only",
      "render_null",
      "selected_node_missing",
    ]);
    expect(bundle.snapshot.referenceRenders["1:2"]).toMatchObject({
      status: "captured",
      artifact: { byteLength: 10, mediaType: "image/png" },
    });
    expect(bundle.snapshot.referenceRenders["2:2"]).toEqual({ status: "null" });
    const serialized = canonicalJson(bundle as unknown as JsonValue);
    expect(serialized).not.toContain("assets.figma.test");
    expect(serialized).not.toContain("test-token");
    expect(Object.keys(bundle.artifacts)).toHaveLength(1);
    expect(Object.isFrozen(bundle)).toBe(true);
  });

  it("is byte-stable when Figma rotates volatile source URLs", async () => {
    const firstFile = fixture(fileFixture) as unknown as JsonObject;
    const secondFile = fixture(fileFixture) as unknown as JsonObject;
    firstFile.thumbnailUrl = "https://temporary.figma.test/first";
    secondFile.thumbnailUrl = "https://temporary.figma.test/second";
    const firstNodes = fixture(nodesFixture) as unknown as JsonObject;
    const secondNodes = fixture(nodesFixture) as unknown as JsonObject;
    firstNodes.thumbnailUrl = "https://temporary.figma.test/nodes-first";
    secondNodes.thumbnailUrl = "https://temporary.figma.test/nodes-second";

    const first = await extractFigma(extractionOptions, {
      fetch: recordedFetch({ file: firstFile, nodes: firstNodes, renderUrl: "https://assets.figma.test/first" }),
      accessToken: "test-token",
    });
    const second = await extractFigma(extractionOptions, {
      fetch: recordedFetch({ file: secondFile, nodes: secondNodes, renderUrl: "https://assets.figma.test/second" }),
      accessToken: "test-token",
    });
    expect(canonicalJson(first.bundle as unknown as JsonValue)).toBe(
      canonicalJson(second.bundle as unknown as JsonValue),
    );
  });

  it("honors Retry-After within a bounded retry budget", async () => {
    let attempts = 0;
    const fetchImpl = vi.fn(async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(null, { status: 429, headers: { "retry-after": "2" } })
        : json(fixture(fileFixture));
    }) as typeof fetch;
    const sleep = vi.fn(async () => undefined);
    await extractFigma(
      { fileKey: "file-key", version: "9001", apiBaseUrl: "https://api.figma.test" },
      { fetch: fetchImpl, sleep, maxRetries: 1 },
    );
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
  });

  it("fails closed instead of retrying before a Retry-After longer than the allowed wait", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(null, {
        status: 429,
        headers: {
          "retry-after": "120",
          "x-figma-plan-tier": "starter",
          "x-figma-rate-limit-type": "low",
          "x-figma-upgrade-link": "https://figma.com/pricing",
        },
      }),
    ) as typeof fetch;
    await expect(
      extractFigma(
        { fileKey: "file-key", version: "9001", apiBaseUrl: "https://api.figma.test" },
        { fetch: fetchImpl, maxRetries: 3, maxRetryDelayMs: 60_000 },
      ),
    ).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 120,
      planTier: "starter",
      rateLimitType: "low",
      upgradeUrl: "https://figma.com/pricing",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-retryable API error after one attempt", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 })) as typeof fetch;
    await expect(
      extractFigma(
        { fileKey: "file-key", version: "9001", apiBaseUrl: "https://api.figma.test" },
        { fetch: fetchImpl, maxRetries: 3 },
      ),
    ).rejects.toMatchObject({ name: "FigmaHttpError", endpoint: "file", status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports expired assets and null renders without retaining their URLs", async () => {
    const result = await extractFigma(extractionOptions, {
      fetch: recordedFetch({ assetStatus: 403 }),
      accessToken: "test-token",
    });
    expect(result.bundle.snapshot.referenceRenders).toEqual({
      "1:2": { status: "unavailable", httpStatus: 403 },
      "2:2": { status: "null" },
    });
    expect(result.bundle.report.diagnostics.map((entry) => entry.code)).toEqual([
      "bound_variable_references_only",
      "render_asset_unavailable",
      "render_null",
      "selected_node_missing",
    ]);
    expect(canonicalJson(result.bundle as unknown as JsonValue)).not.toContain("assets.figma.test");
  });

  it("rejects a successful asset response with the wrong media type", async () => {
    const fetchImpl = recordedFetch();
    vi.mocked(fetchImpl).mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "assets.figma.test") {
        return new Response("expired", { status: 200, headers: { "content-type": "text/html" } });
      }
      return recordedFetch()(input, init);
    });
    const result = await extractFigma(extractionOptions, { fetch: fetchImpl, accessToken: "test-token" });
    expect(result.bundle.snapshot.referenceRenders["1:2"]).toEqual({
      status: "invalid-content-type",
      mediaType: "text/html",
    });
    expect(result.bundle.report.diagnostics.map((entry) => entry.code)).toContain("render_content_type_mismatch");
    expect(result.bundle.artifacts).toEqual({});
  });

  it("reports a render above the configured byte ceiling without reading it into the bundle", async () => {
    const result = await extractFigma(
      { ...extractionOptions, maxAssetBytes: 5 },
      { fetch: recordedFetch(), accessToken: "test-token" },
    );
    expect(result.bundle.snapshot.referenceRenders["1:2"]).toEqual({ status: "too-large", byteLength: 10 });
    expect(result.bundle.report.diagnostics.map((entry) => entry.code)).toContain("render_asset_too_large");
    expect(result.bundle.artifacts).toEqual({});
  });

  it("reports malformed descendants while preserving their raw values", async () => {
    const malformed = fixture(fileFixture) as unknown as JsonObject;
    const document = malformed.document as JsonObject;
    const pages = document.children as JsonValue[];
    const page = pages[0] as JsonObject;
    const children = page.children as JsonValue[];
    children.push({ id: "bad:1", name: 42, type: "FRAME", children: "not-an-array" });
    const result = await extractFigma(
      { fileKey: "file-key", version: "9001", apiBaseUrl: "https://api.figma.test" },
      { fetch: recordedFetch({ file: malformed }), accessToken: "test-token" },
    );
    expect(result.bundle.report.coverage.malformedNodes).toBe(2);
    expect(result.bundle.report.diagnostics.map((entry) => entry.code)).toEqual([
      "bound_variable_references_only",
      "malformed_children",
      "malformed_node",
    ]);
    expect(((((result.bundle.snapshot.responses.file.document as JsonObject).children as JsonValue[])[0] as JsonObject).children as JsonValue[])[2]).toMatchObject({
      id: "bad:1",
      name: 42,
      children: "not-an-array",
    });
  });

  it("rejects an unpinned response version", async () => {
    const wrong = fixture(fileFixture) as unknown as JsonObject;
    wrong.version = "9002";
    await expect(
      extractFigma(
        { fileKey: "file-key", version: "9001", apiBaseUrl: "https://api.figma.test" },
        { fetch: recordedFetch({ file: wrong }), accessToken: "test-token" },
      ),
    ).rejects.toBeInstanceOf(FigmaContractError);
  });

  it("rejects latest and other missing extraction identity before fetching", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(extractFigma({ fileKey: "file-key", version: "latest" }, { fetch: fetchImpl }))
      .rejects.toBeInstanceOf(FigmaExtractionInputError);
    await expect(extractFigma({ fileKey: " ", version: "9001" }, { fetch: fetchImpl }))
      .rejects.toBeInstanceOf(FigmaExtractionInputError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses an integrity-checked cache without making another request", async () => {
    const cache = new MemoryFigmaExtractionCache();
    const fetchImpl = recordedFetch();
    const first = await extractFigma(extractionOptions, {
      fetch: fetchImpl,
      accessToken: "test-token",
      cache,
    });
    const calls = vi.mocked(fetchImpl).mock.calls.length;
    const second = await extractFigma(extractionOptions, { fetch: fetchImpl, cache });
    expect(second.cacheHit).toBe(true);
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(calls);
    expect(canonicalJson(first.bundle as unknown as JsonValue)).toBe(
      canonicalJson(second.bundle as unknown as JsonValue),
    );
  });

  it("rejects a corrupt cache entry", async () => {
    const cache = {
      get: vi.fn(async () => ({ schemaVersion: "wrong" }) as unknown as FigmaExtractionBundle),
      put: vi.fn(),
    };
    await expect(extractFigma(extractionOptions, { cache })).rejects.toBeInstanceOf(FigmaCacheError);
  });

  it("writes canonical JSON and render bytes without replacing a changed output", async () => {
    const root = await mkdtemp(join(tmpdir(), "nootles-figma-extractor-"));
    try {
      const result = await extractFigma(extractionOptions, {
        fetch: recordedFetch(),
        accessToken: "test-token",
      });
      const paths = await writeFigmaExtraction(root, result.bundle);
      await writeFigmaExtraction(root, result.bundle);
      const snapshot = await readFile(paths.snapshotPath, "utf8");
      expect(snapshot).toBe(`${canonicalJson(result.bundle.snapshot as unknown as JsonValue)}\n`);
      const render = result.bundle.snapshot.referenceRenders["1:2"];
      if (render.status !== "captured") throw new Error("Fixture render was not captured");
      expect(await readFile(join(root, render.artifact.path), "utf8")).toBe("stable-png");

      await writeFile(paths.reportPath, "{}\n");
      await expect(writeFigmaExtraction(root, result.bundle)).rejects.toBeInstanceOf(FigmaCacheError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
