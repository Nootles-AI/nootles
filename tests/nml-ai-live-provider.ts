import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseHTML, DOMParser as LinkedomDOMParser } from "linkedom";
import { generateText, stepCountIs, tool } from "ai";
import * as Y from "yjs";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { walk } from "@/app/components/editor/canvas/scene/types";
import { runCanvasTool } from "@/app/lib/ai/canvas/execute";
import type { CanvasHost, CanvasRead } from "@/app/lib/ai/canvas/host";
import { chatModel } from "@/app/lib/ai/chat/provider";
import { SYSTEM as CHAT_SYSTEM } from "@/app/lib/ai/chat/prompt";
import { TOOLS } from "@/app/lib/ai/chat/tools";
import { DEFAULT_DRAW_CHOICE } from "@/app/lib/ai/drawStyles";
import { diagramElement, streamDiagram } from "@/app/lib/ai/diagram";
import { streamFim, type FimDone } from "@/app/lib/ai/fim";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { toDocHtml } from "@/app/lib/ai/html/serialize";
import { project } from "@/app/lib/ai/projection";
import { reformatCandidates } from "@/app/lib/ai/reformat";
import { describeSheet } from "@/app/lib/ai/albumIndex";
import { generateVectorDrawing } from "@/app/lib/ai/vectorDraw";
import { convertLegacyDocument, type LegacyBlock } from "@/app/lib/nml/legacy";
import { applyNmlBatch } from "@/app/lib/nml/model/apply";
import { createNmlCanvasHost } from "@/app/lib/nml/model/canvasHost";
import { projectNmlDocument } from "@/app/lib/nml/model/projection";
import type { NmlDocument } from "@/app/lib/nml/schema";
import { createNmlYDoc, decodeNmlDocument } from "@/app/lib/nml/yjs";
import type { Batch } from "@/convex/ai/operations";

if (process.env.NML_ALLOW_PAID_AI !== "1") {
  throw new Error("Refusing live providers without NML_ALLOW_PAID_AI=1.");
}
if (process.env.USE_OPENROUTER !== "true") {
  throw new Error("This bounded run requires USE_OPENROUTER=true.");
}

const artifactDir = process.env.NML_AI_LIVE_ARTIFACT_DIR;
const albumPath = process.env.NML_AI_LIVE_ALBUM_PATH;
if (!artifactDir || !albumPath)
  throw new Error("Live artifact paths are required.");
await mkdir(artifactDir, { recursive: true });

const parseHtml = (html: string) =>
  parseHTML(html).document as unknown as Document;
(globalThis as unknown as { DOMParser: typeof LinkedomDOMParser }).DOMParser =
  LinkedomDOMParser;

const providerHosts = new Set([
  "api.mistral.ai",
  "openrouter.ai",
  "external.api.recraft.ai",
]);
const previousCounts = JSON.parse(
  process.env.NML_AI_LIVE_PREVIOUS_COUNTS ?? "{}",
) as Record<string, number>;
for (const host of providerHosts) {
  const previous = previousCounts[host] ?? 0;
  assert.ok(
    Number.isInteger(previous) && previous >= 0,
    `invalid previous count for ${host}`,
  );
}
const attempts: Array<{ host: string; path: string; method: string }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  if (providerHosts.has(url.host)) {
    attempts.push({
      host: url.host,
      path: url.pathname,
      method: init?.method ?? "GET",
    });
    const count = (host: string) =>
      (previousCounts[host] ?? 0) +
      attempts.filter((attempt) => attempt.host === host).length;
    const total = [...providerHosts].reduce(
      (sum, host) => sum + count(host),
      0,
    );
    assert.ok(total <= 10, "cumulative paid provider request ceiling exceeded");
    assert.ok(count("api.mistral.ai") <= 1, "Mistral request ceiling exceeded");
    assert.ok(
      count("openrouter.ai") <= 8,
      "OpenRouter request ceiling exceeded",
    );
    if (count("external.api.recraft.ai") > 1) {
      throw new DOMException(
        "Recraft retry blocked by live-test ceiling",
        "AbortError",
      );
    }
    await writeFile(
      `${artifactDir}/requests.json`,
      JSON.stringify(
        {
          previousCounts,
          attempts,
          cumulativeCounts: Object.fromEntries(
            [...providerHosts].map((host) => [host, count(host)]),
          ),
        },
        null,
        2,
      ),
    );
  }
  return await originalFetch(input, init);
};

