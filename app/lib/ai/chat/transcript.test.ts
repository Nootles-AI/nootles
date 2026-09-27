import { describe, expect, test } from "vitest";
import { convertToModelMessages, type ModelMessage, type ToolResultPart } from "ai";
import { AI } from "../aiConfig";
import { runCanvasTool } from "../canvas/execute";
import { parse } from "../canvas/fixtures";
import type { CanvasHost, CanvasRead } from "../canvas/host";
import {
  foldResearch,
  markCachePoints,
  shortenStaleMentions,
  shortenStaleParts,
  shortenStaleReads,
  withoutTurnContext,
} from "./transcript";
import { convertDataPart } from "./parts";
import type { AbMessage } from "./types";

const marked = (o: unknown) =>
  !!(o as { openrouter?: { cacheControl?: unknown } } | undefined)?.openrouter?.cacheControl;

describe("markCachePoints", () => {
  test("a step of parallel calls is one breakpoint, on its last result", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "Dig in" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "c0", toolName: "read_page", input: {} },
          { type: "tool-call", toolCallId: "c1", toolName: "search_context", input: {} },
          { type: "tool-call", toolCallId: "c2", toolName: "expand_context", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "search_context", output: { type: "json", value: [] } },
          { type: "tool-result", toolCallId: "c2", toolName: "expand_context", output: { type: "json", value: {} } },
          { type: "tool-result", toolCallId: "c0", toolName: "read_page", output: { type: "text", value: "" } },
        ],
      },
    ];
    const out = markCachePoints(messages);
    const tool = out[2] as Extract<ModelMessage, { role: "tool" }>;

    // OpenRouter copies a message-level mark onto every result it splits out,
    // which made this step three breakpoints of Anthropic's four.
    expect(marked(tool.providerOptions)).toBe(false);
    expect(tool.content.map((part) => marked(part.type === "tool-result" ? part.providerOptions : undefined))).toEqual([
      false,
      false,
      true,
    ]);
    expect(marked(out[0].providerOptions)).toBe(true);
    expect(marked(out[1].providerOptions)).toBe(false);
  });

  test("marking again moves the end mark rather than adding one", () => {
    const first = markCachePoints([
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: {} }],
        providerOptions: { openrouter: { reasoning_details: ["kept"] } },
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "search", output: { type: "text", value: "" } }],
      },
    ]);
    // What a step hands the next: its own marks still on, one more exchange after.
    const next = markCachePoints([
      ...first,
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c2", toolName: "search", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c2", toolName: "search", output: { type: "text", value: "" } }],
      },
    ]);
    const marks = next.flatMap((m, i) => [
      ...(marked(m.providerOptions) ? [i] : []),
      ...(Array.isArray(m.content)
        ? m.content.flatMap((p) => ("providerOptions" in p && marked(p.providerOptions) ? [i] : []))
        : []),
    ]);
    expect(marks).toEqual([0, 4]);
    expect(next[1].providerOptions?.openrouter?.reasoning_details).toEqual(["kept"]);
  });

  test("a message that is not a tool result is marked on itself", () => {
    const out = markCachePoints([{ role: "user", content: "hi" }]);
    expect(marked(out[0].providerOptions)).toBe(true);
  });
});

