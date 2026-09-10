// Uses the existing esbuild dependency and an operator-installed Puppeteer; no app server or API keys.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "nml-view-browser-"));
const { default: puppeteer } = await import(process.env.NML_PUPPETEER_MODULE || "puppeteer");
await build({
  absWorkingDir: repo, entryPoints: ["tests/nml-view.browser.tsx"], bundle: true, splitting: true, format: "esm", outdir: output,
  platform: "browser", conditions: ["browser", "import", "style"], tsconfig: "tsconfig.json", define: { "process.env.NODE_ENV": '"development"' },
  banner: { js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };' },
  plugins: [{ name: "reject-next-server-diagnostics", setup(builder) {
    builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({ path: "server-only", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'exports.sync = () => { throw new Error("Next server-only gzip diagnostics reached in browser") };' }));
  } }],
  loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" }, logLevel: "warning",
});
const appCss = path.join(repo, "app/globals.css");
const styles = await postcss([tailwind({ base: repo })]).process(await readFile(appCss, "utf8"), { from: appCss });
await writeFile(path.join(output, "app.css"), styles.css);
await writeFile(path.join(output, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/nml-view.browser.css"><style>
body { margin: 24px; color: #292929; background: #fff; font-family: Arial, sans-serif; --text-body:15px; --leading-body:1.7; --code-bg:#f6f6f5; --code-topbar:#eee; --code-border:#ddd; --code-fg-muted:#777; --line:#ddd; --surface:#fff; --text:#292929; }
#app { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:40px; } section { min-width:0; } section > h2 { font-size:17px; margin-block:16px; } @media(max-width:700px) { #app { display:block; } }
</style></head><body><div id="app"></div><script type="module" src="/nml-view.browser.js"></script></body></html>`);
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".html") ? "text/html" : "application/octet-stream");
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ headless: true, ...(process.env.NML_CHROME_PATH ? { executablePath: process.env.NML_CHROME_PATH } : {}) });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1100 });
  const errors = [];
  const paidRequests = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error("Browser error:", error.message); });
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/\/api\/(complete|diagram|chat|reformat|album\/index|places)/.test(url)) paidRequests.push(url);
    if (url.startsWith(origin) && !url.includes("/api/")) return void request.continue();
    // All remote traffic is fulfilled locally: fixtures never reach providers.
    if (request.resourceType() === "image") return void request.respond({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#eee"/></svg>' });
    return void request.respond({ status: 200, contentType: "application/json", body: '{"status":"unknown"}' });
  });
  await page.evaluateOnNewDocument(() => {
    // Convex-backed read-only components retain their loading state without a server.
    window.WebSocket = class extends EventTarget {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = 0;
      send() { throw new Error("Fixture socket must never send"); }
      close() { this.readyState = 3; }
    };
  });
  await page.goto(origin, { waitUntil: "networkidle0" });
  await page.waitForSelector("#bridge .nt-nml-view");
  for (const fixture of ["rich", "table", "code", "media", "domains", "canvas", "oldCanvas", "edges"]) {
    await page.evaluate((name) => window.nmlHarness.mount(name), fixture);
    await page.waitForSelector("#bridge .nt-nml-view");
    await page.waitForFunction(() => !document.getElementById("bridge").textContent.includes("Loading "));
    if (fixture === "code") await page.waitForSelector("#bridge .cm-editor");
    await page.screenshot({ path: path.join(output, `${fixture}-before.png`), fullPage: true });
    const state = await page.evaluate(() => window.nmlHarness.inspect());
    assert.equal(state.status, "ready", fixture);
    assert.equal(state.parity, true, fixture);
    assert.equal(state.unchanged, true, fixture);
    assert.equal(state.updates, 0, fixture);
    assert.equal(await page.$eval("#bridge .nt-nml-view", (el) => el.contentEditable), "false");
    assert.equal(await page.$$eval('#bridge [contenteditable="true"]', (els) => els.length), 0, fixture);
    if (fixture === "rich") {
      assert.equal(await page.$eval("#bridge h1", (el) => el.textContent), await page.$eval("#legacy h1", (el) => el.textContent));
      assert.equal(await page.$eval("#bridge blockquote", (el) => el.textContent), await page.$eval("#legacy blockquote", (el) => el.textContent));
      assert.equal(await page.$eval("#bridge h1", (el) => getComputedStyle(el).fontSize), await page.$eval("#legacy h1", (el) => getComputedStyle(el).fontSize));
      await page.click('#bridge button[aria-label="Expand content"]');
      assert.equal(await page.$eval('#bridge button[aria-label="Collapse content"]', (el) => el.getAttribute("aria-expanded")), "true");
      await page.click("#bridge p");
      await page.keyboard.type("Typing must not persist");
      await page.keyboard.press("Backspace");
      await page.evaluate(() => {
        const target = document.querySelector("#bridge .nt-nml-view");
        const data = new DataTransfer(); data.setData("text/plain", "PASTE MUST NOT PERSIST");
        target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
        target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
        target.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "IME", bubbles: true, cancelable: true }));
      });
      assert.equal(await page.evaluate(() => window.nmlHarness.tryEdit()), false);
      assert.equal((await page.evaluate(() => window.nmlHarness.inspect())).unchanged, true);
      await page.evaluate(() => window.nmlHarness.remoteText());
      await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="p1"]').textContent.startsWith("Remote update: "));
      assert.equal((await page.evaluate(() => window.nmlHarness.inspect())).updates, 1);
    }
    if (fixture === "canvas") {
      await page.waitForSelector("#bridge .nt-canvas");
      const block = state.ast.blocks.find((block) => block.type === "canvas");
      await page.evaluate(({ id, shapeId }) => window.nmlHarness.command([{ type: "updateShapes", canvasId: id, patches: [{ id: shapeId, patch: { x: 99, label: "Remote shape" } }] }]), { id: block.id, shapeId: block.scene.nodes[0].id });
      await page.waitForFunction(() => document.getElementById("bridge").textContent.includes("Remote shape"));
      const after = await page.evaluate(() => window.nmlHarness.inspect());
      assert.deepEqual(after.pm, state.pm);
      assert.equal(after.updates, 1);
    }
    if (fixture === "edges") {
      assert.match(await page.$eval("#bridge .nt-nml-view", (node) => node.textContent), /Hoisted out of an unsupported parent/);
      assert.equal(await page.$$eval('#bridge [data-nml-unsupported="true"]', (nodes) => nodes.length), 0);
    }
    await page.screenshot({ path: path.join(output, `${fixture}-desktop.png`), fullPage: true });
  }

  // Exercise the step-8 editor through real Chromium input, selection, and composition behavior.
  await page.evaluate(() => window.nmlHarness.mountEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"]');
  assert.equal(await page.$eval("#bridge .nt-nml-view", (el) => el.getAttribute("role")), "textbox");
  assert.equal(await page.$eval("#bridge .nt-nml-view", (el) => el.getAttribute("aria-readonly")), "false");
  const initialEditing = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(initialEditing.parity, true);
  assert.equal(initialEditing.awareness.version, 1);
  assert.equal(Array.isArray(initialEditing.awareness.anchor.relative), true);
  assert.equal(/pm(Start|End)|"(anchor|head)":\d/.test(JSON.stringify(initialEditing.awareness)), false);

  await page.click('#bridge [data-nml-id="heading"]');
  await page.keyboard.press("End");
  await page.keyboard.type(" typed");
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="heading"]').textContent === "Heading typed");

  await page.click('#bridge [data-nml-id="quote"]');
  await page.keyboard.press("End");
  await page.keyboard.down("Shift");
  for (let index = 0; index < 4; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.keyboard.type("TEXT");
  await page.keyboard.press("Backspace");
  await page.evaluate(() => {
    const editor = document.querySelector("#bridge .nt-nml-view");
    const target = document.querySelector('#bridge [data-nml-id="quote"]');
    const text = document.createTreeWalker(target, NodeFilter.SHOW_TEXT).nextNode();
    const selection = window.getSelection();
    const range = document.createRange();
    editor.focus();
    range.setStart(text, 0); range.collapse(true);
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await page.waitForFunction(() => window.nmlHarness.selectionOffset("quote") === 0);
  await page.keyboard.press("Delete");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await page.$eval('#bridge [data-nml-id="quote"]', (el) => el.textContent), "uote TEX");

  await page.click('#bridge [data-nml-id="plain"]');
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter(" 👩🏽‍💻 café");
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="plain"]').textContent === "Plain text 👩🏽‍💻 café");
  const afterTyping = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(afterTyping.parity, true);
  assert.equal(afterTyping.performance.fullObserverDecodes, initialEditing.performance.fullObserverDecodes);
  assert.equal(afterTyping.performance.fullProjections, initialEditing.performance.fullProjections);
  assert.equal(afterTyping.performance.yjsIndexScans, initialEditing.performance.yjsIndexScans);
  assert.ok(afterTyping.requests.some((request) => request.status === "optimistic"));
  assert.ok(afterTyping.requests.some((request) => request.status === "acknowledged"));
  assert.equal(afterTyping.requests.some((request) => request.status === "reconciled"), false);
  assert.equal(afterTyping.updates, afterTyping.requests.filter((request) => request.status === "acknowledged").length);

  const beforeRejectedShapes = structuredClone(afterTyping.ast);
  await page.keyboard.press("Enter");
  await page.evaluate(() => {
    const target = document.querySelector("#bridge .nt-nml-view");
    const data = new DataTransfer(); data.setData("text/plain", "PASTE MUST STAY OUT");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    target.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  });
  await page.click('#bridge [data-nml-id="rich"]');
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await page.click('#bridge [data-nml-id="list"]');
  await page.keyboard.press("End");
  await page.keyboard.type("X");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterRejectedShapes = await page.evaluate(() => window.nmlHarness.inspect());
  assert.deepEqual(afterRejectedShapes.ast, beforeRejectedShapes);
  assert.equal(await page.$eval('#bridge [data-nml-id="rich"]', (el) => el.textContent), "Rich text");
  assert.equal(await page.$eval('#bridge [data-nml-id="list"]', (el) => el.textContent), "List text");
  assert.ok(afterRejectedShapes.diagnostics.filter((entry) => entry.code === "content_rejected").length >= 2);

  await page.click('#bridge [data-nml-id="quote"]');
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => window.nmlHarness.selectionOffset("quote")), 2);
  await page.waitForFunction(() => window.nmlHarness.stateSelectionOffset("quote") === 2);
  await page.evaluate(() => window.nmlHarness.remoteEdit("quote", 0, 0, "R"));
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="quote"]').textContent.startsWith("R"));
  assert.equal(await page.evaluate(() => window.nmlHarness.stateSelectionOffset("quote")), 3);
  assert.equal(await page.evaluate(() => window.nmlHarness.selectionOffset("quote")), 3);

  await page.evaluate(() => window.nmlHarness.setAuthorization("deny"));
  const headingBeforeDenied = await page.$eval('#bridge [data-nml-id="heading"]', (el) => el.textContent);
  await page.click('#bridge [data-nml-id="heading"]');
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter("DENIED");
  await page.waitForFunction((expected) => document.querySelector('#bridge [data-nml-id="heading"]').textContent === expected, {}, headingBeforeDenied);
  const denied = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(denied.requests.at(-1).status, "rejected");
  assert.ok(denied.diagnostics.some((entry) => entry.code === "commit_rejected"));
  assert.equal(JSON.stringify(denied.diagnostics).includes("DENIED"), false);

  await page.evaluate(() => window.nmlHarness.setAuthorization("defer"));
  const headingBeforeDeferred = await page.$eval('#bridge [data-nml-id="heading"]', (el) => el.textContent);
  await page.click('#bridge [data-nml-id="heading"]');
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter("LOCAL");
  await page.waitForFunction((expected) => document.querySelector('#bridge [data-nml-id="heading"]').textContent === `${expected}LOCAL`, {}, headingBeforeDeferred);
  await page.evaluate(() => window.nmlHarness.remoteEdit("heading", 0, 0, "REMOTE "));
  await page.waitForFunction((expected) => document.querySelector('#bridge [data-nml-id="heading"]').textContent === `REMOTE ${expected}`, {}, headingBeforeDeferred);
  await page.evaluate(() => window.nmlHarness.resolveAuthorization(true));
  await page.waitForFunction(() => window.nmlHarness.inspect().requests.at(-1)?.status === "rejected");
  const reconciled = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(reconciled.parity, true);
  assert.equal(await page.$eval('#bridge [data-nml-id="heading"]', (el) => el.textContent), `REMOTE ${headingBeforeDeferred}`);
  assert.equal(JSON.stringify(reconciled.ast).includes("LOCAL"), false);
  await page.screenshot({ path: path.join(output, "plain-text-editing-desktop.png"), fullPage: true });

  // Real CompositionEvents and ProseMirror composition metadata drive one canonical IME request.
  await page.evaluate(() => window.nmlHarness.mountEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"]');
  assert.equal(await page.evaluate(() => window.nmlHarness.startComposition("plain", 10)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.updateComposition("plain", 10, 10, "日本語")), true);
  assert.equal(await page.$eval('#bridge [data-nml-id="plain"]', (el) => el.textContent), "Plain text日本語");
  await page.evaluate(() => window.nmlHarness.finishComposition("日本語"));
  await page.waitForFunction(() => window.nmlHarness.inspect().requests.at(-1)?.status === "acknowledged");
  let composition = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(composition.ast.blocks.find((block) => block.id === "plain").content[0].text, "Plain text日本語");
  assert.equal(composition.requests.filter((request) => request.status === "optimistic").length, 1);
  assert.equal(composition.parity, true);

  assert.equal(await page.evaluate(() => window.nmlHarness.startComposition("quote", 2)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.updateComposition("quote", 2, 2, "漢")), true);
  await page.evaluate(() => window.nmlHarness.remoteEdit("quote", 2, 2, "R"));
  assert.equal(await page.$eval('#bridge [data-nml-id="quote"]', (el) => el.textContent), "Qu漢ote text");
  await page.evaluate(() => window.nmlHarness.finishComposition("漢"));
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="quote"]').textContent === "QuR漢ote text");
  composition = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(composition.parity, true);
  await page.screenshot({ path: path.join(output, "composition-desktop.png"), fullPage: true });

  await page.evaluate(() => window.nmlHarness.mountEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"]');
  assert.equal(await page.evaluate(() => window.nmlHarness.startComposition("heading", 7)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.updateComposition("heading", 7, 7, "unfinished 日本語")), true);
  await page.evaluate(() => window.nmlHarness.remoteDelete("heading"));
  await page.waitForSelector('#bridge .nt-nml-composition-recovery:not([hidden])');
  assert.equal(await page.$eval('#bridge textarea[aria-label="Recovered unfinished text"]', (element) => element.value), "unfinished 日本語");
  const recovered = await page.evaluate(() => window.nmlHarness.inspect());
  assert.deepEqual(recovered.recovery, { nodeId: "heading", text: "unfinished 日本語" });
  assert.equal(recovered.ast.blocks.some((block) => block.id === "heading"), false);
  assert.equal(recovered.parity, true);
  await page.screenshot({ path: path.join(output, "composition-recovery-desktop.png"), fullPage: true });
  await page.click('#bridge .nt-nml-composition-recovery button');
  await page.waitForSelector('#bridge .nt-nml-composition-recovery[hidden]');

  // Exercise the step-9 editor through real rich input and domain-owned surfaces.
  await page.evaluate(() => window.nmlHarness.mountRichEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"][aria-label="Rich document editor"]');
  await page.waitForFunction(() => !document.getElementById("bridge").textContent.includes("Loading "));
  assert.equal(await page.evaluate(() => window.nmlHarness.startComposition("rich-full", 4)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.updateComposition("rich-full", 4, 4, "日本語")), true);
  await page.evaluate(() => window.nmlHarness.finishComposition("日本語"));
  await page.waitForFunction(() => window.nmlHarness.inspect().requests.at(-1)?.status === "acknowledged");
  let richEditing = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(richEditing.ast.blocks[0].content[0].text, "Rich日本語 text");
  assert.deepEqual(richEditing.ast.blocks[0].content[0].marks, ["bold"]);
  assert.equal(richEditing.parity, true);

  await page.evaluate(() => window.nmlHarness.mountRichEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"][aria-label="Rich document editor"]');
  await page.waitForSelector('#bridge [data-nml-id="code-rich"] .cm-content');
  await page.click('#bridge [data-nml-id="rich-full"]');
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks[0].content.some((part) => part.text?.endsWith("!")));

  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("rich-full", 0, 4)), true);
  await page.keyboard.down("Control");
  await page.keyboard.press("i");
  await page.keyboard.up("Control");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks[0].content[0].marks.includes("italic"));
  assert.equal(await page.evaluate(() => { window.nmlHarness.selectInline("rich-full", 5, 9); return window.nmlHarness.setLink("https://example.com"); }), true);
  await page.waitForSelector('#bridge [data-nml-id="rich-full"] a[href="https://example.com"]');
  assert.equal(await page.evaluate(() => { window.nmlHarness.selectInline("rich-full", 6, 8); return window.nmlHarness.setLink(null); }), true);
  await page.waitForFunction(() => document.querySelectorAll('#bridge [data-nml-id="rich-full"] a[href="https://example.com"]').length === 2);
  assert.equal(await page.evaluate(() => { window.nmlHarness.selectInline("rich-full", 5, 9); return window.nmlHarness.setLink(null); }), true);
  await page.waitForFunction(() => !document.querySelector('#bridge [data-nml-id="rich-full"] a'));
  assert.equal(await page.evaluate(() => { window.nmlHarness.selectInline("rich-full", 10); return window.nmlHarness.insertInlineMath("x^2"); }), true);
  await page.waitForSelector('#bridge [data-nml-id="rich-full"] .nt-math-inline');
  assert.equal(await page.evaluate(() => window.nmlHarness.insertPageReference("page-2", "Second page")), true);
  await page.waitForSelector('#bridge [data-nml-id="rich-full"] .nt-ref[data-page-id="page-2"]');

  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("rich-full", 4)), true);
  let requestCount = await page.evaluate(() => window.nmlHarness.inspect().requests.length);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks.length > 10);
  await page.waitForFunction((count) => {
    const requests = window.nmlHarness.inspect().requests;
    return requests.length > count && ["acknowledged", "reconciled"].includes(requests.at(-1)?.status);
  }, {}, requestCount);
  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("list-two", 3)), true);
  requestCount = await page.evaluate(() => window.nmlHarness.inspect().requests.length);
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks.find((block) => block.id === "list-one")?.children[0]?.id === "list-two");
  await page.waitForFunction((count) => {
    const requests = window.nmlHarness.inspect().requests;
    return requests.length > count && ["acknowledged", "reconciled"].includes(requests.at(-1)?.status);
  }, {}, requestCount);
  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("list-two", 3)), true);
  requestCount = await page.evaluate(() => window.nmlHarness.inspect().requests.length);
  await page.keyboard.down("Shift");
  await page.keyboard.press("Tab");
  await page.keyboard.up("Shift");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks.some((block) => block.id === "list-two"));
  await page.waitForFunction((count) => {
    const requests = window.nmlHarness.inspect().requests;
    return requests.length > count && ["acknowledged", "reconciled"].includes(requests.at(-1)?.status);
  }, {}, requestCount);
  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("list-two", 2)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.moveSelection(-1)), true);
  await page.waitForFunction(() => {
    const ids = window.nmlHarness.inspect().ast.blocks.map((block) => block.id);
    return ids.indexOf("list-two") < ids.indexOf("list-one");
  });

  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("list-two", 3)), true);
  await page.evaluate(() => {
    const target = document.querySelector("#bridge .nt-nml-view");
    const data = new DataTransfer(); data.setData("text/plain", "paste one\npaste two");
    target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => JSON.stringify(window.nmlHarness.inspect().ast).includes("paste two"));
  assert.equal(await page.evaluate(() => window.nmlHarness.selectInline("list-two", 3)), true);
  await page.evaluate(() => {
    const target = document.querySelector("#bridge .nt-nml-view");
    const rect = document.querySelector('#bridge [data-nml-id="list-two"]').getBoundingClientRect();
    const data = new DataTransfer(); data.setData("text/plain", "drop one\ndrop two");
    target.dispatchEvent(new DragEvent("drop", {
      dataTransfer: data,
      bubbles: true,
      cancelable: true,
      clientX: rect.left + 8,
      clientY: rect.top + rect.height / 2,
    }));
  });
  await page.waitForFunction(() => JSON.stringify(window.nmlHarness.inspect().ast).includes("drop two"));

  await page.click('#bridge [data-nml-id="table-cell"]');
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await page.waitForFunction(() => JSON.stringify(window.nmlHarness.inspect().ast).includes("Cell edited"));
  await page.click('#bridge [data-nml-id="code-rich"] .cm-content');
  await page.keyboard.down("Control");
  await page.keyboard.press("End");
  await page.keyboard.up("Control");
  await page.keyboard.type("; // edited");
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks.find((block) => block.id === "code-rich")?.code.includes("edited"), { timeout: 3000 });
  await page.waitForSelector('#bridge [data-nml-id="math-rich"] math-field');
  await page.$eval('#bridge [data-nml-id="math-rich"] math-field', (field) => {
    field.value = "x^2";
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "^2" }));
  });
  await page.waitForFunction(() => window.nmlHarness.inspect().ast.blocks.find((block) => block.id === "math-rich")?.rows[0].latex.includes("2"));
  await page.click('#bridge [data-nml-id="audio-rich"] .nt-media-input');
  await page.keyboard.type("https://example.com/clip.mp4");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const block = window.nmlHarness.inspect().ast.blocks.find((candidate) => candidate.id === "audio-rich");
    return block?.type === "video" && block.props.source?.url === "https://example.com/clip.mp4";
  });
  await page.waitForFunction(() => ["acknowledged", "reconciled"].includes(window.nmlHarness.inspect().requests.at(-1)?.status));

  const storyInput = '#bridge [data-nml-id="story1"] textarea';
  await page.waitForSelector(storyInput);
  const storyRequestCount = await page.evaluate(() => window.nmlHarness.inspect().requests.length);
  await page.click(storyInput);
  await page.keyboard.press("Home");
  await page.keyboard.down("Shift");
  await page.keyboard.press("End");
  await page.keyboard.up("Shift");
  await page.keyboard.type("Edited shot note");
  assert.deepEqual(await page.$eval(storyInput, (element) => {
    const textarea = element;
    return { active: document.activeElement === textarea, value: textarea.value };
  }), { active: true, value: "Edited shot note" });
  await page.waitForFunction((count) => {
    const requests = window.nmlHarness.inspect().requests;
    return requests.length > count && ["acknowledged", "reconciled"].includes(requests.at(-1)?.status);
  }, {}, storyRequestCount);
  richEditing = await page.evaluate(() => window.nmlHarness.inspect());
  assert.equal(richEditing.ast.blocks.find((block) => block.id === "story1")?.domain.shots[0].note, "Edited shot note");
  assert.equal(richEditing.parity, true);
  assert.equal(richEditing.diagnostics.length, 0);
  assert.ok(richEditing.requests.some((request) => request.status === "acknowledged"));
  await page.screenshot({ path: path.join(output, "rich-editing-desktop.png"), fullPage: true });

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.nmlHarness.mountEditable());
  await page.waitForSelector('#bridge .nt-nml-view[contenteditable="true"]');
  assert.equal(await page.evaluate(() => window.nmlHarness.startComposition("quote", 10)), true);
  assert.equal(await page.evaluate(() => window.nmlHarness.updateComposition("quote", 10, 10, "한글 नमस्ते")), true);
  await page.evaluate(() => window.nmlHarness.finishComposition("한글 नमस्ते"));
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="quote"]').textContent === "Quote text한글 नमस्ते");
  await page.click('#bridge [data-nml-id="quote"]');
  await page.keyboard.press("End");
  await page.keyboard.sendCharacter(" mobile");
  await page.waitForFunction(() => document.querySelector('#bridge [data-nml-id="quote"]').textContent === "Quote text한글 नमस्ते mobile");
  assert.equal((await page.evaluate(() => window.nmlHarness.inspect())).parity, true);
  await page.screenshot({ path: path.join(output, "plain-text-editing-mobile.png"), fullPage: true });

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.nmlHarness.mount("rich"));
  await page.waitForSelector("#bridge .nt-nml-view");
  await page.screenshot({ path: path.join(output, "rich-mobile.png"), fullPage: true });
  await page.evaluate(() => { window.nmlHarness.drift(); window.nmlHarness.drift(); });
  await page.waitForSelector('#bridge [data-nml-status="frozen"]');
  assert.match(await page.$eval("#bridge [role=status]", (el) => el.textContent), /preserved/);
  await page.evaluate(() => window.nmlHarness.mount("rich"));
  await page.waitForSelector("#bridge .nt-nml-view");
  await page.evaluate(() => window.nmlHarness.corrupt());
  await page.waitForSelector('#bridge [data-nml-status="frozen"]');
  await page.evaluate(() => window.nmlHarness.destroy());
  assert.deepEqual(errors, []);
  assert.deepEqual(paidRequests, []);
  console.log(JSON.stringify({ result: "passed", fixtures: 8, editableWorkflows: 7, desktop: "1440x1100", mobile: "390x844", screenshots: output, browserErrors: errors.length, paidRequests: paidRequests.length }, null, 2));
} finally { await browser?.close(); await new Promise((resolve) => server.close(resolve)); }