const BASE_SCENE =
  '<nt-diagram id="c-main" w="600" h="300"><nt-rect id="s-box" x="40" y="60" w="180" h="64">PARITY_BOX_OLD</nt-rect><nt-rect id="s-done" x="360" y="60" w="180" h="64">DONE</nt-rect><nt-edge id="e-flow" from="s-box" to="s-done">next</nt-edge></nt-diagram>';
const BASE_BLOCKS: LegacyBlock[] = [
  {
    id: "p-text",
    type: "paragraph",
    props: {},
    content: [{ type: "text", text: "PARITY_TEXT_OLD", styles: {} }],
    children: [],
  },
  {
    id: "c-main",
    type: "canvas",
    props: { data: BASE_SCENE },
    children: [],
  },
];
const PAGE_ID = "a1b2c3d4e5f6g7h8j9k0";

let minted = 0;
const freshId = () => `live-${++minted}`;
const converted = convertLegacyDocument(
  { documentId: "live-parity", blocks: BASE_BLOCKS },
  { createId: freshId, parseHtml },
).document;
assert.deepEqual(
  projectNmlDocument(converted),
  project(BASE_BLOCKS as never),
  "live fixture must begin at exact legacy/NML read parity",
);

function modelOptions(doc: Y.Doc, batch: Batch, suffix: string) {
  return {
    doc,
    batch,
    origin: {
      version: 1 as const,
      transactionId: `live-${suffix}`,
      batchId: `live-${suffix}`,
      actor: { kind: "model" as const, userId: "live-test" },
      command: "live-provider-parity",
    },
    idempotencyKey: `live-${suffix}`,
    authorize: () => true,
    createId: freshId,
    parseHtml,
  };
}

async function apply(document: NmlDocument, batch: Batch, suffix: string) {
  const doc = createNmlYDoc(document);
  const origins: unknown[] = [];
  doc.on("afterTransaction", (transaction) => {
    if (transaction.origin && typeof transaction.origin === "object")
      origins.push(transaction.origin);
  });
  await applyNmlBatch(modelOptions(doc, batch, suffix));
  assert.ok(
    origins.some(
      (origin) =>
        (origin as { actor?: { kind?: string } }).actor?.kind === "model",
    ),
    `${suffix} must retain model attribution`,
  );
  return { doc, document: decodeNmlDocument(doc) };
}

const result: Record<string, unknown> = {};
const failures: string[] = [];
const resumeAfter = process.env.NML_AI_LIVE_RESUME_AFTER;
assert.ok(
  resumeAfter === undefined || resumeAfter === "diagram",
  "unsupported resume checkpoint",
);
if (resumeAfter) result.resumedAfter = resumeAfter;

