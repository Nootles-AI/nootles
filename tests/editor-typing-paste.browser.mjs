/**
 * Notion's typing and paste conveniences, driven through real Chromium input.
 *
 * - `1) ` starts a numbered list, as `1. ` does.
 * - `->` `<-` `--` `=>` `...` `<=` `>=` `!=` become → ← — ⇒ … ≤ ≥ ≠ as they are
 *   typed; `~text~` strikes through; `$$x^2$$` becomes an inline equation.
 *   Never inside inline code, and ⌘Z straight after gives back what was typed —
 *   on both undo pipelines: the Yjs doc's own history on the workspace spine,
 *   and ProseMirror's on a legacy doc.
 * - ⌘⇧V pastes the clipboard's text without its formatting. Chrome on a Mac
 *   sends no paste event for the chord at all, which is the case the real key
 *   press below exercises; the event other platforms do send is dispatched.
 * - Pasted markdown with `---` straight under a line gives a divider, not a
 *   setext heading.
 *
 * Uses the existing esbuild dependency and Playwright's Chromium. No app
 * server, no Convex, no API keys — and every non-local request fails the run,
 * so no AI lane can be spent by typing in here.
 *
 *   node tests/editor-typing-paste.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "editor-typing-paste-"));

await build({
  absWorkingDir: repo, entryPoints: ["tests/editor-typing-paste.browser.tsx"], bundle: true, splitting: true,
  format: "esm", outdir: output, platform: "browser", conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/editor-typing-paste.browser.css"><style>body{margin:24px;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module" src="/editor-typing-paste.browser.js"></script></body></html>`);

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); return void response.end(); }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) return void console.log(`  ok   ${name}`);
  failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
  console.log(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
};
const MOD = process.platform === "darwin" ? "Meta" : "Control";

let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") failures.push(`console error: ${message.text()}`);
  });
  await page.route("**/*", (route) => {
    if (route.request().url().startsWith(origin)) return route.continue();
    failures.push(`request left the fixture: ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(origin);
  await page.waitForFunction(() => !!window.typingPaste);

  const fresh = async (pipeline) => {
    await page.evaluate((p) => window.typingPaste.mount(p), pipeline);
    await page.waitForSelector(".bn-editor");
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await page.evaluate(() => window.typingPaste.focusEnd());
  };
  const doc = () => page.evaluate(() => window.typingPaste.document());
  const first = async () => (await doc())[0];
  // Past the Yjs capture window, so what was typed before is a step of its own.
  const pause = () => page.waitForTimeout(700);
  const undo = () => page.keyboard.press(`${MOD}+z`);

  for (const pipeline of ["yjs", "legacy"]) {
    console.log(`\n[${pipeline}] numbered lists`);
    for (const [typed, start] of [["1) ", 1], ["5) ", 5], ["1. ", 1]]) {
      await fresh(pipeline);
      await page.keyboard.type(`${typed}item`);
      check(`${JSON.stringify(typed)} starts a numbered list`, await first(), { type: "numberedListItem", start, runs: ["item"] });
    }
    await fresh(pipeline);
    await page.keyboard.type("# Title");
    await page.waitForTimeout(50);
    await page.keyboard.press("Home");
    await page.keyboard.type("1) ");
    check("`1) ` in a heading stays text", await first(), { type: "heading", runs: ["1) Title"] });

    console.log(`\n[${pipeline}] typography`);
    for (const [typed, want] of [
      ["a -> b", "a → b"], ["a <- b", "a ← b"], ["a -- b", "a — b"], ["a => b", "a ⇒ b"],
      ["wait...", "wait…"], ["x <= y", "x ≤ y"], ["x >= y", "x ≥ y"], ["x != y", "x ≠ y"],
    ]) {
      await fresh(pipeline);
      await page.keyboard.type(typed);
      check(`${JSON.stringify(typed)} reads ${JSON.stringify(want)}`, (await first()).runs, [want]);
    }

    await fresh(pipeline);
    await page.keyboard.type("go ");
    await pause();
    await page.keyboard.type("->");
    check("-> becomes an arrow", (await first()).runs, ["go →"]);
    await undo();
    check("⌘Z straight after gives back the literal ->", (await first()).runs, ["go ->"]);
    await undo();
    check("the next ⌘Z takes the typing back", (await first()).runs, ["go "]);

    await fresh(pipeline);
    await page.keyboard.type("a -> b");
    await pause();
    await undo();
    check("typing after a replacement is a step of its own", (await first()).runs, ["a →"]);

    await fresh(pipeline);
    await page.keyboard.type("---");
    check("--- is still a divider", (await doc()).map((b) => b.type).slice(0, 1), ["divider"]);

    await fresh(pipeline);
    await page.keyboard.type("x ");
    await page.keyboard.press(`${MOD}+e`);
    await page.keyboard.type("a->b...");
    check("inline code keeps its characters", (await first()).runs, ["x ", "a->b...[code]"]);

    console.log(`\n[${pipeline}] ~strike~ and $$equation$$`);
    await fresh(pipeline);
    await page.keyboard.type("keep ~gone~ here");
    check("~text~ strikes through", (await first()).runs, ["keep ", "gone[strike]", " here"]);
    await fresh(pipeline);
    await page.keyboard.type("keep ~~gone~~ here");
    check("~~text~~ still strikes through", (await first()).runs, ["keep ", "gone[strike]", " here"]);
    await fresh(pipeline);
    await page.keyboard.type("so ~gone~");
    await undo();
    check("⌘Z after ~text~ gives back the tildes", (await first()).runs, ["so ~gone~"]);

    await fresh(pipeline);
    await page.keyboard.type("~a ");
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.type("b");
    await page.keyboard.press(`${MOD}+b`);
    await page.keyboard.type("~ c");
    check("typing after ~text~ wears what the ~ wore", (await first()).runs, ["a [strike]", "b[bold,strike]", " c"]);

    await fresh(pipeline);
    await page.keyboard.type("area $$x^2$$ m");
    check("$$x^2$$ becomes an inline equation", (await first()).runs, ["area ", "<math x^2>", " m"]);
    await fresh(pipeline);
    await page.keyboard.type("costs $5 or $$");
    check("dollars stay dollars", (await first()).runs, ["costs $5 or $$"]);
  }

  console.log("\n⌘⇧V — paste as plain text");
  const rich = async () => {
    await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob(["<p><strong>Bold</strong> and <em>italic</em></p><h1>Head</h1>"], { type: "text/html" }),
      "text/plain": new Blob(["Bold and italic\n# Head"], { type: "text/plain" }),
    })]));
  };
  await fresh("yjs");
  await rich();
  await page.keyboard.press(`${MOD}+v`);
  await page.waitForTimeout(200);
  check("⌘V keeps the formatting", (await doc()).slice(0, 2), [
    { type: "paragraph", runs: ["Bold[bold]", " and ", "italic[italic]"] },
    { type: "heading", runs: ["Head"] },
  ]);
  await fresh("yjs");
  await rich();
  await page.keyboard.press(`${MOD}+Shift+v`);
  await page.waitForTimeout(300);
  check("⌘⇧V pastes the text alone, when the browser sends no paste", (await doc()).slice(0, 2), [
    { type: "paragraph", runs: ["Bold and italic"] },
    { type: "paragraph", runs: ["# Head"] },
  ]);
  await fresh("yjs");
  await page.evaluate(() => window.typingPaste.paste({ "text/html": "<p><strong>Bold</strong></p>", "text/plain": "**Bold**" }, true));
  await page.waitForTimeout(100);
  check("⌘⇧V pastes the text alone, when it does", (await first()).runs, ["**Bold**"]);
  await fresh("yjs");
  await page.evaluate(() => window.typingPaste.paste({ "text/html": "<p><strong>Bold</strong></p>", "text/plain": "Bold" }));
  check("and a paste after it is rich again", (await first()).runs, ["Bold[bold]"]);

  const plainPaste = (text) => page.evaluate((t) => window.typingPaste.paste({ "text/html": "<p><em>x</em></p>", "text/plain": t }, true), text);
  for (const pipeline of ["yjs", "legacy"]) {
    await fresh(pipeline);
    await page.keyboard.type("hello");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(50); // ProseMirror reads the moved caret on selectionchange
    await plainPaste("X\nY");
    await page.keyboard.type("!");
    check(`[${pipeline}] ⌘⇧V of lines continues the line at the caret`, (await doc()).slice(0, 2), [
      { type: "paragraph", runs: ["heX"] },
      { type: "paragraph", runs: ["Y!llo"] },
    ]);
    await fresh(pipeline);
    await page.keyboard.type("- item ");
    await plainPaste("a\nb");
    check(`[${pipeline}] and joins a list item`, (await doc()).slice(0, 2), [
      { type: "bulletListItem", runs: ["item a"] },
      { type: "paragraph", runs: ["b"] },
    ]);
    await fresh(pipeline);
    await page.keyboard.type("- ");
    await plainPaste("a\nb");
    check(`[${pipeline}] an empty list item stays one`, (await doc()).slice(0, 2).map((b) => b.type), ["bulletListItem", "paragraph"]);
    await fresh(pipeline);
    await plainPaste("**A**\n\nB");
    check(`[${pipeline}] and keeps blank lines`, (await doc()).slice(0, 3), [
      { type: "paragraph", runs: ["**A**"] },
      { type: "paragraph", runs: [] },
      { type: "paragraph", runs: ["B"] },
    ]);
  }

  console.log("\nPasted markdown");
  for (const pipeline of ["yjs", "legacy"]) {
    await fresh(pipeline);
    await page.evaluate(() => window.typingPaste.paste({ "text/plain": "Intro\n---\nBody" }));
    check(`[${pipeline}] a line then --- gives a divider`, (await doc()).slice(0, 3), [
      { type: "paragraph", runs: ["Intro"] },
      { type: "divider", runs: null },
      { type: "paragraph", runs: ["Body"] },
    ]);
  }
  await fresh("yjs");
  await page.evaluate(() => window.typingPaste.paste({ "text/plain": "# Plan\n\n- one\n- two" }));
  check("the rest of a markdown paste is as it was", (await doc()).slice(0, 3).map((b) => b.type), ["heading", "bulletListItem", "bulletListItem"]);
  await fresh("yjs");
  await page.evaluate(() => window.typingPaste.paste({ "text/plain": "Intro\n```\na\n---\n```" }));
  check("a --- inside a code fence is no divider", (await doc()).some((b) => b.type === "divider"), false);
} finally {
  await browser?.close();
  server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log("\nAll checks passed.");
