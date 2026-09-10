import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(here, "dist");
await mkdir(out, { recursive: true });

await build({
  entryPoints: [resolve(here, "src/cli.ts")],
  bundle: true,
  outfile: resolve(out, "nootles-figma-extract.mjs"),
  tsconfig: resolve(root, "tsconfig.json"),
  platform: "node",
  target: "node20",
  format: "esm",
  logLevel: "info",
});