// One real Codestral SSE stream. The exact bytes are kept and applied once to
// canonical NML; no second generation is used as a false parity oracle.
if (!resumeAfter) {
  let fimDone: FimDone | undefined;
  const fimResponse = await streamFim(
    '<nt-document version="1"><p id="p-text">The three release gates are design review, QA sign-off, and',
    ".</p></nt-document>",
    {
      maxTokens: 32,
      signal: AbortSignal.timeout(45_000),
      onDone: (done) => {
        fimDone = done;
      },
    },
  );
  assert.equal(fimResponse.status, 200, "FIM route contract must answer 200");
  const rawCompletion = await fimResponse.text();
  const completion = rawCompletion
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  assert.ok(
    completion.length > 0 && completion.length <= 180,
    "FIM completion must be bounded and non-empty",
  );
  assert.equal(
    fimDone?.status,
    "ok",
    "FIM SSE stream must settle successfully",
  );
  const fimApplied = await apply(
    converted,
    {
      ops: [
        {
          kind: "setBlockContent",
          blockId: "p-text",
          content: [
            { type: "text", text: `PARITY_TEXT_OLD ${completion}`, marks: [] },
          ],
        },
      ],
    },
    "fim",
  );
  assert.match(
    projectNmlDocument(fimApplied.document).text,
    new RegExp(completion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  fimApplied.doc.destroy();
  await writeFile(`${artifactDir}/completion.txt`, `${rawCompletion}\n`);
  result.fim = { completion, done: fimDone };
}

// The existing reformat prompt is the legacy oracle. Its returned candidate is
// compiled by the unchanged HTML compiler and then executed by the NML applier.
if (!resumeAfter) {
  const reformatSource = "Sam owns ingest, Priya owns search, Dev owns the UI";
  const reformatLegacy: LegacyBlock[] = [
    {
      id: "p-reformat",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: reformatSource, styles: {} }],
      children: [],
    },
  ];
  const reformatted = await reformatCandidates(
    `<p id="p-reformat">${reformatSource}</p>`,
    AbortSignal.timeout(60_000),
  );
  assert.equal(
    reformatted.failure,
    undefined,
    `reformat failed: ${reformatted.failure}`,
  );
  assert.ok(
    reformatted.candidates.length > 0,
    "reformat must return at least one candidate",
  );
  const candidate = reformatted.candidates[0];
  const reformatBatch = compileDocHtml(
    parseDocHtml(candidate.html, parseHtml),
    {
      current: parseDocHtml(toDocHtml(reformatLegacy as never), parseHtml),
      anchorBlockId: "p-reformat",
    },
  );
  assert.ok(
    reformatBatch.ops.length > 0,
    "reformat candidate must compile to operations",
  );
  const reformatDocument = convertLegacyDocument(
    { documentId: "live-reformat", blocks: reformatLegacy },
    { createId: freshId, parseHtml },
  ).document;
  const reformatApplied = await apply(
    reformatDocument,
    reformatBatch,
    "reformat",
  );
  assert.notEqual(
    reformatApplied.document.blocks[0].type,
    "paragraph",
    "reformat must change the block shape",
  );
  reformatApplied.doc.destroy();
  await writeFile(
    `${artifactDir}/reformat.json`,
    JSON.stringify(reformatted, null, 2),
  );
  result.reformat = {
    candidateCount: reformatted.candidates.length,
    selected: candidate.label,
    finalType: reformatApplied.document.blocks[0].type,
    usage: reformatted.usage,
  };
}

// A real streamed diagram must survive the model grammar, scene parser,
// canonical serializer and NML operation applier.
if (!resumeAfter) {
  let diagramUsage: unknown;
  const diagramResponse = streamDiagram(
    "a two-step release flow from Draft to Approved, with one arrow",
    "Draft moves to Approved after review.",
    "Release flow",
    AbortSignal.timeout(90_000),
    (usage) => {
      diagramUsage = usage;
    },
  );
  const diagramRaw = await diagramResponse.text();
  const diagramHtml = diagramElement(diagramRaw);
  assert.ok(diagramHtml, "diagram model must return an nt-diagram");
  const diagramScene = parseScene(diagramHtml, parseHtml);
  assert.ok(
    diagramScene.nodes.length >= 2,
    "diagram must contain at least two shapes",
  );
  assert.ok(diagramScene.edges.length >= 1, "diagram must contain an edge");
  const canonicalDiagram = serializeScene(diagramScene);
  assert.equal(
    serializeScene(parseScene(canonicalDiagram, parseHtml)),
    canonicalDiagram,
    "diagram scene must be stable after canonical round-trip",
  );
  const diagramApplied = await apply(
    converted,
    {
      ops: [
        {
          kind: "insertBlocks",
          at: { at: "docEnd" },
          blocks: [
            {
              tempId: "$live-diagram",
              type: "canvas",
              props: { data: canonicalDiagram },
            },
          ],
        },
      ],
    },
    "diagram",
  );
  assert.equal(diagramApplied.document.blocks.at(-1)?.type, "canvas");
  diagramApplied.doc.destroy();
  await writeFile(`${artifactDir}/diagram.nml`, `${canonicalDiagram}\n`);
  result.diagram = {
    shapes: diagramScene.nodes.length,
    edges: diagramScene.edges.length,
    usage: diagramUsage,
  };
}