describe("foldResearch", () => {
  const call = (id: string, toolName: string): ModelMessage => ({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: id, toolName, input: {} }],
  });
  const result = (id: string, toolName: string, output: unknown): ModelMessage => ({
    role: "tool",
    content: [{ type: "tool-result", toolCallId: id, toolName, output: output as never }],
  });
  const file = { type: "json", value: { id: "n1", kind: "file", title: "convex/schema.ts", brief: "b", content: "x".repeat(40_000) } };
  const page = { type: "text", value: `<title>Overview</title>\n${"<p>words</p>\n".repeat(2000)}` };

  const research: ModelMessage[] = [
    { role: "user", content: "Document the architecture" },
    call("r1", "read_context"),
    result("r1", "read_context", file),
    call("p1", "read_page"),
    result("p1", "read_page", page),
    call("s1", "search_context"),
    result("s1", "search_context", { type: "json", value: [{ id: "n1", title: "convex/schema.ts" }] }),
  ];

  test("before anything is written, research is left whole", () => {
    expect(foldResearch(research)).toEqual(research);
  });

  test("once a section is written, the reads before it fold and what follows stays", () => {
    const after = [
      ...research,
      call("w1", "write"),
      result("w1", "write", { type: "json", value: { ref: "w1abc", headings: ["Data"] } }),
      call("p2", "read_page"),
      result("p2", "read_page", page),
    ];
    const out = foldResearch(after);
    const value = (i: number) => ((out[i] as Extract<ModelMessage, { role: "tool" }>).content[0] as { output: { value: unknown } }).output.value;

    expect(value(2)).toEqual({
      id: "n1",
      kind: "file",
      title: "convex/schema.ts",
      brief: "b",
      folded: expect.stringContaining("read_context has it again"),
    });
    expect(String(value(4)).length).toBeLessThan(400);
    expect(String(value(4))).toMatch(/^<title>Overview<\/title>/);
    expect(value(6)).toEqual([{ id: "n1", title: "convex/schema.ts" }]);
    expect(value(8)).toEqual({ ref: "w1abc", headings: ["Data"] });
    expect(value(10)).toBe(page.value);
  });
});

describe("shortenStaleReads on canvas reports", () => {
  // A board big enough to matter: 120 labelled shapes chained by connectors.
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

  const READS = ["get_geometry", "get_styles", "get_html"] as const;

  /** One turn that read the board three ways, in the parts a thread stores. */
  async function reportingTurn(n: number): Promise<AbMessage[]> {
    const parts = await Promise.all(
      READS.map(async (name) => ({
        type: `tool-${name}`,
        toolCallId: `${name}-${n}`,
        state: "output-available",
        input: { blockId: "d1" },
        output: await runCanvasTool(name, { blockId: "d1" }, host),
      })),
    );
    return [
      { id: `u${n}`, role: "user", parts: [{ type: "text", text: `Look at the board (${n})` }] },
      { id: `a${n}`, role: "assistant", parts: [...parts, { type: "text", text: "Done." }] } as AbMessage,
    ];
  }

  /** What the route sends: the thread through the SDK's conversion, then shortened. */
  async function asSent(thread: AbMessage[]) {
    const results = shortenStaleReads(await convertToModelMessages<AbMessage>(thread, { ignoreIncompleteToolCalls: true }))
      .filter((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool")
      .flatMap((m) => m.content)
      .filter((p): p is ToolResultPart => p.type === "tool-result");
    return { stale: results.filter((p) => p.toolCallId.endsWith("-1")), live: results.filter((p) => p.toolCallId.endsWith("-2")) };
  }

  test("an earlier turn's reports shrink to a head that says they are stale", async () => {
    const { stale, live } = await asSent([...(await reportingTurn(1)), ...(await reportingTurn(2))]);

    expect(stale.map((p) => p.toolName)).toEqual([...READS]);
    for (const part of stale) {
      expect(part.output.type).toBe("text");
      const value = (part.output as { value: string }).value;
      expect(value.length).toBeLessThan(AI.chat.staleReadChars + 200);
      expect(value).toMatch(/earlier turn, and the diagram has changed since\. Ask for it again/);
    }
    // Geometry is rows (NT-98), cut at a row: whole rows only.
    const geometry = (stale[0].output as { value: string }).value;
    expect(geometry.startsWith("diagram 4000×3000.")).toBe(true);
    expect(geometry).toMatch(/top level\.\n… \(The rest/);
    // The other two are still JSON, cut at a field boundary.
    expect((stale[1].output as { value: string }).value).toMatch(/[\w\]}"]… \(The rest/);

    // The turn in flight reads the board in full.
    expect(live.map((p) => p.output.type)).toEqual(["text", "json", "json"]);
    const rows = (live[0].output as { value: string }).value.split("\n");
    expect(rows.filter((row) => / rect "/.test(row))).toHaveLength(120);
    expect(rows.filter((row) => /^\S+ \S+>\S+ /.test(row))).toHaveLength(119);
  });

  test("before and after: what the earlier turn costs every later request", async () => {
    const thread = [...(await reportingTurn(1)), ...(await reportingTurn(2))];
    const converted = await convertToModelMessages<AbMessage>(thread);
    const earlier = converted.findLastIndex((m) => m.role === "user");
    const raw = converted.slice(0, earlier);
    const shortened = shortenStaleReads(converted).slice(0, earlier);
    const size = (m: ModelMessage[]) => JSON.stringify(m).length;
    expect(size(raw)).toBeGreaterThan(20_000);
    expect(size(shortened)).toBeLessThan(2_000);
  });

  test("a report already that small is left as it came", () => {
    const small = { type: "json" as const, value: { diagram: { w: 10, h: 10 }, nodes: [], edges: [] } };
    const messages: ModelMessage[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "g", toolName: "get_geometry", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "g", toolName: "get_geometry", output: small }] },
      { role: "user", content: "b" },
    ];
    const out = shortenStaleReads(messages);
    expect(out[2]).toBe(messages[2]);
  });

  test("a canvas tool's refusal is a string, so it keeps the text path", async () => {
    const refusal = await runCanvasTool("get_geometry", { blockId: "nope" }, { ...host, readScene: async () => null });
    expect(typeof refusal).toBe("string");
  });

  test("a report read before the writer drafted folds with the rest of the research", () => {
    const geometry = { type: "json" as const, value: { diagram: { w: 1, h: 1 }, nodes: Array.from({ length: 50 }, (_, i) => ({ id: `n${i}` })), edges: [] } };
    const out = foldResearch([
      { role: "user", content: "Draw it up" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "g", toolName: "get_geometry", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "g", toolName: "get_geometry", output: geometry }] },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "w", toolName: "write", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "w", toolName: "write", output: { type: "text", value: "ok" } }] },
    ]);
    const folded = (out[2] as Extract<ModelMessage, { role: "tool" }>).content[0] as ToolResultPart;
    expect(folded.output.type).toBe("text");
    expect((folded.output as { value: string }).value).toMatch(/Ask for it again/);
  });
});

