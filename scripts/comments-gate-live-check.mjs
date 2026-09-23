import { build } from "esbuild";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// SPENDS A PAID KEY — see comments-gate-live-check.ts. Checked here too, so a
// run without approval does not even bundle.
if (process.env.COMMENTS_GATE_LIVE_CHECK !== "I_HAVE_APPROVAL") {
  throw new Error(
    "Refusing to call a paid model without COMMENTS_GATE_LIVE_CHECK=I_HAVE_APPROVAL.",
  );
}

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const outfile = path.join(
  await mkdtemp(path.join(tmpdir(), "comments-gate-live-")),
  "check.bundle.mjs",
);
await build({
  absWorkingDir: repo,
  entryPoints: ["scripts/comments-gate-live-check.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile,
  tsconfig: "tsconfig.json",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  logLevel: "warning",
});
await import(pathToFileURL(outfile).href);