// Exercise the actual configured chat model with the production tool schemas.
// The tools execute only against in-memory receipts here; their exact calls are
// then replayed through both a legacy in-memory CanvasHost and the NML host.
const chatCalls: Array<{ toolName: string; input: unknown }> = [];
const receipt = (toolName: string) => async (input: unknown) => {
  chatCalls.push({ toolName, input: structuredClone(input) });
  return `${toolName} applied successfully`;
};
const chat = await generateText({
  ...chatModel(),
  system: `${CHAT_SYSTEM}\n\nThe open page is ${PAGE_ID} — that is what "this page" means.`,
  prompt: [
    "On this open page, change PARITY_TEXT_OLD to PARITY_TEXT_NEW.",
    "In its existing c-main diagram, change shape s-box's visible label to PARITY_BOX_NEW",
    "and move that shape right 20 and down 10.",
    'First call read_open_page with expand ["c-main"]. After that read returns,',
    "make exactly one edit_page, one set_text, and one move call; the three edits may run in parallel.",
    "Do not replace the whole diagram.",
  ].join("\n"),
  tools: {
    read_open_page: tool({
      ...TOOLS.read_open_page,
      execute: async (input) => {
        chatCalls.push({
          toolName: "read_open_page",
          input: structuredClone(input),
        });
        return `<p id="p-text">PARITY_TEXT_OLD</p>\n${BASE_SCENE}`;
      },
    }),
    edit_page: tool({ ...TOOLS.edit_page, execute: receipt("edit_page") }),
    set_text: tool({ ...TOOLS.set_text, execute: receipt("set_text") }),
    move: tool({ ...TOOLS.move, execute: receipt("move") }),
  },
  // Production leaves tool choice at the provider's default (auto). Muse's
  // current Meta endpoint rejects "required", so this deliberately mirrors
  // the actual route instead of strengthening the request for the test.
  stopWhen: stepCountIs(3),
  maxOutputTokens: 1_200,
  abortSignal: AbortSignal.timeout(120_000),
});
const names = new Set(chatCalls.map((call) => call.toolName));
await writeFile(
  `${artifactDir}/chat-response.json`,
  JSON.stringify(
    {
      text: chat.text,
      finishReason: chat.finishReason,
      calls: chatCalls,
      steps: chat.steps.map((step) => ({
        finishReason: step.finishReason,
        text: step.text,
        tools: step.toolCalls.map((call) => call.toolName),
      })),
    },
    null,
    2,
  ),
);
assert.deepEqual(
  names,
  new Set(["read_open_page", "edit_page", "set_text", "move"]),
  "chat must read first and call all three requested edit tools",
);
for (const name of ["read_open_page", "edit_page", "set_text", "move"]) {
  assert.equal(
    chatCalls.filter((call) => call.toolName === name).length,
    1,
    `${name} must run exactly once`,
  );
}

