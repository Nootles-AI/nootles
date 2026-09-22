/**
 * Runs every canvas browser harness and reports on all of them.
 *
 * This used to be `a && b && c && d` in `package.json`, which stops at the
 * first failure — so when `canvas-block-drag` went red on 2026-09-16 the
 * other three stopped running on `main` entirely, and a real break in
 * `canvas-stage` landed five days later without anyone hearing about it
 * (NT-72). One harness's verdict is not the gate's; the gate is all four.
 *
 * Sequential on purpose: `canvas-camera` measures frame timing, and a second
 * Chromium on the same machine is exactly the noise its gate is trying to
 * read through.
 *
 *   node tests/canvas-browser.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const HARNESSES = [
  "canvas-block-drag",
  "canvas-picking",
  "canvas-camera",
  "canvas-stage",
];

function run(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, `${name}.browser.mjs`)], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

const results = [];
for (const name of HARNESSES) {
  console.log(`\n===== ${name} =====`);
  results.push([name, await run(name)]);
}

console.log("\n===== canvas browser gate =====");
for (const [name, code] of results) {
  console.log(`  ${code === 0 ? "pass" : "FAIL"}  ${name}`);
}

const failed = results.filter(([, code]) => code !== 0);
if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${results.length} canvas harnesses failed: ${failed
      .map(([name]) => name)
      .join(", ")}`,
  );
  process.exitCode = 1;
}
