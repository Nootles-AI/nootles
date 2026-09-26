// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { PackInputs } from "@/app/lib/ai/context/pack";

/**
 * Pictures in a chat thread, on the wire production uses (NT-91).
 *
 * `USE_OPENROUTER` on, so the shipped OpenRouter adapter builds every request.
 * Between the panel's `BrowserChat` and the wire everything is the shipped
 * code; the ends are stand-ins. OpenRouter is a local server speaking chat
 * completions from a script, and Convex storage is another local server that
 * counts what it serves, so nothing leaves the machine and no key is spent.
 *
 * The person attaches a photo and asks about it and about an album picture;
 * the model looks at the picture (a browser tool, so a second request), reads
 * the page (a third) and answers. The thread is then saved, reopened and asked
 * again, as it would be the next day.
 */

const { session, refuseIfLimited, recordAiCall, convex } = vi.hoisted(() => ({
  session: vi.fn(),
  refuseIfLimited: vi.fn(),
  recordAiCall: vi.fn(),
  convex: { query: vi.fn(), mutation: vi.fn() },
}));

vi.mock("@/app/lib/session", () => ({ session }));
vi.mock("@/app/lib/requestLimitGate", () => ({ refuseIfLimited }));
vi.mock("@/app/lib/ai/recordCall", () => ({ recordAiCall }));
vi.mock("@/app/lib/convexServer", () => ({ asSession: () => convex }));
vi.mock("server-only", () => ({}));
// The adapter itself, pointed at the stand-in: OpenRouter reads no base URL
// from the environment, and this is the one thing about it that differs.
vi.mock("@openrouter/ai-sdk-provider", async (load) => {
  const real = await load<typeof import("@openrouter/ai-sdk-provider")>();
  return {
    ...real,
    createOpenRouter: (options: Parameters<typeof real.createOpenRouter>[0]) =>
      real.createOpenRouter({ ...options, baseURL: process.env.TEST_OPENROUTER_URL }),
  };
});

import { BrowserChat, ChatStore } from "@/app/lib/ai/chat/BrowserChat";
import { forgetDownloads } from "@/app/lib/ai/chat/download";
import { PICTURES_MOVED_ON } from "@/app/lib/ai/chat/lookAt";
import { forStorage } from "@/app/lib/ai/chat/storedParts";
import { shortenStaleParts } from "@/app/lib/ai/chat/transcript";
import { POST } from "./route";

const PROJECT = "p57abcdefghijklmnopqrstu";
const PAGE = "k57abcdefghijklmnopqrstu";
const THREAD = "t57abcdefghijklmnopqrstu";
const PAGE_HTML = "<h1>Moodboard</h1>\n<p>Signage for the launch.</p>";

const inputs = {
  title: "Rover",
  notes: [],
  pages: [{ pageId: PAGE, title: "Moodboard", brief: "", updatedAt: 1 }],
  links: { out: [], in: [] },
  code: [],
  documents: [],
} as unknown as PackInputs;

/** An attached photo's bytes, and an album picture's — distinct, so each can be found on the wire. */
const PHOTO = Buffer.alloc(300_000, 1);
const ALBUM_PICTURE = Buffer.alloc(400_000, 2).toString("base64");

// ---------------------------------------------------------------------------
// OpenRouter and Convex storage, as far as this thread can tell

type Content = string | null | { type: string; text?: string; image_url?: { url: string } }[];
type WireMessage = { role: string; content: Content; tool_call_id?: string; name?: string };
type Step = { call: { name: string; args: object } } | { text: string };

let script: Step[] = [];
let sent: { messages: WireMessage[] }[] = [];
let stored: string[] = [];
let posted: number[] = [];
let router: Server;
let storage: Server;
let serial = 0;