const editInput = TOOLS.edit_page.inputSchema.parse(
  chatCalls.find((call) => call.toolName === "edit_page")!.input,
);
assert.equal(editInput.pageId, PAGE_ID);
assert.match(editInput.html, /id=["']p-text["']/);
assert.match(editInput.html, /PARITY_TEXT_NEW/);
const editBatch = compileDocHtml(parseDocHtml(editInput.html, parseHtml), {
  current: parseDocHtml(toDocHtml(BASE_BLOCKS as never), parseHtml),
  anchorBlockId: "p-text",
});
assert.ok(editBatch.ops.length > 0, "chat edit_page HTML must compile");
const chatDoc = createNmlYDoc(converted);
const chatOrigins: unknown[] = [];
chatDoc.on("afterTransaction", (transaction) => {
  if (transaction.origin && typeof transaction.origin === "object")
    chatOrigins.push(transaction.origin);
});
await applyNmlBatch(modelOptions(chatDoc, editBatch, "chat-edit"));

const nmlHost = createNmlCanvasHost({
  resolveDocument: () => ({ pageId: PAGE_ID, doc: chatDoc }),
  actor: { kind: "model", userId: "live-test" },
  authorize: () => true,
  createRequestId: (() => {
    let request = 0;
    return () => `live-canvas-${++request}`;
  })(),
  prepareParse: async () => {},
  parseHtml,
});
let legacyScene = parseScene(BASE_SCENE, parseHtml);
const legacyHost: CanvasHost = {
  readScene: async (blockId, pageId) =>
    blockId === "c-main"
      ? ({
          pageId: pageId ?? PAGE_ID,
          blockId,
          scene: structuredClone(legacyScene),
        } satisfies CanvasRead)
      : null,
  writeScene: async (_read, next) => {
    legacyScene = structuredClone(next);
    return { added: 0, removed: 0, changed: 1, hunks: 1 };
  },
  prepareParse: async () => {},
  parseHtml,
};
for (const name of ["set_text", "move"] as const) {
  const input = chatCalls.find((call) => call.toolName === name)!.input;
  await runCanvasTool(name, input, legacyHost);
  await runCanvasTool(name, input, nmlHost);
}
const chatDocument = decodeNmlDocument(chatDoc);
assert.match(projectNmlDocument(chatDocument).text, /PARITY_TEXT_NEW/);
const chatCanvas = chatDocument.blocks.find((block) => block.id === "c-main");
assert.ok(chatCanvas?.type === "canvas");
assert.equal(
  serializeScene(chatCanvas.scene),
  serializeScene(legacyScene),
  "chat canvas tools must match the legacy host",
);
const changedShape = chatCanvas.scene.nodes.find((node) => node.id === "s-box");
assert.equal(changedShape?.label, "PARITY_BOX_NEW");
assert.equal(changedShape?.x, 60);
assert.equal(changedShape?.y, 70);
assert.ok(
  chatOrigins.some(
    (origin) =>
      (origin as { actor?: { kind?: string } }).actor?.kind === "model",
  ),
  "chat transactions must retain model attribution",
);
chatDoc.destroy();
await writeFile(
  `${artifactDir}/chat-tools.json`,
  JSON.stringify(chatCalls, null, 2),
);
await writeFile(
  `${artifactDir}/chat-canvas.nml`,
  `${serializeScene(chatCanvas.scene)}\n`,
);
result.chat = {
  calls: chatCalls.map((call) => call.toolName),
  steps: chat.steps.length,
  finishReason: chat.finishReason,
  usage: chat.totalUsage,
  finalShape: changedShape,
};
if (chat.finishReason !== "stop") {
  failures.push(
    `chat did not settle after its applied tools (finishReason=${chat.finishReason})`,
  );
}

// One multimodal contact-sheet call covers the album wire and its strict
// handle parser without uploading customer media.
const albumData = await readFile(albumPath);
const album = await describeSheet(
  {
    dataUri: `data:image/png;base64,${albumData.toString("base64")}`,
    handles: ["img-a", "img-b"],
  },
  AbortSignal.timeout(60_000),
);
assert.deepEqual(
  new Set(album.described.map((item) => item.handle)),
  new Set(["img-a", "img-b"]),
  "album index must return each shown handle exactly once",
);
assert.ok(
  album.described.every((item) => item.alt.length > 0 && item.alt.length <= 90),
);
await writeFile(`${artifactDir}/album.json`, JSON.stringify(album, null, 2));
result.album = album;

// The sole Recraft request is last. A second attempt is blocked by the fetch
// ceiling even though production retries transient failures.
const vector = await generateVectorDrawing(
  "A simple brass key on a plain cream background, bold clean editable vector silhouette",
  { w: 320, h: 180 },
  DEFAULT_DRAW_CHOICE,
  AbortSignal.timeout(90_000),
);
if (!vector?.html) {
  failures.push("vector provider returned no importable drawing");
  result.vector = { status: "failed", reason: "no importable drawing" };
} else {
  const vectorScene = parseScene(vector.html, parseHtml);
  assert.ok(
    vectorScene.nodes.length > 0,
    "vector drawing must contain editable scene nodes",
  );
  let vectorPaths = 0;
  walk(vectorScene.nodes, (node) => {
    if (node.kind === "path") vectorPaths += 1;
  });
  assert.ok(vectorPaths > 0, "vector drawing must retain editable paths");
  const canonicalVector = serializeScene(vectorScene);
  assert.equal(
    serializeScene(parseScene(canonicalVector, parseHtml)),
    canonicalVector,
  );
  await writeFile(`${artifactDir}/vector.nml`, `${canonicalVector}\n`);
  result.vector = {
    status: "passed",
    shapes: vectorScene.nodes.length,
    paths: vectorPaths,
    latencyMs: vector.latencyMs,
  };
}

result.requests = attempts;
result.previousRequestCounts = previousCounts;
result.requestCounts = Object.fromEntries(
  [...providerHosts].map((host) => [
    host,
    (previousCounts[host] ?? 0) +
      attempts.filter((attempt) => attempt.host === host).length,
  ]),
);
assert.ok(
  Object.values(result.requestCounts as Record<string, number>).reduce(
    (a, b) => a + b,
    0,
  ) <= 10,
);
result.failures = failures;
await writeFile(`${artifactDir}/summary.json`, JSON.stringify(result, null, 2));
assert.deepEqual(
  failures,
  [],
  `live provider failures:\n${failures.join("\n")}`,
);
console.log(
  JSON.stringify({ result: "passed", artifactDir, ...result }, null, 2),
);
