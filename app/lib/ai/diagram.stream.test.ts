import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";
import { expect, test, vi } from "vitest";
import { AI } from "./aiConfig";
import { streamLedger, type StreamOutcome } from "./streamLedger";

/**
 * `streamDiagram` against a mock model: the text the canvas reads streams as
 * before, and the ledger hears how the call ended (NT-89).
 */

const { diagramModel } = vi.hoisted(() => ({ diagramModel: vi.fn() }));
vi.mock("./chat/provider", () => ({ diagramModel }));

import { streamDiagram } from "./diagram";

function answering(reason: "stop" | "length") {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "0" },
            { type: "text-delta", id: "0", delta: '<nt-diagram w="600" h="200">' },
            { type: "text-end", id: "0" },
            {
              type: "finish",
              finishReason: { unified: reason, raw: reason },
              usage: {
                inputTokens: { total: 3000, noCache: 3000, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: AI.diagram.maxTokens, text: AI.diagram.maxTokens, reasoning: 0 },
              },
            },
          ] satisfies LanguageModelV4StreamPart[])
            controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });
  diagramModel.mockReturnValue({ model });
  return model;
}

async function draw() {
  const rows: StreamOutcome[] = [];
  const res = streamDiagram("a flowchart", "", "", "", undefined, streamLedger((row) => rows.push(row), { startedAt: Date.now() }));
  const text = await res.text();
  return { res, text, rows };
}

test("the diagram still streams as plain text", async () => {
  const model = answering("stop");
  const { res, text, rows } = await draw();
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(text).toBe('<nt-diagram w="600" h="200">');
  expect(model.doStreamCalls[0].maxOutputTokens).toBe(AI.diagram.maxTokens + AI.diagram.thinkingHeadroom);
  expect(rows).toMatchObject([{ status: "ok", usage: { inputTokens: 3000 } }]);
  expect(rows[0].ttfbMs).toBeTypeOf("number");
});

test("a diagram cut off at the token cap is recorded as truncated, not ok", async () => {
  answering("length");
  const { rows } = await draw();
  expect(rows).toMatchObject([{ status: "error", errorCode: "truncated", usage: { outputTokens: AI.diagram.maxTokens } }]);
});
