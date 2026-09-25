import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { Id } from "@/convex/_generated/dataModel";
import { F1 } from "../canvas/fixtures";
import type { AnyBlock } from "../projection";
import { runClientTool, type ToolContext } from "./clientTools";
import { NOTHING_WAS_WRITTEN } from "./mutationResult";
import { isRepeatedMutation } from "./toolReplay";
import type { AbMessage } from "./types";

beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString(html: string) {
      return parseHTML(html).document;
    }
  };
});

const pageId = "page-1" as Id<"pages">;
const projectId = "project-1" as Id<"projects">;

function context(block: AnyBlock) {
  const stage = vi.fn(async () => {
    throw new Error("review is busy");
  });
  const ctx = {
    convex: {
      query: vi.fn(async () => ({ _id: pageId, projectId, docId: "doc-1", title: "Page" })),
      mutation: vi.fn(),
      action: vi.fn(),
    },
    projectId,
    review: { stage },
    openPageId: () => pageId,
    openPage: vi.fn(),
    editorFor: vi.fn(async () => ({ document: [block] })),
    commentsFor: vi.fn(async () => null),
    people: () => [],
  } as unknown as ToolContext;
  return { ctx, stage };
}

function retried(toolName: string, input: unknown, output: unknown): boolean {
  const messages = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "change it" }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: `tool-${toolName}`,
          toolCallId: "call-1",
          state: "output-available",
          input,
          output,
        },
      ],
    },
  ] as AbMessage[];
  return isRepeatedMutation(messages, { toolName, toolCallId: "call-2", input });
}

describe("transient client-tool retries", () => {
  it("lets the exact page edit run after staging wrote nothing", async () => {
    const block = {
      id: "paragraph-1",
      type: "paragraph",
      props: {},
      content: [{ type: "text", text: "Old words", styles: {} }],
      children: [],
    } as AnyBlock;
    const { ctx, stage } = context(block);
    const input = {
      pageId,
      html: '<p id="paragraph-1">New words</p>',
    };

    const output = await runClientTool("edit_page", input, ctx);

    expect(stage).toHaveBeenCalledOnce();
    expect(output).toEqual(expect.stringMatching(`^${NOTHING_WAS_WRITTEN}`));
    expect(retried("edit_page", input, output)).toBe(false);
  });

  it("lets the exact canvas call run after staging wrote nothing", async () => {
    const block = {
      id: "canvas-1",
      type: "canvas",
      props: { data: F1 },
      content: undefined,
      children: [],
    } as AnyBlock;
    const { ctx, stage } = context(block);
    const input = {
      pageId,
      blockId: block.id,
      ids: ["s1"],
      dx: 20,
      dy: 10,
    };

    const output = await runClientTool("move", input, ctx);

    expect(stage).toHaveBeenCalledOnce();
    expect(output).toEqual(expect.stringMatching(`^${NOTHING_WAS_WRITTEN}`));
    expect(retried("move", input, output)).toBe(false);
  });

  it("lets the exact album call run after staging wrote nothing", async () => {
    const block = {
      id: "album-1",
      type: "album",
      props: {
        data:
          '<nt-album id="album-1"><img src="https://images.example/a.jpg" w="640" h="480"></nt-album>',
      },
      content: undefined,
      children: [],
    } as AnyBlock;
    const { ctx, stage } = context(block);
    const input = {
      pageId,
      blockId: block.id,
      ops: [{ op: "grid" as const, cols: 3 }],
    };

    const output = await runClientTool("album_edit", input, ctx);

    expect(stage).toHaveBeenCalledOnce();
    expect(output).toEqual(expect.stringMatching(`^${NOTHING_WAS_WRITTEN}`));
    expect(retried("album_edit", input, output)).toBe(false);
  });
});
