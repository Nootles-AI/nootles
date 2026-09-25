import { beforeEach, describe, expect, test, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import type { ConvexHttpClient } from "convex/browser";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The `write` tool against a scripted writer and an in-memory holding pen:
 * what the writer is asked, what is kept, and that a retry costs nothing.
 * Nothing leaves the process — the model is a mock and Convex a stand-in.
 */

const { writerModel, recordAiCall } = vi.hoisted(() => ({
  writerModel: vi.fn(),
  recordAiCall: vi.fn(),
}));
vi.mock("./provider", () => ({ writerModel, searchModel: vi.fn() }));
vi.mock("../recordCall", () => ({ recordAiCall }));
vi.mock("server-only", () => ({}));

import { chatTools } from "./serverTools";

type Prompt = { role: string; content: unknown }[];

function writer(reply: string) {
  const prompts: Prompt[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      prompts.push(prompt as Prompt);
      return {
        content: [{ type: "text", text: reply }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 300, text: 300, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  writerModel.mockReturnValue({ model });
  return prompts;
}

function convexStandIn() {
  const pen = new Map<string, string>();
  const query = vi.fn(async (_fn: unknown, args: { refs?: string[]; id?: string }) => {
    if (args.refs) return Object.fromEntries(args.refs.flatMap((r) => (pen.has(r) ? [[r, pen.get(r)!]] : [])));
    if (args.id === "doc1") {
      return { id: "doc1", kind: "document", title: "Design notes", brief: "b", owner: null, summary: "s", text: "Pages sync as Yjs CRDTs." };
    }
    return null;
  });
  const mutation = vi.fn(async (_fn: unknown, args: { ref: string; data: string }) => {
    pen.set(args.ref, args.data);
    return null;
  });
  return { pen, convex: { query, mutation, action: vi.fn() } as unknown as ConvexHttpClient & { query: typeof query } };
}

const execute = (convex: ConvexHttpClient, input: { brief: string; sources?: string[] }) => {
  const tools = chatTools("p1" as Id<"projects">, convex, "user_1");
  return (tools.write as unknown as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(
    input,
    { toolCallId: "t1", messages: [] },
  );
};

describe("write", () => {
  beforeEach(() => {
    writerModel.mockReset();
    recordAiCall.mockReset();
  });

  test("the writer gets the brief and what the sources say; the section is kept cleaned", async () => {
    const prompts = writer('```html\n<h2 id="s">Sync</h2>\n<p>Pages sync as Yjs CRDTs.</p>\n```');
    const { pen, convex } = convexStandIn();

    const out = await execute(convex, { brief: "Explain sync.", sources: ["doc1", "gone"] });

    const asked = JSON.stringify(prompts[0]);
    expect(asked).toContain("You write one section of a page in Nootles");
    expect(asked).toContain("THE BRIEF\\nExplain sync.");
    expect(asked).toContain("SOURCE 1: Design notes (document)\\nPages sync as Yjs CRDTs.");
    expect(asked).toContain("SOURCE 2: gone — not in this project's context");
    expect(out).toMatchObject({ headings: ["Sync"], blocks: 2, diagrams: 0 });
    expect(pen.get(out.ref as string)).toBe("<h2>Sync</h2>\n<p>Pages sync as Yjs CRDTs.</p>");
    expect(recordAiCall).toHaveBeenCalledWith(
      convex,
      expect.objectContaining({ feature: "chat", status: "ok", promptTokens: 900, completionTokens: 300 }),
    );
  });

  test("the same brief again is answered from the pen, without the writer", async () => {
    const prompts = writer("<p>Once.</p>");
    const { convex } = convexStandIn();
    const first = await execute(convex, { brief: "Say it once." });
    const again = await execute(convex, { brief: "Say it once." });
    expect(again.ref).toBe(first.ref);
    expect(prompts).toHaveLength(1);
  });

  test("what the writer could not source reaches the agent, from the pen too", async () => {
    const prompts = writer("<p>Authors delete their comments.</p>\n<!-- unsourced:\n- authors alone delete comments\n-->");
    const { convex } = convexStandIn();
    const first = await execute(convex, { brief: "Comments." });
    const again = await execute(convex, { brief: "Comments." });
    expect(first.unsourced).toEqual(["authors alone delete comments"]);
    expect(again.unsourced).toEqual(["authors alone delete comments"]);
    expect(first.blocks).toBe(1);
    expect(prompts).toHaveLength(1);
  });

  test("a writer that answers nothing is an error the agent can act on", async () => {
    writer("   ");
    const { pen, convex } = convexStandIn();
    const out = await execute(convex, { brief: "Nothing." });
    expect(out.error).toMatch(/Call write again with the SAME brief/);
    expect(pen.size).toBe(0);
  });
});