describe("shortenStaleReads on page reads", () => {
  const page = { type: "text" as const, value: `<title>Overview</title>\n${"<p>words</p>\n".repeat(2000)}` };
  const turn = (toolName: string): ModelMessage[] => [
    { role: "user", content: "What does it say?" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "r", toolName, input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "r", toolName, output: page }] },
    { role: "user", content: "And now?" },
  ];
  const head = (out: ModelMessage[]) =>
    ((out[2] as Extract<ModelMessage, { role: "tool" }>).content[0] as ToolResultPart).output as { value: string };

  test.each(["read_page", "read_open_page"])("an earlier turn's %s shrinks to its head", (toolName) => {
    // read_open_page was folded into read_page (NT-93); threads saved before
    // still carry its reads, and they cost the same every later request.
    const out = shortenStaleReads(turn(toolName));
    expect(head(out).value.length).toBeLessThan(AI.chat.staleReadChars + 200);
    expect(head(out).value).toMatch(/^<title>Overview<\/title>/);
  });
});

describe("withoutTurnContext (NT-97)", () => {
  const answer: AbMessage = {
    id: "a1",
    role: "assistant",
    metadata: {
      commentsGate: { pageId: "k57abcdefghijklmnopqrstu", include: true },
      turnContext: { pageId: "k57abcdefghijklmnopqrstu", text: "[Attached by Nootles…] Wiring: The power path." },
    },
    parts: [{ type: "text", text: "Done." }],
  };

  test("drops the turn's context and keeps the rest of the metadata", () => {
    const kept = withoutTurnContext(answer);
    expect(kept.metadata).toEqual({ commentsGate: { pageId: "k57abcdefghijklmnopqrstu", include: true } });
    expect(kept.parts).toBe(answer.parts);
    expect(answer.metadata?.turnContext).toBeDefined();
  });

  test("a message without one is returned as it is", () => {
    const plain: AbMessage = { id: "u1", role: "user", parts: [{ type: "text", text: "Hi" }] };
    expect(withoutTurnContext(plain)).toBe(plain);
  });
});

