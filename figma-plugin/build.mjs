import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Bundle the plugin's main thread into the one file Figma loads.
 *
 * Run from the repository root with `npm run figma:build`. The bundle pulls
 * the canvas's own grammar modules in through the root tsconfig's `@/` alias,
 * which is the whole point: the plugin writes the document the way the app
 * does, from the same code. The UI is a single HTML file and is copied as is.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const out = resolve(here, "dist");
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [resolve(here, "src/code.ts")],
  bundle: true,
  outfile: resolve(out, "code.js"),
  tsconfig: resolve(root, "tsconfig.json"),
  // Figma's plugin sandbox: no DOM, no Node, ES2017 at best.
  platform: "neutral",
  target: "es2017",
  format: "iife",
  mainFields: ["module", "main"],
  logLevel: "info",
});

copyFileSync(resolve(here, "src/ui.html"), resolve(out, "ui.html"));
