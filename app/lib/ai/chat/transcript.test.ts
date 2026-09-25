import { describe, expect, test } from "vitest";
import type { ModelMessage } from "ai";
import { foldResearch, markCachePoints } from "./transcript";

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
