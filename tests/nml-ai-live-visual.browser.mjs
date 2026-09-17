import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHarness } from "./canvas-harness.mjs";

const artifactDir = process.env.NML_AI_LIVE_ARTIFACT_DIR;
if (!artifactDir) throw new Error("NML_AI_LIVE_ARTIFACT_DIR is required.");

const diagram = await readFile(path.join(artifactDir, "diagram.nml"), "utf8");
const calls = JSON.parse(
  await readFile(path.join(artifactDir, "chat-tools.json"), "utf8"),
);
const one = (name) => {
  const found = calls.filter((call) => call.toolName === name);
  assert.equal(found.length, 1, `${name} must have executed once`);
  return found[0].input;
};
const edit = one("edit_page");
const setText = one("set_text");
const move = one("move");
assert.match(edit.html, /PARITY_TEXT_NEW/);
assert.equal(setText.blockId, "c-main");
assert.equal(setText.id, "s-box");
assert.deepEqual(move.ids, ["s-box"]);

const x = 40 + move.dx;
const y = 60 + move.dy;
const chatCanvas =
  `<nt-diagram id="c-main" w="600" h="300">` +
  `<nt-rect id="s-box" x="${x}" y="${y}" w="180" h="64">${setText.text}</nt-rect>` +
  '<nt-rect id="s-done" x="360" y="60" w="180" h="64">DONE</nt-rect>' +
  '<nt-edge id="e-flow" from="s-box" to="s-done">next</nt-edge></nt-diagram>';
await writeFile(path.join(artifactDir, "chat-canvas.nml"), `${chatCanvas}\n`);

const built = await buildHarness();
const { default: puppeteer } = await import(
  process.env.NML_PUPPETEER_MODULE || "puppeteer"
);
const browser = await puppeteer.launch({
  headless: true,
  ...(process.env.NML_CHROME_PATH
    ? { executablePath: process.env.NML_CHROME_PATH }
    : {}),
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 560 });
const errors = [];
const escaped = [];
page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
page.on("console", (message) => {
  if (["error", "warning"].includes(message.type())) {
    errors.push(`console ${message.type()}: ${message.text()}`);
  }
});
await page.setRequestInterception(true);
page.on("request", (request) => {
  const url = request.url();
  if (url.startsWith(built.origin) || url.startsWith("data:")) {
    return request.continue();
  }
  escaped.push(url);
  return request.abort();
});

try {
  await page.goto(built.origin, { waitUntil: "networkidle0" });
  const reports = [];
  for (const fixture of [
    { name: "generated-diagram", html: diagram },
    { name: "chat-edited-canvas", html: chatCanvas },
  ]) {
    const width = Number(
      /\bw="(\d+(?:\.\d+)?)"/.exec(fixture.html)?.[1] ?? 600,
    );
    const height = Number(
      /\bh="(\d+(?:\.\d+)?)"/.exec(fixture.html)?.[1] ?? 300,
    );
    await page.evaluate(
      ({ html, width, height }) =>
        window.canvasHarness.mount({ html }, { readOnly: true, width, height }),
      { html: fixture.html, width, height },
    );
    await page.evaluate(() => window.canvasHarness.nextFrame());
    const seen = await page.evaluate(() => {
      const layer = document.querySelector(".nt-canvas-scene");
      return {
        nodes: layer?.querySelectorAll("[data-id]").length ?? 0,
        edges: new Set(
          [...(layer?.querySelectorAll("[data-edge]") ?? [])].map((element) =>
            element.getAttribute("data-edge"),
          ),
        ).size,
        labels: [...(layer?.querySelectorAll("[data-id]") ?? [])]
          .map((element) => element.textContent?.trim())
          .filter(Boolean),
      };
    });
    assert.ok(seen.nodes >= 2, `${fixture.name} must paint its shapes`);
    assert.ok(seen.edges >= 1, `${fixture.name} must paint its connector`);
    const screenshot = path.join(artifactDir, `${fixture.name}.png`);
    await (await page.$("#app")).screenshot({ path: screenshot });
    reports.push({ ...fixture, html: undefined, ...seen, screenshot });
  }
  assert.ok(reports[0].labels.includes("Draft"));
  assert.ok(reports[0].labels.includes("Approved"));
  assert.ok(reports[1].labels.includes("PARITY_BOX_NEW"));
  assert.deepEqual(errors, []);
  assert.deepEqual(escaped, []);
  await writeFile(
    path.join(artifactDir, "visual-report.json"),
    JSON.stringify({ result: "passed", reports, errors, escaped }, null, 2),
  );
  console.log(JSON.stringify({ result: "passed", reports }, null, 2));
} finally {
  await page.close();
  await browser.close();
  await built.close();
}
