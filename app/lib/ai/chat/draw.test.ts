import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { Id } from "@/convex/_generated/dataModel";

const { generateVectorDrawing, recordAiCall } = vi.hoisted(() => ({
  generateVectorDrawing: vi.fn(),
  recordAiCall: vi.fn(),
}));
vi.mock("../vectorDraw", () => ({ generateVectorDrawing }));
vi.mock("../recordCall", () => ({ recordAiCall }));
vi.mock("./provider", () => ({ writerModel: vi.fn(), searchModel: vi.fn() }));
vi.mock("server-only", () => ({}));

import { chatTools } from "./serverTools";

const html = '<nt-diagram w="320" h="180"><nt-rect id="one" x="0" y="0" w="20" h="20"></nt-rect></nt-diagram>';

function standIn() {
  const pen = new Map<string, string>();
  const query = vi.fn(async (_fn: unknown, { refs }: { refs: string[] }) =>
    Object.fromEntries(refs.flatMap((ref) => pen.has(ref) ? [[ref, pen.get(ref)!]] : [])));
  const mutation = vi.fn(async (_fn: unknown, { ref, data }: { ref: string; data: string }) => {
    pen.set(ref, data);
    return null;
  });
  return { pen, convex: { query, mutation } as unknown as ConvexHttpClient };
}

function approvedDraw(
  convex: ConvexHttpClient,
  brief: string,
  keepAlive?: (work: Promise<unknown>) => void,
) {
  const tools = chatTools("project" as Id<"projects">, convex, "user_1", undefined, { keepAlive }, "message-1");
  const execute = tools.draw.execute as unknown as (input: unknown, options: unknown) => Promise<Record<string, unknown>>;
  return execute({ brief, ratio: "16:9" }, { toolCallId: `draw-${brief}`, messages: [] });
}

describe("an approved storyboard draw", () => {
  beforeEach(() => {
    generateVectorDrawing.mockReset();
    recordAiCall.mockReset().mockResolvedValue(undefined);
  });

  test("keeps nine shots alive through the response and redeems each stored result on retry", async () => {
    const { pen, convex } = standIn();
    const keepAlive = vi.fn();
    const waiting = new Map<string, (value: unknown) => void>();
    generateVectorDrawing.mockImplementation((brief: string) => new Promise((resolve) => waiting.set(brief, resolve)));

    const briefs = Array.from({ length: 9 }, (_, i) => `Shot ${i + 1}`);
    const draws = briefs.map((brief) => approvedDraw(convex, brief, keepAlive));
    expect(keepAlive).toHaveBeenCalledTimes(9);
    await vi.waitFor(() => expect(waiting.size).toBe(9));
    for (const brief of briefs.toReversed()) waiting.get(brief)!({ html, latencyMs: 42 });

    const results = await Promise.all(draws);
    expect(results.every((result) => typeof result.ref === "string" && result.shapes === 1)).toBe(true);
    expect(new Set(results.map((result) => result.ref)).size).toBe(9);
    expect(pen.size).toBe(9);
    expect(recordAiCall).toHaveBeenCalledTimes(9);
    expect(recordAiCall).toHaveBeenCalledWith(convex, expect.objectContaining({ feature: "diagram", turnId: "message-1" }));
    const again = await approvedDraw(convex, briefs[0]);
    expect(again).toEqual(results[0]);
    expect(generateVectorDrawing).toHaveBeenCalledTimes(9);
  });

  test("keeps an import failure under a separate ref so retry cannot pay again or place it", async () => {
    const { pen, convex } = standIn();
    generateVectorDrawing.mockResolvedValue({
      html: null, latencyMs: 30, status: "error", errorCode: "invalid-svg", cacheFailure: true,
    });
    const first = await approvedDraw(convex, "A difficult shape");
    const second = await approvedDraw(convex, "A difficult shape");
    expect(first.error).toMatch(/Rewrite the brief/);
    expect(second).toEqual(first);
    expect(generateVectorDrawing).toHaveBeenCalledTimes(1);
    expect([...pen.keys()]).toEqual([expect.stringMatching(/^fd[0-9a-f]{10}$/)]);
    expect(recordAiCall).toHaveBeenCalledWith(convex, expect.objectContaining({
      status: "error", errorCode: "invalid-svg",
    }));
  });

  test("records a provider miss as an error with no guessed charge", async () => {
    const { pen, convex } = standIn();
    generateVectorDrawing.mockResolvedValue({
      html: null, latencyMs: 50, status: "error", errorCode: "upstream-429", cacheFailure: false,
    });
    const out = await approvedDraw(convex, "The first shot");
    expect(out.error).toMatch(/service recovers/);
    expect(pen.size).toBe(0);
    expect(recordAiCall).toHaveBeenCalledWith(convex, expect.objectContaining({
      status: "error", errorCode: "upstream-429", costUsdOverride: null,
    }));
  });
});
