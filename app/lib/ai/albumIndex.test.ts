import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeSheet } from "./albumIndex";

const sheet = {
  dataUri: "data:image/webp;base64,fixture",
  handles: ["k3x9", "p7q2", "r4s8"],
};

async function answer(content: string, finish_reason = "stop") {
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      choices: [{ message: { content }, finish_reason }],
      usage: { prompt_tokens: 20, completion_tokens: 30 },
    }),
  );
  vi.stubGlobal("fetch", fetch);
  const result = await describeSheet(sheet);
  return { result, body: JSON.parse(fetch.mock.calls[0][1].body) };
}

describe("album sheet captioning", () => {
  beforeEach(() => {
    vi.stubEnv("USE_OPENROUTER", "false");
    vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "fixture-key");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("accepts model-formatted tables and bullets while keeping captions with their handles", async () => {
    const { result } = await answer(
      "| handle | striking | what the photograph is |\n" +
        "| --- | --- | --- |\n" +
        "| k3x9 | 72/99 | fog over a pier |\n" +
        "- **p7q2** | striking: 81 | sunlit red boat |\n" +
        "* `r4s8` | 14 | a blue doorway |",
    );
    expect(result.described).toEqual([
      { handle: "k3x9", striking: 72, alt: "fog over a pier" },
      { handle: "p7q2", striking: 81, alt: "sunlit red boat" },
      { handle: "r4s8", striking: 14, alt: "a blue doorway" },
    ]);
  });

  it("does not return the final row of a response cut off at the token limit", async () => {
    const { result } = await answer(
      "k3x9 | 72 | fog over a pier\np7q2 | 81 | sunlit red bo",
      "length",
    );
    expect(result.described).toEqual([
      { handle: "k3x9", striking: 72, alt: "fog over a pier" },
    ]);
  });

  it("does not attach a plausible caption to the wrong tile when handles are swapped", async () => {
    const { result } = await answer(
      "p7q2 | 72 | fog over a pier\nk3x9 | 81 | sunlit red boat\nr4s8 | 14 | a blue doorway",
    );
    expect(result.described).toEqual([
      { handle: "r4s8", striking: 14, alt: "a blue doorway" },
    ]);
  });

  it("accepts numbered rows when the model echoes the ordered handle list", async () => {
    const { result } = await answer("1. k3x9 | 72 | fog over a pier\n2) p7q2 | 81 | sunlit red boat");
    expect(result.described).toEqual([
      { handle: "k3x9", striking: 72, alt: "fog over a pier" },
      { handle: "p7q2", striking: 81, alt: "sunlit red boat" },
    ]);
  });

  it("gives the model the grid order and handles to use by position", async () => {
    const { body } = await answer("k3x9 | 72 | fog over a pier");
    const messages = JSON.stringify(body.messages);
    expect(messages).toContain("left to right");
    expect(messages).toContain("top to bottom");
    expect(messages).toContain("1. k3x9");
    expect(messages).toContain("2. p7q2");
  });
});
