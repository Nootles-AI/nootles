/**
 * NT-91: a picture the agent looks at, in the browser that fetches it.
 *
 * The real composer over the real `useProjectChat`, whose real `look_at` reads
 * the open page's album and fetches its pictures from this server, stored as an
 * album stores them (2560 px WebP). `/api/chat` is a script the fixture plays
 * one request at a time. Checked: the pictures go out at the size a model reads
 * them at, the thread saves none of their bytes, and the next question does not
 * carry them again.
 *
 * node tests/chat-look-at.browser.mjs
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = await mkdtemp(path.join(tmpdir(), "chat-look-at-"));

// The thread starts empty; what it saves is recorded for the checks below.
const CONVEX = `
export function useQuery(_query, args) {
  if (args === "skip" || !args) return undefined;
  if (args.threadId) return [];
  if (args.projectId) return [{ _id: "page1", title: "Plan" }];
  return [];
}
export function useMutation() {
  return async (args) => {
    if (args && args.parts) globalThis.lookAtHarness.saved.push(JSON.parse(JSON.stringify(args)));
    return null;
  };
}
export function useConvex() { return {}; }
`;
const OPEN_PAGE = `export function useOpenPage() { return { open: () => {} }; }`;
const REVIEW = `
const review = {
  beginTurn: async () => null,
  endTurn: async () => null,
  restoreCheckpoint: async () => null,
  previewRestore: async () => [],
  cancelRestore: async () => null,
  settleRestore: async () => null,
};
export function useReview() { return review; }
`;
const EDITORS = `export function useEditorRegistry() { return { editorFor: async () => globalThis.lookAtEditor() }; }`;
const TELEMETRY = `export function track() {}`;
const SERVER_ONLY = `exports.sync = () => { throw new Error("server-only gzip diagnostics reached browser fixture"); };`;

await build({
  absWorkingDir: repo,
  entryPoints: ["tests/chat-look-at.browser.tsx"],
  bundle: true,
  format: "esm",
  outdir: output,
  platform: "browser",
  conditions: ["browser", "import", "style"],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"development"' },
  banner: {
    js: 'globalThis.process ??= { env: { NODE_ENV: "development" }, browser: true };',
  },
  plugins: [
    {
      name: "chat-look-at-fixture",
      setup(builder) {
        builder.onResolve({ filter: /^next\/dist\/compiled\/gzip-size$/ }, () => ({
          path: "server-only",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /^convex\/react$/ }, () => ({
          path: "convex-react",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)OpenPageContext$/ }, () => ({
          path: "open-page",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)ReviewContext$/ }, () => ({
          path: "review",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)EditorRegistry$/ }, () => ({
          path: "editors",
          namespace: "fixture",
        }));
        builder.onResolve({ filter: /(^|\/)telemetry$/ }, () => ({
          path: "telemetry",
          namespace: "fixture",
        }));
        const stub = (name, contents) =>
          builder.onLoad({ filter: new RegExp(`^${name}$`), namespace: "fixture" }, () => ({
            contents,
            loader: "js",
          }));
        stub("convex-react", CONVEX);
        stub("server-only", SERVER_ONLY);
        stub("open-page", OPEN_PAGE);
        stub("review", REVIEW);
        stub("editors", EDITORS);
        stub("telemetry", TELEMETRY);
      },
    },
  ],
  logLevel: "warning",
});

// Layout enough to click: the rail's own stylesheet is Tailwind-built and not
// what is under test, but a zero-size element is not clickable.
const CSS = `
  body { margin: 0; font: 13px system-ui; }
  #rail { width: 320px; }
  .nt-composer { position: relative; border: 1px solid #ddd; }
  .nt-composer-input { display: block; width: 100%; min-height: 24px; resize: none; }
  .nt-composer-actions { display: flex; justify-content: space-between; padding: 4px; }
  .nt-composer-queue { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 4px; list-style: none; }
  .nt-queued { display: flex; gap: 6px; }
  .nt-chip-remove { width: 16px; height: 16px; }
  .nt-mention-menu { position: absolute; bottom: 100%; left: 0; right: 0; background: #fff; }
  .nt-mention-item { display: block; width: 100%; }
`;

await writeFile(
  path.join(output, "index.html"),
  `<!doctype html><html><head><style>${CSS}</style></head><body><div id="app"></div><script type="module" src="/chat-look-at.browser.js"></script></body></html>`,
);

// Storage: the pictures the page uploads, served back with their type.
const pictures = new Map();
const fetched = [];
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname.startsWith("/storage/")) {
      if (request.method === "PUT") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        pictures.set(pathname, { type: request.headers["content-type"], bytes: Buffer.concat(chunks) });
        return void response.end();
      }
      fetched.push(pathname);
      const picture = pictures.get(pathname);
      if (!picture) return void response.writeHead(404).end();
      response.setHeader("Content-Type", picture.type);
      return void response.end(picture.bytes);
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      return void response.end();
    }
    const name = pathname === "/" ? "index.html" : path.basename(pathname);
    const data = await readFile(path.join(output, name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/html");
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, actual, expected) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`  ok   ${name}`);
    return;
  }
  failures.push(`${name}\n    expected ${JSON.stringify(expected)}\n    actual   ${JSON.stringify(actual)}`);
  console.log(`  FAIL ${name}`);
};

const step = (chunks, finishReason) => [
  { type: "start" },
  { type: "start-step" },
  ...chunks,
  { type: "finish-step" },
  { type: "finish", finishReason },
];
const say = (text) =>
  step(
    [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: text },
      { type: "text-end", id: "t" },
    ],
    "stop",
  );

let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.NML_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");

  // Two photographs, stored the way an album stores them: 2560 px WebP. Noise
  // under a sign, so the encoder has as much work as a real photograph.
  const { stored, handles } = await page.evaluate(async () => {
    const sizes = [];
    for (const [name, w, h] of [["a1", 2560, 1707], ["a2", 1707, 2560]]) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext("2d");
      const noise = g.createImageData(w, h);
      for (let i = 0; i < noise.data.length; i += 4) {
        noise.data[i] = (i * 7) % 255;
        noise.data[i + 1] = (i >> 9) % 255;
        noise.data[i + 2] = (i / 13) % 255;
        noise.data[i + 3] = 255;
      }
      g.putImageData(noise, 0, 0);
      g.fillStyle = "#fff";
      g.fillRect(w * 0.1, h * 0.4, w * 0.8, h * 0.2);
      g.fillStyle = "#000";
      g.font = `bold ${Math.round(Math.min(w, h) * 0.12)}px sans-serif`;
      g.fillText("LAUNCH", w * 0.15, h * 0.55);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", 0.82));
      await fetch(`/storage/${name}`, { method: "PUT", headers: { "content-type": "image/webp" }, body: blob });
      sizes.push(blob.size);
    }
    const handles = globalThis.lookAtHarness.album([`${location.origin}/storage/a1`, `${location.origin}/storage/a2`]);
    return { stored: sizes, handles };
  });
  const [h1, h2] = handles;

  const requests = () => page.evaluate(() => globalThis.lookAtHarness.requests.length);
  const ask = async (text) => {
    await page.click(".nt-composer-input");
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
  };

  console.log("\nThe agent looks at two pictures");
  await page.evaluate(
    ({ look, answer }) => {
      globalThis.lookAtHarness.script.push(look, answer);
    },
    {
      look: step(
        [
          {
            type: "tool-input-available",
            toolCallId: "call_look",
            toolName: "look_at",
            input: { blockId: "al1", items: handles },
          },
        ],
        "tool-calls",
      ),
      answer: say("Both signs read LAUNCH."),
    },
  );
  await ask(`What do the signs in ${h1} and ${h2} say?`);
  await page.waitForFunction(() => globalThis.lookAtHarness.requests.length === 2, null, { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");

  const sent = await page.evaluate(async () => {
    const { body, size } = globalThis.lookAtHarness.requests[1];
    const look = body.messages.at(-1).parts.find((part) => part.type === "tool-look_at");
    const images = [];
    for (const image of look.output.images) {
      const blob = await (await fetch(image.dataUri)).blob();
      const bitmap = await createImageBitmap(blob);
      images.push({ handle: image.handle, w: bitmap.width, h: bitmap.height, bytes: blob.size, type: image.mediaType });
    }
    return { state: look.state, images, size };
  });
  console.log(`    stored ${stored.map((b) => `${Math.round(b / 1024)} KB`).join(", ")}; sent ${sent.images.map((i) => `${i.w}×${i.h} ${Math.round(i.bytes / 1024)} KB`).join(", ")}; request ${Math.round(sent.size / 1024)} KB`);
  check("the browser answered the look", sent.state, "output-available");
  check(
    "both pictures, at the size a model reads them at",
    sent.images.map(({ handle, w, h, type }) => ({ handle, w, h, type })),
    [
      { handle: h1, w: 1568, h: 1046, type: "image/webp" },
      { handle: h2, w: 1046, h: 1568, type: "image/webp" },
    ],
  );
  check("each picture smaller than the one stored", sent.images.map((i, n) => i.bytes < stored[n]), [true, true]);
  check("each picture fetched once", [...fetched].sort(), ["/storage/a1", "/storage/a2"]);

  const said = () =>
    page.evaluate(() =>
      globalThis.lookAtHarness.saved.at(-1).parts.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    );
  check("the answer arrives, and is saved", await said(), ["Both signs read LAUNCH."]);
  const saved = await page.evaluate(() => {
    const last = globalThis.lookAtHarness.saved.at(-1);
    const look = last.parts.find((part) => part.type === "tool-look_at");
    return { output: look.output, size: JSON.stringify(last).length };
  });
  check("the thread saves the look without its bytes", saved.output, {
    images: [
      { handle: h1, mediaType: "image/webp" },
      { handle: h2, mediaType: "image/webp" },
    ],
  });
  check("and the saved message is small", saved.size < 5_000, true);

  console.log("\nThe next question");
  await page.evaluate((answer) => globalThis.lookAtHarness.script.push(answer), say("LAUNCH, on both."));
  await ask("Remind me what they said?");
  await page.waitForFunction(() => globalThis.lookAtHarness.requests.length === 3);
  await page.waitForFunction(() => document.querySelector("#state")?.textContent === "idle");
  const later = await page.evaluate(() => {
    const { body, size } = globalThis.lookAtHarness.requests[2];
    const look = body.messages
      .flatMap((message) => message.parts)
      .find((part) => part.type === "tool-look_at");
    return { output: look.output, size, dataUris: JSON.stringify(body).includes("data:image/") };
  });
  console.log(`    request ${Math.round(later.size / 1024)} KB`);
  check(
    "the earlier look goes as the words the model will read",
    later.output,
    `${h1}: (picture not sent) ${h2}: (picture not sent)\n(These pictures are from an earlier turn and are not sent again. Call look_at for them to see them now.)`,
  );
  check("no picture travels with it", later.dataUris, false);
  check("a request of a few KB, not a few MB", later.size < 10_000, true);
  check("nothing fetched again", fetched.length, 2);
  check("the next answer arrives", await said(), ["LAUNCH, on both."]);
  check("three requests in all", await requests(), 3);
  check("no browser errors", errors, []);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  throw new Error(`chat look_at failures:\n${failures.join("\n")}`);
}
console.log("\nall chat look_at checks passed");
