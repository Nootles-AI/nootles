import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { streamText, tool, stepCountIs, type ToolSet } from "ai";
import { TOOLS, type ToolName } from "@/app/lib/ai/chat/tools";
import { stagedModel, resolveStep } from "./model";
import { cursor } from "./stage";
import { SCRIPTS } from "./scripts";
import type { AbMessage } from "@/app/lib/ai/chat/types";
import type { StageContext } from "./types";

/**
 * The staged model, driven by the real `streamText`.
 *
 * This is the claim the whole design rests on — that the loop cannot tell one
 * of these from OpenAI — so it is asserted against the actual SDK rather than
 * reasoned about. If the stream-part contract ever moves, this fails here
 * instead of in front of a room.
 */

/** `streamText` flattens the provider's finish-reason pair; the model sends both. */
function unified(reason: unknown): string {
  return typeof reason === "string" ? reason : (reason as { unified: string }).unified;
}

/** The chat tools, minus the executes, which is what makes them client tools. */
function clientish(names: ToolName[]): ToolSet {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    const { description, inputSchema } = TOOLS[name];
    // Indexed by a variable, `inputSchema` is the union of all thirty-odd tool
    // schemas and inference gives up. They are all Zod types; say so.
    out[name] = tool({ description, inputSchema: inputSchema as z.ZodType });
  }
  return out as ToolSet;
}

const ctx: StageContext = {
  projectId: "p1",
  pageId: "pg_open",
  said: "does the firmware actually do what REQ-015 says?",
  results: [],
  pages: [
    { pageId: "pg_open", title: "Program Brief" },
    { pageId: "pg_req", title: "Requirements & Traceability" },
  ],
};

describe("the staged model is a model", () => {
  it("streams text and a validated tool call through streamText", async () => {
    const script = SCRIPTS.find((s) => s.id === "C-16")!;
    const step = resolveStep(script.steps[0], ctx, script.bail);

    const result = streamText({
      model: stagedModel(script.id, step),
      tools: clientish(["read_page"]),
      stopWhen: stepCountIs(1),
      messages: [{ role: "user", content: ctx.said }],
    });

    let text = "";
    const calls: { toolName: string; input: unknown }[] = [];
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "tool-call") {
        calls.push({ toolName: part.toolName, input: part.input });
      }
    }

    expect(text).toContain("REQ-015");
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("read_page");
    // Parsed by the SDK against the real schema on the way through — a
    // malformed input would have thrown before it got here.
    expect(calls[0].input).toEqual({ pageId: "pg_req" });
    expect(unified(await result.finishReason)).toBe("tool-calls");
  });

  it("a text-only step ends the turn rather than asking for a tool", async () => {
    const script = SCRIPTS.find((s) => s.id === "C-09")!;
    // No diagram anywhere: the resolver stands down and the step becomes prose.
    const step = resolveStep(script.steps[2], { ...ctx, results: [] }, script.bail);

    const result = streamText({
      model: stagedModel(script.id, step),
      tools: clientish(["edit_page"]),
      stopWhen: stepCountIs(1),
      messages: [{ role: "user", content: "add a retry branch" }],
    });

    expect(await result.text).toBe(script.bail);
    expect(unified(await result.finishReason)).toBe("stop");
  });

  it("the ledger sees a staged turn as a staged turn", () => {
    const step = resolveStep(SCRIPTS[0].steps[0], ctx, SCRIPTS[0].bail);
    expect(stagedModel("C-16", step).modelId).toBe("staged/C-16");
    expect(stagedModel("C-16", step).provider).toBe("nootles-staged");
  });
});

describe("the cursor survives a client-tool round trip", () => {
  /** A turn part-way through: one step taken, its tool answered. */
  const resumed: AbMessage[] = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "x" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-read_page",
          toolCallId: "t1",
          state: "output-available",
          input: {},
          output: "<h1>Requirements</h1>",
        },
        { type: "step-start" },
      ],
    },
  ] as unknown as AbMessage[];

  it("counts steps off the turn, not off streamText", () => {
    // `streamText` restarts at zero on every resume request, which is exactly
    // why the script's place is read from the transcript instead.
    expect(cursor(resumed)).toBe(2);
    expect(cursor([resumed[0]])).toBe(0);
  });

  it("walks a whole script without repeating or skipping a step", () => {
    const script = SCRIPTS.find((s) => s.id === "C-16")!;
    const seen: string[] = [];
    for (let at = 0; at < script.steps.length; at++) {
      const step = resolveStep(script.steps[at], ctx, script.bail);
      expect(step.done).toBe(false);
      seen.push(step.calls.map((c) => c.toolName).join(",") || "(text)");
    }
    expect(seen).toEqual(["read_page", "read_page", "edit_page"]);
    // One past the end ends the turn rather than starting it again.
    expect(resolveStep(script.steps[script.steps.length], ctx, script.bail).done).toBe(true);
  });
});
