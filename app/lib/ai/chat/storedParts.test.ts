import { describe, expect, test } from "vitest";
import type { AbMessage } from "./types";
import { forStorage } from "./storedParts";

type Parts = AbMessage["parts"];
const tool = (name: string, input: unknown, output: unknown) =>
  ({ type: `tool-${name}`, toolCallId: `${name}-${Math.random()}`, state: "output-available", input, output }) as unknown as Parts[number];

describe("forStorage", () => {
  test("a research-heavy turn is cut to fit, and what was small is left as it was", () => {
    const reasoning = {
      type: "reasoning",
      text: "planning ".repeat(500),
      providerMetadata: { anthropic: { signature: "sig" } },
    } as unknown as Parts[number];
    const small = tool("search_context", { query: "schema" }, [{ id: "n1", title: "convex/schema.ts" }]);
    const parts: Parts = [
      reasoning,
      small,
      ...Array.from({ length: 25 }, (_, i) =>
        tool("read_context", { id: `f${i}` }, { id: `f${i}`, title: "file", content: "const x = 1;\n".repeat(4000) }),
      ),
      ...Array.from({ length: 10 }, () => tool("edit_page", { html: "<p>x</p>\n".repeat(8000) }, "Done:\n" + "<p>y</p>\n".repeat(8000))),
    ];
    expect(JSON.stringify(parts).length).toBeGreaterThan(1_048_576);

    const stored = forStorage(parts);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(700_000);
    expect(stored[0]).toBe(reasoning);
    expect(stored[1]).toEqual(small);
    const read = stored[2] as unknown as { output: { content: string; title: string } };
    expect(read.output.title).toBe("file");
    expect(read.output.content).toMatch(/cut when the thread was saved: \d+ characters -->$/);
  });

  test("a turn that already fits is saved exactly as it is", () => {
    const parts: Parts = [tool("list_pages", {}, [{ pageId: "p", title: "A" }])];
    expect(forStorage(parts)).toEqual(parts);
  });
});
