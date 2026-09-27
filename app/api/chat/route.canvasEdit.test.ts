// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { PackInputs } from "@/app/lib/ai/context/pack";

/**
 * Diagram edits on the wire production uses (NT-92).
 *
 * "Relabel these three and nudge the logo left" was four verb calls, and a
 * browser tool ends the request that carried it, so the model usually spent
 * four requests on it, each re-running the gates and re-sending the prefix.
 * `canvas_edit` carries the four as one call. Everything between the panel's
 * `BrowserChat` and the wire is the shipped code; OpenRouter is a local server
 * speaking chat completions from a script, and the diagram is the real
 * executor over an in-memory host, so nothing leaves the machine.
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
import { runCanvasTool } from "@/app/lib/ai/canvas/execute";
import { f1 } from "@/app/lib/ai/canvas/fixtures";
import type { CanvasHost } from "@/app/lib/ai/canvas/host";
import { findNode, type Scene } from "@/app/components/editor/canvas/scene/types";
import { shortenStaleParts } from "@/app/lib/ai/chat/transcript";
import { POST } from "./route";

const PROJECT = "p57abcdefghijklmnopqrstu";
const PAGE = "k57abcdefghijklmnopqrstu";
const THREAD = "t57abcdefghijklmnopqrstu";

const inputs = {
  title: "Rover",
  notes: [],
  pages: [{ pageId: PAGE, title: "Flow", brief: "", updatedAt: 1 }],
  links: { out: [], in: [] },
  code: [],
  documents: [],
} as unknown as PackInputs;

const VERBS = ["set_text", "rename", "duplicate", "move", "delete", "reorder", "group", "ungroup"];

type WireMessage = {
  role: string;
  content: unknown;
  tool_call_id?: string;
  tool_calls?: { function: { name: string; arguments: string } }[];
};
type WireTool = { function: { name: string } };
type Step = { call: { name: string; args: object } } | { text: string };

let script: Step[] = [];
let sent: { messages: WireMessage[]; tools?: WireTool[] }[] = [];
let router: Server;
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

let routerUrl = "";

beforeAll(async () => {
  router = createServer(async (req, res) => {
    sent.push(JSON.parse(await read(req)));
    const step = req.url === "/chat/completions" ? script.shift() : undefined;
    if (!step) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(answer(step));
  });
  await new Promise<void>((resolve) => router.listen(0, "127.0.0.1", resolve));
  routerUrl = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;
  globalThis.requestAnimationFrame ??= ((run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterAll(async () => {
  await new Promise<void>((resolve) => router.close(() => resolve()));
});

/** The diagram the browser holds, and every write that reached it. */
let scene: Scene;
let writes = 0;
const host: CanvasHost = {
  readScene: async (blockId) => (blockId === "b1" ? { pageId: PAGE, blockId, scene } : null),
  writeScene: async (_read, next) => {
    writes++;
    scene = next;
    return { added: 0, removed: 0, changed: 1, hunks: 1 };
  },
  prepareParse: async () => {},
};

/** The panel's loop, pointed at the route in process, running diagram tools through the real executor. */
function panel(initial: AbMessage[] = []) {
  const chat: BrowserChat = new BrowserChat({
    store: new ChatStore(initial),
    transport: new DefaultChatTransport<AbMessage>({
      api: "http://app.test/api/chat",
      fetch: async (url, init) => POST(new Request(url, init)),
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages: shortenStaleParts(messages), projectId: PROJECT, pageId: PAGE, threadId: THREAD },
      }),
    }),
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName !== "canvas_edit") return;
      const output = await runCanvasTool("canvas_edit", toolCall.input, host);
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

beforeEach(() => {
  vi.stubEnv("USE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-not-real");
  vi.stubEnv("TEST_OPENROUTER_URL", routerUrl);
  vi.stubEnv("NODE_ENV", "production");
  session.mockResolvedValue({ token: "tok", sessionId: "sess", userId: "user_owner" });
  refuseIfLimited.mockResolvedValue(null);
  convex.mutation.mockResolvedValue(undefined);
  convex.query.mockResolvedValue(inputs);
  scene = f1();
  writes = 0;
  sent = [];
  script = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("USE_OPENROUTER on: diagram edits", () => {
  test("four edits to one diagram are one call, one write and one resume", async () => {
    script = [
      {
        call: {
          name: "canvas_edit",
          args: {
            blockId: "b1",
            ops: [
              { op: "set_text", id: "s1", text: "Paid" },
              { op: "set_text", id: "s2", text: "Packed" },
              { op: "set_text", id: "e1", text: "and then" },
              { op: "move", ids: ["p1"], dx: -20 },
            ],
          },
        },
      },
      { text: "Relabelled the three and nudged the logo left." },
    ];
    const chat = panel();
    await chat.sendMessage({ text: "Relabel these three and nudge the logo left" });
    await settled(chat);
    expect(chat.store.getSnapshot().error).toBeUndefined();

    // The whole request took two route requests, and the diagram one write.
    expect(sent).toHaveLength(2);
    expect(writes).toBe(1);
    expect(findNode(scene, "s1")).toMatchObject({ label: "Paid" });
    expect(findNode(scene, "p1")).toMatchObject({ x: 500 });
    expect(scene.edges[0].label).toBe("and then");

    // The model was offered the one tool, not the eight it replaces.
    const offered = sent[0].tools!.map((t) => t.function.name);
    expect(offered).toContain("canvas_edit");
    expect(offered.filter((name) => VERBS.includes(name))).toEqual([]);

    // And read back what it did, as one answer.
    const result = sent[1].messages.find((m) => m.role === "tool");
    expect(String(result?.content)).toMatch(/^Done: 4 edits, as one change\./);
  });

  test("a thread saved with the old verbs still sends", async () => {
    const earlier: AbMessage[] = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Rename the first box" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-set_text",
            toolCallId: "call_old_1",
            state: "output-available",
            input: { blockId: "b1", id: "s1", text: "Paid" },
            output: 'Done: "s1" now reads "Paid".',
          },
          { type: "step-start" },
          {
            type: "tool-move",
            toolCallId: "call_old_2",
            state: "output-available",
            input: { blockId: "b1", ids: ["p1"], dx: -20 },
            output: "Done: moved 1 shape by (-20, 0).",
          },
          { type: "step-start" },
          { type: "text", text: "Done.", state: "done" },
        ],
      } as unknown as AbMessage,
    ];
    script = [{ text: "It reads Paid." }];
    const chat = panel(earlier);
    await chat.sendMessage({ text: "What does the first box say now?" });
    await settled(chat);
    expect(chat.store.getSnapshot().error).toBeUndefined();
    expect(sent).toHaveLength(1);

    const calls = sent[0].messages.flatMap((m) => m.tool_calls ?? []).map((c) => c.function.name);
    expect(calls).toEqual(["set_text", "move"]);
    const results = sent[0].messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results).toEqual(['Done: "s1" now reads "Paid".', "Done: moved 1 shape by (-20, 0)."]);
  });
});