function answer(step: Step): string {
  const n = ++serial;
  const chunk = (delta: object, finish: string | null = null) => ({
    id: `gen-${n}`,
    model: "openai/gpt-6-sol",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const chunks =
    "call" in step
      ? [
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${n}`,
                type: "function",
                function: { name: step.call.name, arguments: JSON.stringify(step.call.args) },
              },
            ],
          }),
          chunk({}, "tool_calls"),
        ]
      : [chunk({ role: "assistant", content: step.text }), chunk({}, "stop")];
  chunks.push({
    ...chunk({}),
    choices: [],
    usage: { prompt_tokens: 1200, completion_tokens: 40, total_tokens: 1240 },
  } as ReturnType<typeof chunk>);
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let routerUrl = "";
let storageUrl = "";

beforeAll(async () => {
  router = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as { messages: WireMessage[] };
    sent.push(body);
    const step = req.url === "/chat/completions" ? script.shift() : undefined;
    if (!step) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(answer(step));
  });
  storage = createServer((req, res) => {
    stored.push(req.url ?? "");
    res.writeHead(200, { "content-type": "image/jpeg" });
    res.end(PHOTO);
  });
  routerUrl = await listen(router);
  storageUrl = await listen(storage);
  globalThis.requestAnimationFrame ??= ((run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterAll(async () => {
  await new Promise<void>((resolve) => router.close(() => resolve()));
  await new Promise<void>((resolve) => storage.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// The browser

/**
 * The panel's loop, pointed at the route in process. It sends what
 * `useProjectChat` sends — earlier turns shortened — and notes each body's size.
 */
function panel(initial: AbMessage[] = []) {
  const chat: BrowserChat = new BrowserChat({
    store: new ChatStore(initial),
    transport: new DefaultChatTransport<AbMessage>({
      api: "http://app.test/api/chat",
      fetch: async (url, init) => {
        posted.push(String(init?.body ?? "").length);
        return POST(new Request(url, init));
      },
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages: shortenStaleParts(messages), projectId: PROJECT, pageId: PAGE, threadId: THREAD },
      }),
    }),
    onToolCall: async ({ toolCall }) => {
      const output =
        toolCall.toolName === "read_open_page"
          ? PAGE_HTML
          : toolCall.toolName === "look_at"
            ? { images: [{ handle: "a1", dataUri: `data:image/webp;base64,${ALBUM_PICTURE}`, mediaType: "image/webp" }] }
            : undefined;
      if (output === undefined) return;
      void chat.addToolOutput({
        tool: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        output,
      } as Parameters<BrowserChat["addToolOutput"]>[0]);
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });
  return chat;
}

async function settled(chat: BrowserChat) {
  for (let i = 0; i < 400; i++) {
    const { status } = chat.store.getSnapshot();
    const last = chat.messages[chat.messages.length - 1];
    const done = last?.role === "assistant" && last.parts.some((p) => p.type === "text");
    if ((status === "ready" && done) || status === "error") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the turn never settled");
}

/** A message as Convex keeps it and hands it back. */
const saved = (m: AbMessage): AbMessage =>
  JSON.parse(JSON.stringify(m.role === "assistant" ? { ...m, parts: forStorage(m.parts) } : m));

const toolMessage = (i: number, name: string) => sent[i].messages.find((m) => m.role === "tool" && m.name === name);
const images = (content: Content | undefined) =>
  Array.isArray(content) ? content.filter((part) => part.type === "image_url").map((part) => part.image_url!.url) : [];
const userImages = (i: number) => sent[i].messages.filter((m) => m.role === "user").flatMap((m) => images(m.content));

beforeEach(() => {
  vi.stubEnv("USE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-not-real");
  vi.stubEnv("TEST_OPENROUTER_URL", routerUrl);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", storageUrl);
  vi.stubEnv("NODE_ENV", "production");
  session.mockResolvedValue({ token: "tok", sessionId: "sess", userId: "user_owner" });
  refuseIfLimited.mockResolvedValue(null);
  convex.mutation.mockResolvedValue(undefined);
  convex.query.mockResolvedValue(inputs);
  forgetDownloads();
  sent = [];
  stored = [];
  posted = [];
  script = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("USE_OPENROUTER on: pictures in a thread", () => {
  test("the model sees what it looked at, each picture is fetched once, and a later turn sends neither again", async () => {
    script = [
      { call: { name: "look_at", args: { blockId: "al1", items: ["a1"] } } },
      { call: { name: "read_open_page", args: {} } },
      { text: "The sign reads LAUNCH; a1 is the same sign at night." },
    ];

    const first = panel();
    await first.sendMessage({
      text: "What does this sign say, and is a1 the same one?",
      files: [{ type: "file", mediaType: "image/jpeg", filename: "sign.jpg", url: `${storageUrl}/api/storage/sign` }],
    });
    await settled(first);
    expect(first.store.getSnapshot().error).toBeUndefined();

    // Three model calls over three route requests.
    expect(sent).toHaveLength(3);
    const lastText = first.messages.at(-1)!.parts.filter((p) => p.type === "text").map((p) => p.text);
    expect(lastText).toEqual(["The sign reads LAUNCH; a1 is the same sign at night."]);

    // The attached photo went inline with every request — and was read from
    // storage once, not once per request.
    const photo = `data:image/jpeg;base64,${PHOTO.toString("base64")}`;
    for (let i = 0; i < 3; i++) expect(userImages(i)).toEqual([photo]);
    expect(stored).toEqual(["/api/storage/sign"]);

    // The album picture reached the model as a picture, labelled by its handle,
    // on the step that asked for it and the one after — never as text.
    for (const i of [1, 2]) {
      const look = toolMessage(i, "look_at");
      expect(look?.content).toEqual([
        { type: "text", text: "a1:" },
        { type: "image_url", image_url: { url: `data:image/webp;base64,${ALBUM_PICTURE}` } },
      ]);
    }
    const everyText = sent.flatMap((s) => s.messages).flatMap((m) =>
      typeof m.content === "string"
        ? [m.content]
        : (m.content ?? []).filter((p) => p.type === "text").map((p) => p.text!),
    );
    expect(everyText.some((text) => text.includes(ALBUM_PICTURE.slice(0, 64)))).toBe(false);

    // A follow-up in the same sitting: the panel still holds the picture, but
    // the browser sends the look as the notice the model will read.
    script = [{ text: "Yes — the same sign." }];
    await first.sendMessage({ text: "So it is the same sign?" });
    await settled(first);
    expect(first.store.getSnapshot().error).toBeUndefined();
    expect(sent).toHaveLength(4);
    const notice = `a1: (picture not sent)\n${PICTURES_MOVED_ON}`;
    expect(toolMessage(3, "look_at")?.content).toBe(notice);
    // The photo the person attached is still theirs to talk about, and still
    // came from memory rather than storage.
    expect(userImages(3)).toEqual([photo]);
    expect(stored).toEqual(["/api/storage/sign"]);

    // The thread as Convex keeps it: the picture's bytes are not in it.
    const thread = first.messages.map(saved);
    expect(JSON.stringify(thread)).not.toContain(ALBUM_PICTURE.slice(0, 64));

    // The next day, on the reopened thread.
    script = [{ text: "It says LAUNCH." }];
    const later = panel(thread);
    await later.sendMessage({ text: "Remind me what the sign says?" });
    await settled(later);
    expect(later.store.getSnapshot().error).toBeUndefined();
    expect(sent).toHaveLength(5);
    expect(toolMessage(4, "look_at")?.content).toBe(notice);
    expect(userImages(4)).toEqual([photo]);

    // What the browser sent: the live turn carried the picture it looked at
    // (a 400 KB picture is ~530 KB of base64); no later request did.
    expect(posted).toHaveLength(5);
    expect(posted[1]).toBeGreaterThan(500_000);
    expect(posted[3]).toBeLessThan(10_000);
    expect(posted[4]).toBeLessThan(10_000);
  });
});