describe("context reads from an earlier turn (NT-98)", () => {
  const file = { id: "n1", kind: "file", title: "convex/schema.ts", brief: "The schema.", content: "x".repeat(60_000) };
  const thread: AbMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "What tables are there?" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "tool-read_context", toolCallId: "r1", state: "output-available", input: { id: "n1" }, output: file },
        { type: "text", text: "Twelve." },
      ],
    } as AbMessage,
    { id: "u2", role: "user", parts: [{ type: "text", text: "And indexes?" }] },
  ];

  const readOf = (messages: ModelMessage[]) =>
    (messages.find((m) => m.role === "tool") as Extract<ModelMessage, { role: "tool" }>).content[0] as ToolResultPart;

  test("fold to what they are in every later turn, with no write in sight", async () => {
    const out = readOf(shortenStaleReads(await convertToModelMessages<AbMessage>(thread)));
    expect(out.output).toEqual({
      type: "json",
      value: { id: "n1", kind: "file", title: "convex/schema.ts", brief: "The schema.", folded: expect.stringContaining("read_context has it again") },
    });
  });

  test("stay whole in the turn that read them", async () => {
    const out = readOf(shortenStaleReads(await convertToModelMessages<AbMessage>(thread.slice(0, 2))));
    expect((out.output as unknown as { value: { content: string } }).value.content).toHaveLength(60_000);
  });

  test("the browser sends them folded, and the route leaves them so", async () => {
    const sent = shortenStaleParts(thread);
    const part = sent[1].parts[0] as { output: Record<string, unknown> };
    expect(part.output.content).toBeUndefined();
    expect(part.output.folded).toMatch(/read_context has it again/);
    expect(JSON.stringify(sent).length).toBeLessThan(2_000);
    // The thread itself is untouched: it is the record.
    expect((thread[1].parts[0] as { output: typeof file }).output.content).toHaveLength(60_000);
    const routed = readOf(shortenStaleReads(await convertToModelMessages<AbMessage>(sent)));
    expect(routed.output).toEqual(readOf(shortenStaleReads(await convertToModelMessages<AbMessage>(thread))).output);
  });
});

describe("pages mentioned in an earlier message (NT-98)", () => {
  const content = `<title>Launch plan</title>\n${'<p id="b1">A long paragraph of the plan.</p>\n'.repeat(500)}`;
  const mention = { type: "data-mention" as const, data: { kind: "page" as const, pageId: "k1", title: "Launch plan", content } };
  const thread: AbMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "Summarise @Launch plan" }, mention] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "It is a plan." }] },
    { id: "u2", role: "user", parts: [{ type: "text", text: "Compare it with @Launch plan now" }, mention] },
  ];
  const mentionIn = (message: AbMessage) =>
    (message.parts.find((p) => p.type === "data-mention") as typeof mention).data.content;

  test("an earlier message keeps the page's first line and says to read it again", () => {
    const out = shortenStaleMentions(thread);
    const head = mentionIn(out[0]);
    expect(head.startsWith("<title>Launch plan</title>\n")).toBe(true);
    expect(head).toMatch(
      /<\/p>\n<!-- The rest of this page is not shown: it was mentioned in an earlier message, and the page may have changed since\. read_page has it as it is now\. -->$/,
    );
    expect(head.length).toBeLessThan(AI.chat.staleReadChars + 200);
    expect(out[0].parts[0]).toBe(thread[0].parts[0]);
  });

  test("the message in flight keeps its mention whole", () => {
    const out = shortenStaleMentions(thread);
    expect(mentionIn(out[2])).toBe(content);
    expect(out[2]).toBe(thread[2]);
    expect(shortenStaleMentions(thread.slice(0, 1))[0]).toBe(thread[0]);
  });

  test("the browser and the route send the same words, and shortening twice changes nothing", async () => {
    const browser = shortenStaleParts(thread);
    expect(shortenStaleMentions(browser)).toEqual(browser);
    const model = await convertToModelMessages<AbMessage>(shortenStaleMentions(browser), { convertDataPart });
    const earlier = JSON.stringify(model[0]);
    expect(earlier).toContain("read_page has it as it is now");
    expect(earlier.length).toBeLessThan(700);
    expect(JSON.stringify(model[2]).length).toBeGreaterThan(content.length);
  });
});
