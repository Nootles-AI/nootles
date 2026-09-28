import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NamingOutline } from "@/convex/github/naming";
import { nameRepository, parse } from "./name";
import { postChat } from "../providers";

vi.mock("../providers", () => ({
  chatTarget: () => ({ url: "https://example.invalid", key: "test", body: {} }),
  postChat: vi.fn(),
  readUsage: () => ({ promptTokens: 10, completionTokens: 20 }),
  reportUpstream: vi.fn(),
}));

const reply = (content: string, finish_reason = "stop") =>
  Response.json({
    choices: [{ message: { content }, finish_reason }],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  });

const outline = (count: number): NamingOutline => ({
  fullName: "sample/product",
  description: "Synthetic repository",
  areas: [
    {
      nodeId: "area-1",
      name: "src",
      concerns: Array.from({ length: count }, (_, i) => ({
        nodeId: `concern-${i}`,
        name: `folder-${i}`,
        styling: false,
        files: [
          { path: `src/feature-${i}.ts`, brief: "Handles this feature." },
        ],
        more: 0,
      })),
    },
  ],
});

beforeEach(() => {
  vi.mocked(postChat).mockReset();
});

describe("repository naming", () => {
  it("keeps complete names from a response cut off mid-row", () => {
    expect(
      parse(
        '{"names":[{"id":"concern-0","title":"First","brief":"A feature."},{"id":"concern-1","title":"Sec',
      ),
    ).toEqual([{ nodeId: "concern-0", title: "First", brief: "A feature." }]);
  });

  it("names every concern when a linked repository has a truncated response", async () => {
    let attempts = 0;
    let active = 0;
    let peak = 0;
    vi.mocked(postChat).mockImplementation(async (_target, body) => {
      const prompt = (body.messages as { content: string }[])[1].content;
      const ids = [...prompt.matchAll(/(?:AREA|CONCERN) id=([^\s]+)/g)].map(
        (match) => match[1],
      );
      expect(ids.length - 1).toBeLessThanOrEqual(30);
      expect(prompt.length).toBeLessThanOrEqual(50_000);
      const attempt = ++attempts;
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (attempt === 1) {
        return reply(
          `{"names":[{"id":"${ids[0]}","title":"Area","brief":"The area."},{"id":"${ids[1]}","title":"Feature","brief":"A feature."},{"id":"${ids[2]}"`,
          "length",
        );
      }
      return reply(
        JSON.stringify({
          names: ids.map((id) => ({
            id,
            title: `Named ${id}`,
            brief: "A feature.",
          })),
        }),
      );
    });

    const result = await nameRepository(outline(65));
    expect(new Set(result.names.map((n) => n.nodeId)).size).toBe(66);
    expect(result.names).toHaveLength(66);
    expect(result.calls).toHaveLength(attempts);
    expect(attempts).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(result.calls.some((call) => call.failure === "truncated")).toBe(
      true,
    );
  });

  it("keeps every id in bounded prompts even when file descriptions are long", async () => {
    const large = outline(22);
    for (const concern of large.areas[0].concerns) {
      concern.files = Array.from({ length: 12 }, (_, i) => ({
        path: `src/${concern.nodeId}/${i}/${"path".repeat(100)}`,
        brief: "Details ".repeat(100),
      }));
    }
    const seen = new Set<string>();
    vi.mocked(postChat).mockImplementation(async (_target, body) => {
      const prompt = (body.messages as { content: string }[])[1].content;
      expect(prompt.length).toBeLessThanOrEqual(50_000);
      const ids = [...prompt.matchAll(/(?:AREA|CONCERN) id=([^\s]+)/g)].map(
        (match) => match[1],
      );
      ids.forEach((id) => seen.add(id));
      return reply(
        JSON.stringify({
          names: ids.map((id) => ({
            id,
            title: `Named ${id}`,
            brief: "A feature.",
          })),
        }),
      );
    });

    const result = await nameRepository(large);
    expect(result.names).toHaveLength(23);
    expect(seen.size).toBe(23);
    expect(result.calls.length).toBeGreaterThan(1);
  });
});
