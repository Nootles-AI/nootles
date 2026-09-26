import { describe, expect, test } from "vitest";
import { convertToModelMessages, type ModelMessage, type ToolResultPart } from "ai";
import { AI } from "../aiConfig";
import { runCanvasTool } from "../canvas/execute";
import { parse } from "../canvas/fixtures";
import type { CanvasHost, CanvasRead } from "../canvas/host";
import { foldResearch, markCachePoints, shortenStaleReads } from "./transcript";
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
          { type: "tool-call", toolCallId: "c0", toolName: "read_open_page", input: {} },
          { type: "tool-call", toolCallId: "c1", toolName: "search_context", input: {} },
          { type: "tool-call", toolCallId: "c2", toolName: "expand_context", input: {} },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "c1", toolName: "search_context", output: { type: "json", value: [] } },
          { type: "tool-result", toolCallId: "c2", toolName: "expand_context", output: { type: "json", value: {} } },
          { type: "tool-result", toolCallId: "c0", toolName: "read_open_page", output: { type: "text", value: "" } },
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
    call("p1", "read_open_page"),
    result("p1", "read_open_page", page),
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
      call("p2", "read_open_page"),
      result("p2", "read_open_page", page),
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
    // Cut at a field boundary: the head is the report's own opening, whole values only.
    const geometry = (stale[0].output as { value: string }).value;
    expect(geometry.startsWith('{"diagram":{"w":4000,"h":3000},"nodes":[{"id":"r0"')).toBe(true);
    expect(geometry).toMatch(/[\w\]}"]… \(The rest/);

    // The turn in flight reads the board in full.
    expect(live.map((p) => p.output.type)).toEqual(["json", "json", "json"]);
    const full = live[0].output as unknown as { value: { nodes: unknown[]; edges: unknown[] } };
    expect(full.value.nodes).toHaveLength(120);
    expect(full.value.edges).toHaveLength(119);
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
