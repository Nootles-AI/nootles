// @vitest-environment node
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { PackInputs } from "@/app/lib/ai/context/pack";

/**
 * A chat turn with `USE_OPENROUTER` off, from the browser's loop to OpenAI's
 * wire and back (NT-87).
 *
 * Everything between the two ends is the shipped code: the panel's
 * `BrowserChat` and transport, the route, the real `chatModel()`, the real
 * tools and the OpenAI adapter speaking HTTP and SSE. Only the ends are stand-ins:
 * Convex, the session and the limiter are stubs, and OpenAI is a local server
 * (`OPENAI_BASE_URL`) that answers from a script and refuses a request the way
 * the Responses API does, so nothing leaves the machine.
 *
 * The turn is the ordinary one: the model searches the project (a server
 * tool, a second step inside one request), reads the open page (a browser
 * tool, so a second request), and answers. The thread is then saved, reloaded
 * and asked again, as it would be a month later.
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
// Next's guard against a client bundle; this process is the server.
vi.mock("server-only", () => ({}));

import { BrowserChat, ChatStore } from "@/app/lib/ai/chat/BrowserChat";
import { retryNotice } from "@/app/lib/ai/chat/retryNotice";
import { forStorage } from "@/app/lib/ai/chat/storedParts";
import { runCanvasTool } from "@/app/lib/ai/canvas/execute";
import { parse } from "@/app/lib/ai/canvas/fixtures";
import type { CanvasHost, CanvasRead } from "@/app/lib/ai/canvas/host";
import { POST } from "./route";

const PROJECT = "p57abcdefghijklmnopqrstu";
const PAGE = "k57abcdefghijklmnopqrstu";
const THREAD = "t57abcdefghijklmnopqrstu";
const KEY = "sk-test-not-real";
const PAGE_HTML = "<h1>Launch plan</h1>\n<p>The rover launches on Friday.</p>";

const inputs = {
  title: "Rover",
  notes: [],
  pages: [{ pageId: PAGE, title: "Launch plan", brief: "", updatedAt: 1 }],
  links: { out: [], in: [] },
  code: [],
  documents: [],
} as unknown as PackInputs;

// ---------------------------------------------------------------------------
// OpenAI, as far as this turn can tell

type Item = Record<string, unknown> & { type?: string };
type Sent = { body: Record<string, unknown>; auth: string | undefined; refused?: string };

/** One scripted answer: reasoning with a summary, then a call or some text. */
type Step = { thought: string } & ({ call: { name: string; args: object } } | { text: string });

let script: Step[] = [];
let sent: Sent[] = [];
/** Browser tools this test answers beyond reading the open page, by name. */
let browserTools: Record<string, (input: unknown) => Promise<unknown>> = {};
let server: Server;
let serial = 0;

/**
 * What the Responses API refuses, in the shapes a replayed thread can take.
 * With `store: false` nothing is kept server-side, so an item named only by id
 * is a 404 there; a reasoning item must carry its encrypted content; and every
 * call must have its output, and every output its call.
 */
function refusal(body: Record<string, unknown>): string | undefined {
  const input = body.input as Item[];
  const calls = new Set<string>();
  const outputs = new Set<string>();
  for (const item of input) {
    if (item.type === "item_reference") {
      return `Item with id '${item.id}' not found. Items are not persisted when \`store\` is set to false.`;
    }
    if (item.type === "reasoning" && typeof item.encrypted_content !== "string") {
      return `Item with id '${item.id}' not found. Items are not persisted when \`store\` is set to false.`;
    }
    if (item.type === "function_call") calls.add(String(item.call_id));
    if (item.type === "function_call_output") {
      if (!calls.has(String(item.call_id))) return `No tool call found for function call output with call_id ${item.call_id}.`;
      outputs.add(String(item.call_id));
    }
  }
  for (const id of calls) if (!outputs.has(id)) return `No tool output found for function call ${id}.`;
}

