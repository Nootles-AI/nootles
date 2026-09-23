/**
 * Runs the comment browser harnesses and reports on all of them, as
 * canvas-browser.mjs does for the canvas: one harness's verdict is not the
 * gate's, so a red one never stops the rest from being heard.
 *
 *   node tests/comments-browser.mjs              the hermetic harnesses: a
 *                                                stand-in Convex, no backend
 *   node tests/comments-browser.mjs --fullstack  the two that run a throwaway
 *                                                convex-local-backend
 *
 * Sequential, so no two Chromiums (or backends) contend for one runner, and
 * each harness is killed after `COMMENTS_HARNESS_TIMEOUT_MS` (default ten
 * minutes, the full-stack pair twelve — past the e2e suite's own watchdog) rather than holding the job open.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const HERMETIC = [
  "comments-channel.browser",
  "comments-store.browser",
  "comments-share.browser",
  "comments-inbox.browser",
  "comments-audit.browser",
  "comments-anchor.browser",
  "comments-assistant.browser",
  "comments-surfaces.browser",
  "comments-ui.browser",
];
const FULLSTACK = ["comments-surfaces.fullstack", "comments-e2e.fullstack"];

const fullstack = process.argv.includes("--fullstack");
const harnesses = fullstack ? FULLSTACK : HERMETIC;
const limit = Number(process.env.COMMENTS_HARNESS_TIMEOUT_MS) || (fullstack ? 12 : 10) * 60_000;

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(here, `${name}.mjs`)], { stdio: "inherit", env: process.env });
    const timer = setTimeout(() => {
      console.error(`\n${name}: no verdict after ${limit / 60_000} minutes; stopping it`);
      child.kill("SIGTERM");
    }, limit);
    const done = (code) => {
      clearTimeout(timer);
      resolve({ code, seconds: Math.round((Date.now() - started) / 1000) });
    };
    child.on("error", () => done(1));
    child.on("close", (code, signal) => done(signal ? 1 : (code ?? 1)));
  });
}

const results = [];
for (const name of harnesses) {
  console.log(`\n===== ${name} =====`);
  results.push([name, await run(name)]);
}

console.log(`\n===== comment browser gate${fullstack ? " (full stack)" : ""} =====`);
for (const [name, { code, seconds }] of results) {
  console.log(`  ${code === 0 ? "pass" : "FAIL"}  ${name}  (${seconds}s)`);
}

const failed = results.filter(([, { code }]) => code !== 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${results.length} comment harnesses failed: ${failed.map(([name]) => name).join(", ")}`);
  process.exitCode = 1;
}
