import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DirectoryFigmaExtractionCache,
  extractFigma,
  FigmaTransportError,
  writeFigmaExtraction,
  type FigmaExtractionOptions,
  type FigmaRenderFormat,
} from "../../app/lib/figma";

const HELP = `Usage: nootles-figma-extract --file-key KEY --version VERSION --output DIR [options]

The CLI is network-disabled by default. It can materialize an existing --cache entry
without credentials. A live Figma run requires --allow-network and FIGMA_ACCESS_TOKEN,
and remains subject to the workspace's per-run operator approval rule.

Options:
  --file-key KEY          Figma file or branch key (required)
  --version VERSION       Exact Figma version ID (required; "latest" is not supported)
  --output DIR            New or byte-identical extraction directory (required)
  --cache DIR             Content-addressed cache directory
  --nodes IDS             Comma-separated selected node IDs
  --render-nodes IDS      Comma-separated node IDs for reference renders
                          (defaults to --nodes; use --no-renders to disable)
  --render-format FORMAT  png (default), jpg, svg, or pdf
  --render-scale NUMBER   0.01 through 4 (default 1)
  --depth NUMBER          Positive file-tree depth
  --plugin-data IDS       Comma-separated plugin IDs and/or shared
  --no-geometry           Do not request vector paths (paths are on by default)
  --no-renders            Do not render selected nodes
  --max-retries NUMBER    Bounded API retries, 0 through 10 (default 3)
  --allow-network         Permit Figma API and signed-asset requests for this invocation
  --help                   Show this text
`;

export interface CliConfig {
  readonly extraction: FigmaExtractionOptions;
  readonly output: string;
  readonly cache: string | null;
  readonly allowNetwork: boolean;
  readonly maxRetries: number;
  readonly help: boolean;
}

function argument(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function ids(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseCliArgs(argv: readonly string[]): CliConfig {
  let fileKey = "";
  let version = "";
  let output = "";
  let cache: string | null = null;
  const nodeIds: string[] = [];
  let renderNodeIds: string[] | null = null;
  let renderFormat: FigmaRenderFormat = "png";
  let renderScale = 1;
  let depth: number | undefined;
  const pluginData: string[] = [];
  let geometry: "paths" | "none" = "paths";
  let noRenders = false;
  let allowNetwork = false;
  let maxRetries = 3;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--file-key": fileKey = argument(argv, index++, flag); break;
      case "--version": version = argument(argv, index++, flag); break;
      case "--output": output = argument(argv, index++, flag); break;
      case "--cache": cache = argument(argv, index++, flag); break;
      case "--nodes": nodeIds.push(...ids(argument(argv, index++, flag))); break;
      case "--render-nodes": renderNodeIds = [...(renderNodeIds ?? []), ...ids(argument(argv, index++, flag))]; break;
      case "--render-format": renderFormat = argument(argv, index++, flag) as FigmaRenderFormat; break;
      case "--render-scale": renderScale = Number(argument(argv, index++, flag)); break;
      case "--depth": depth = Number(argument(argv, index++, flag)); break;
      case "--plugin-data": pluginData.push(...ids(argument(argv, index++, flag))); break;
      case "--max-retries": maxRetries = Number(argument(argv, index++, flag)); break;
      case "--no-geometry": geometry = "none"; break;
      case "--no-renders": noRenders = true; break;
      case "--allow-network": allowNetwork = true; break;
      case "--help": help = true; break;
      default: throw new Error(`Unknown option ${flag}.`);
    }
  }

  if (help) {
    return {
      extraction: { fileKey: "help", version: "help" },
      output: "",
      cache,
      allowNetwork,
      maxRetries,
      help,
    };
  }
  if (!fileKey) throw new Error("--file-key is required.");
  if (!version) throw new Error("--version is required; the extractor never reads latest implicitly.");
  if (!output) throw new Error("--output is required.");
  if (version.toLowerCase() === "latest") throw new Error('--version must be an exact Figma version ID, not "latest".');
  const requestedRenders = noRenders ? [] : (renderNodeIds ?? nodeIds);
  return {
    extraction: {
      fileKey,
      version,
      nodeIds,
      geometry,
      ...(depth === undefined ? {} : { depth }),
      pluginData,
      ...(requestedRenders.length
        ? { renders: { nodeIds: requestedRenders, format: renderFormat, scale: renderScale } }
        : {}),
    },
    output: resolve(output),
    cache: cache ? resolve(cache) : null,
    allowNetwork,
    maxRetries,
    help,
  };
}

export async function runCli(argv: readonly string[]): Promise<void> {
  const config = parseCliArgs(argv);
  if (config.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!config.cache && !config.allowNetwork) {
    throw new Error("Network is disabled and no --cache directory was provided.");
  }
  const accessToken = config.allowNetwork ? process.env.FIGMA_ACCESS_TOKEN : undefined;
  if (config.allowNetwork && !accessToken) {
    throw new Error("--allow-network requires FIGMA_ACCESS_TOKEN in the environment.");
  }
  const offlineFetch: typeof fetch = async () => {
    throw new Error("The requested extraction was not cached and network access is disabled.");
  };
  let result: Awaited<ReturnType<typeof extractFigma>>;
  try {
    result = await extractFigma(config.extraction, {
      accessToken,
      maxRetries: config.maxRetries,
      cache: config.cache ? new DirectoryFigmaExtractionCache(config.cache) : undefined,
      ...(!config.allowNetwork ? { fetch: offlineFetch, maxRetries: 0 } : {}),
    });
  } catch (error) {
    if (!config.allowNetwork && error instanceof FigmaTransportError) {
      throw new Error("The requested extraction was not cached; network access remains disabled.");
    }
    throw error;
  }
  const paths = await writeFigmaExtraction(config.output, result.bundle);
  process.stdout.write(
    `${JSON.stringify({
      cacheHit: result.cacheHit,
      cacheKey: result.bundle.cacheKey,
      snapshotHash: result.bundle.report.snapshotHash,
      status: result.bundle.report.status,
      manifest: paths.manifestPath,
      report: paths.reportPath,
    })}\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