function sse(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function answer(step: Step): string {
  const n = ++serial;
  const reasoning = { type: "reasoning", id: `rs_${n}`, encrypted_content: null };
  const events: object[] = [
    { type: "response.created", response: { id: `resp_${n}`, created_at: 1, model: "gpt-6-sol" } },
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.reasoning_summary_part.added", item_id: `rs_${n}`, output_index: 0, summary_index: 0 },
    {
      type: "response.reasoning_summary_text.delta",
      item_id: `rs_${n}`,
      output_index: 0,
      summary_index: 0,
      delta: step.thought,
    },
    { type: "response.reasoning_summary_part.done", item_id: `rs_${n}`, output_index: 0, summary_index: 0 },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...reasoning, encrypted_content: `enc_${n}` },
    },
  ];
  if ("call" in step) {
    const args = JSON.stringify(step.call.args);
    const call = { type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: step.call.name };
    events.push(
      { type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: `fc_${n}`, output_index: 1, delta: args },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: { ...call, arguments: args, status: "completed" },
      },
    );
  } else {
    const message = { type: "message", id: `msg_${n}` };
    events.push(
      { type: "response.output_item.added", output_index: 1, item: message },
      { type: "response.output_text.delta", item_id: `msg_${n}`, output_index: 1, delta: step.text },
      { type: "response.output_item.done", output_index: 1, item: message },
    );
  }
  events.push({
    type: "response.completed",
    response: {
      usage: {
        input_tokens: 1200,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens: 40,
        output_tokens_details: { reasoning_tokens: 25 },
      },
    },
  });
  return sse(events);
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req)) as Record<string, unknown>;
    const record: Sent = { body, auth: req.headers.authorization };
    sent.push(record);
    if (req.url !== "/v1/responses") {
      res.writeHead(404).end();
      return;
    }
    record.refused = refusal(body);
    if (record.refused) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: record.refused, type: "invalid_request_error" } }));
      return;
    }
    const step = script.shift();
    if (!step) {
      res.writeHead(500).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(answer(step));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The store notifies React on a frame; nothing here renders.
  globalThis.requestAnimationFrame ??= ((run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// ---------------------------------------------------------------------------
// The browser

/** The panel's loop, pointed at the route in process rather than over a socket. */
function panel(initial: AbMessage[] = []) {
  const answered: string[] = [];
  const chat: BrowserChat = new BrowserChat({
    store: new ChatStore(initial),
    transport: new DefaultChatTransport<AbMessage>({
      api: "http://app.test/api/chat",
      fetch: (url, init) => POST(new Request(url, init)),
      prepareSendMessagesRequest: ({ messages }) => ({
        body: { messages, projectId: PROJECT, pageId: PAGE, threadId: THREAD },
      }),
    }),
    // The page is the browser's to read; the editor that would is not here, so
    // it answers with what the editor would have serialised.
    onToolCall: async ({ toolCall }) => {
      const run = toolCall.toolName === "read_open_page" ? async () => PAGE_HTML : browserTools[toolCall.toolName];
      if (!run) return;
      answered.push(toolCall.toolCallId);
      void chat.addToolOutput({
        tool: toolCall.toolName,
        toolCallId: toolCall.toolCallId,
        output: await run(toolCall.input),
      } as Parameters<BrowserChat["addToolOutput"]>[0]);
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });
  return { chat, answered };
}

/** Until the turn — every request of it — is over. */
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

const inputOf = (i: number) => sent[i].body.input as Item[];
const ofType = (items: Item[], type: string) => items.filter((item) => item.type === type);

beforeEach(() => {
  vi.stubEnv("USE_OPENROUTER", "");
  vi.stubEnv("OPENROUTER_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", KEY);
  vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`);
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
  vi.stubEnv("NODE_ENV", "production");
  session.mockResolvedValue({ token: "tok", sessionId: "sess", userId: "user_owner" });
  refuseIfLimited.mockResolvedValue(null);
  convex.mutation.mockResolvedValue(undefined);
  convex.query.mockImplementation(async (_ref: unknown, args: { query?: string }) =>
    args?.query !== undefined ? [{ id: PAGE, kind: "page", title: "Launch plan" }] : inputs,
  );
  sent = [];
  script = [];
  browserTools = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("USE_OPENROUTER off: the chat answers on OpenAI's own API", () => {
  test("a turn that searches, reads the open page and answers, then a later turn on the reloaded thread", async () => {
    script = [
      { thought: "Finding the launch plan.", call: { name: "search_context", args: { query: "launch" } } },
      { thought: "It is the open page; reading it.", call: { name: "read_open_page", args: {} } },
      { thought: "The date is on the page.", text: "The rover launches on Friday." },
    ];

    const first = panel();
    await first.chat.sendMessage({ text: "When does the rover launch?" });
    await settled(first.chat);

    // What the person sees: the thinking notes, the two acts and the answer.
    const { status, error } = first.chat.store.getSnapshot();
    expect(error).toBeUndefined();
    expect(status).toBe("ready");
    expect(sent.map((s) => s.refused)).toEqual([undefined, undefined, undefined]);
    const turn = first.chat.messages.filter((m) => m.role === "assistant");
    const parts = turn.flatMap((m) => m.parts);
    expect(parts.filter((p) => p.type === "reasoning").map((p) => p.text)).toEqual([
      "Finding the launch plan.",
      "It is the open page; reading it.",
      "The date is on the page.",
    ]);
    expect(parts.filter((p) => p.type.startsWith("tool-")).map((p) => [p.type, "state" in p && p.state])).toEqual([
      ["tool-search_context", "output-available"],
      ["tool-read_open_page", "output-available"],
    ]);
    expect(parts.filter((p) => p.type === "text").map((p) => p.text)).toEqual([
      "The rover launches on Friday.",
    ]);
    expect(first.answered).toHaveLength(1);

    // What OpenAI was sent: three model calls over two route requests, each on
    // OpenAI's key, the model's own name and the chat's dials.
    expect(sent).toHaveLength(3);
    for (const { body, auth } of sent) {
      expect(auth).toBe(`Bearer ${KEY}`);
      expect(body).toMatchObject({
        model: "gpt-6-sol",
        store: false,
        stream: true,
        reasoning: { effort: "medium", summary: "auto" },
      });
      expect(body.include).toContain("reasoning.encrypted_content");
      const tools = (body.tools as { name?: string }[]).map((t) => t.name);
      expect(tools).toEqual(expect.arrayContaining(["search_context", "read_open_page", "edit_page"]));
    }
    // The server tool's step replays its own reasoning, carried by content.
    expect(ofType(inputOf(1), "reasoning")).toEqual([
      expect.objectContaining({ encrypted_content: "enc_1" }),
    ]);
    expect(ofType(inputOf(1), "function_call_output")).toHaveLength(1);
    // The browser's answer reaches the model as the call's output.
    const pageRead = ofType(inputOf(2), "function_call_output").find((o) => o.call_id === "call_2");
    expect(String(pageRead?.output)).toContain("The rover launches on Friday.");

    // The ledger's row is the chat's, on the slug it is priced by.
    const rows = recordAiCall.mock.calls.map(([, row]) => row).filter((row) => row.feature === "chat");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ model: "openai/gpt-6-sol", status: "ok", cacheReadTokens: 2000 });

    // The thread as Convex keeps it, reopened: the history replays on content
    // alone, with nothing named by an id OpenAI was never asked to keep.
    script = [{ thought: "Answering from the thread.", text: "Friday, as the page says." }];
    const later = panel(first.chat.messages.map(saved));
    await later.chat.sendMessage({ text: "Remind me which day?" });
    await settled(later.chat);

    expect(later.chat.store.getSnapshot().error).toBeUndefined();
    expect(sent).toHaveLength(4);
    expect(sent[3].refused).toBeUndefined();
    expect(ofType(inputOf(3), "item_reference")).toEqual([]);
    expect(ofType(inputOf(3), "reasoning").map((r) => r.encrypted_content)).toEqual([
      "enc_1",
      "enc_2",
      "enc_3",
    ]);
    const lastParts = later.chat.messages[later.chat.messages.length - 1].parts;
    expect(lastParts.filter((p) => p.type === "text").map((p) => p.text)).toEqual([
      "Friday, as the page says.",
    ]);
  });

  test("without OpenAI's key the turn is refused before it is charged, and the panel says so", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      new Request("http://app.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "Hello?" }] }],
          projectId: PROJECT,
          pageId: PAGE,
          threadId: THREAD,
        }),
      }),
    );

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(retryNotice(body)).toBe("The assistant is briefly unavailable. Try again in a moment.");
    // Nothing spent: not the limiter, not the conversation's allowance, not OpenAI.
    expect(refuseIfLimited).not.toHaveBeenCalled();
    expect(convex.mutation).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(String(quiet.mock.calls[0]?.[1])).toContain("OPENAI_API_KEY is not set");
    quiet.mockRestore();
  });
});

describe("a board read in an earlier turn (NT-90)", () => {
  // 120 labelled shapes chained by connectors: a board someone has worked on.
  const board = parse(
    `<nt-diagram w="4000" h="3000">${Array.from(
      { length: 120 },
      (_, i) => `<nt-rect id="r${i}" x="${(i % 12) * 300}" y="${Math.floor(i / 12) * 200}" w="200" h="80">Step ${i}</nt-rect>`,
    ).join("")}${Array.from({ length: 119 }, (_, i) => `<nt-edge id="e${i}" from="r${i}" to="r${i + 1}"></nt-edge>`).join("")}</nt-diagram>`,
  );
  const host: CanvasHost = {
    readScene: async () => ({ scene: board }) as unknown as CanvasRead,
    writeScene: async () => {
      throw new Error("a report never writes");
    },
    prepareParse: async () => {},
  };
  const REPORTS = ["get_geometry", "get_styles", "get_html"] as const;

  test("is sent whole while its turn runs, and as a stale head in every later one", async () => {
    browserTools = Object.fromEntries(
      REPORTS.map((name) => [name, (input: unknown) => runCanvasTool(name, input, host)]),
    );
    script = [
      ...REPORTS.map((name, i) => ({
        thought: `Reading the board (${i}).`,
        call: { name, args: { blockId: "d1" } },
      })),
      { thought: "Laid out in a grid.", text: "The board is a 12-wide grid of 120 steps." },
    ];

    const first = panel();
    await first.chat.sendMessage({ text: "How is the board laid out?" });
    await settled(first.chat);
    expect(first.chat.store.getSnapshot().error).toBeUndefined();
    expect(first.answered).toHaveLength(3);
    expect(sent).toHaveLength(4);

    // Within the turn, the step after each read gets the report in full.
    const liveOutputs = ofType(inputOf(3), "function_call_output").map((o) => String(o.output));
    expect(liveOutputs).toHaveLength(3);
    const liveGeometry = JSON.parse(liveOutputs[0]) as { nodes: unknown[]; edges: unknown[] };
    expect(liveGeometry.nodes).toHaveLength(120);
    expect(liveGeometry.edges).toHaveLength(119);
    const liveSize = liveOutputs.reduce((n, o) => n + o.length, 0);

    // A later question, on the thread as Convex hands it back.
    script = [{ thought: "Answering.", text: "Twelve across." }];
    const later = panel(first.chat.messages.map(saved));
    await later.chat.sendMessage({ text: "And how many columns?" });
    await settled(later.chat);
    expect(later.chat.store.getSnapshot().error).toBeUndefined();
    expect(sent).toHaveLength(5);
    expect(sent[4].refused).toBeUndefined();

    const staleOutputs = ofType(inputOf(4), "function_call_output").map((o) => String(o.output));
    expect(staleOutputs).toHaveLength(3);
    for (const output of staleOutputs) {
      expect(output).toMatch(/from an earlier turn, and the diagram has changed since\. Ask for it again/);
      expect(output.length).toBeLessThan(500);
    }
    expect(staleOutputs[0].startsWith('{"diagram":{"w":4000,"h":3000},"nodes":[{"id":"r0"')).toBe(true);
    // The calls themselves still stand, so the model can see it read the board.
    expect(ofType(inputOf(4), "function_call").map((c) => c.name)).toEqual([...REPORTS]);
    const staleSize = staleOutputs.reduce((n, o) => n + o.length, 0);
    expect(liveSize).toBeGreaterThan(20 * staleSize);
  });
});
