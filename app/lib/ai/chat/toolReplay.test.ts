import { describe, expect, it } from "vitest";
import type { AbMessage } from "./types";
import { duplicateMutationResult, isRepeatedMutation } from "./toolReplay";

const user = (id: string): AbMessage =>
  ({
    id,
    role: "user",
    parts: [{ type: "text", text: "change it" }],
  }) as AbMessage;

const move = (
  toolCallId: string,
  state: "output-available" | "output-error" = "output-available",
  input: Record<string, unknown> = {
    pageId: "page-1",
    blockId: "canvas-1",
    ids: ["shape-1"],
    dx: 20,
    dy: 10,
  },
): AbMessage["parts"][number] =>
  ({
    type: "tool-move",
    toolCallId,
    state,
    input,
    ...(state === "output-available"
      ? { output: "Moved 1 shape. The user reviews this and may discard it." }
      : { errorText: "editor unavailable" }),
  }) as AbMessage["parts"][number];

const assistant = (...parts: AbMessage["parts"]): AbMessage =>
  ({ id: crypto.randomUUID(), role: "assistant", parts }) as AbMessage;

const currentMove = {
  toolName: "move",
  toolCallId: "move-2",
  input: {
    dy: 10,
    ids: ["shape-1"],
    blockId: "canvas-1",
    dx: 20,
    pageId: "page-1",
  },
};

describe("turn-scoped mutation replay guard", () => {
  it("suppresses an identical completed mutation despite object key order", () => {
    expect(
      isRepeatedMutation(
        [user("u1"), assistant(move("move-1"), move("move-2", "output-error"))],
        currentMove,
      ),
    ).toBe(true);
  });

  it("allows the same mutation in a later user turn", () => {
    expect(
      isRepeatedMutation(
        [user("u1"), assistant(move("move-1")), user("u2")],
        currentMove,
      ),
    ).toBe(false);
  });

  it("allows a failed mutation to be retried", () => {
    expect(
      isRepeatedMutation(
        [user("u1"), assistant(move("move-1", "output-error"))],
        currentMove,
      ),
    ).toBe(false);
  });

  it("does not deduplicate read tools", () => {
    const read = {
      toolName: "read_open_page",
      toolCallId: "read-2",
      input: { expand: ["canvas-1"] },
    };
    const previous = {
      type: "tool-read_open_page",
      toolCallId: "read-1",
      state: "output-available",
      input: { expand: ["canvas-1"] },
      output: "<p>Page</p>",
    } as AbMessage["parts"][number];
    expect(isRepeatedMutation([user("u1"), assistant(previous)], read)).toBe(
      false,
    );
  });

  it("does not collapse different move distances", () => {
    expect(
      isRepeatedMutation([user("u1"), assistant(move("move-1"))], {
        ...currentMove,
        input: { ...currentMove.input, dx: 40 },
      }),
    ).toBe(false);
  });

  it("allows edit_page's explicit same-content transient retry", () => {
    const input = { pageId: "page-1", html: '<p id="p1">New</p>' };
    const previous = {
      type: "tool-edit_page",
      toolCallId: "edit-1",
      state: "output-available",
      input,
      output:
        "The edit could not be applied just now. Call edit_page once more with the SAME content.",
    } as AbMessage["parts"][number];
    expect(
      isRepeatedMutation([user("u1"), assistant(previous)], {
        toolName: "edit_page",
        toolCallId: "edit-2",
        input,
      }),
    ).toBe(false);
  });

  it("returns a result that tells the model the second mutation did not run", () => {
    expect(duplicateMutationResult("move")).toContain(
      "document was not changed again",
    );
  });
});

describe("comment tools under the replay guard", () => {
  const call = (toolName: string, toolCallId: string, input: Record<string, unknown>) =>
    ({ type: `tool-${toolName}`, toolCallId, state: "output-available", input, output: "Done." }) as AbMessage["parts"][number];
  const create = { blockId: "p1", quote: "by Friday", text: "Is this firm?" };

  it("suppresses a second identical create, reply or resolve in the same turn", () => {
    for (const [toolName, input] of [
      ["create_comment", create],
      ["reply_comment", { threadId: "t1", text: "Yes." }],
      ["resolve_comment", { threadId: "t1" }],
    ] as const) {
      expect(
        isRepeatedMutation([user("u1"), assistant(call(toolName, "a", input))], {
          toolName,
          toolCallId: "b",
          input,
        }),
      ).toBe(true);
    }
  });

  it("lets a call that was refused run again — nothing was written the first time", () => {
    const refused = {
      type: "tool-create_comment",
      toolCallId: "a",
      state: "output-available",
      input: create,
      output: "Nothing was written. Those words are in the change waiting for the user's review…",
    } as AbMessage["parts"][number];
    expect(
      isRepeatedMutation([user("u1"), assistant(refused)], { toolName: "create_comment", toolCallId: "b", input: create }),
    ).toBe(false);
  });

  it("lets a different comment through, and never holds back a read", () => {
    const history = [user("u1"), assistant(call("create_comment", "a", create))];
    expect(
      isRepeatedMutation(history, { toolName: "create_comment", toolCallId: "b", input: { ...create, text: "Another." } }),
    ).toBe(false);
    const read = [user("u1"), assistant(call("read_comments", "a", {}))];
    expect(isRepeatedMutation(read, { toolName: "read_comments", toolCallId: "b", input: {} })).toBe(false);
  });
});
