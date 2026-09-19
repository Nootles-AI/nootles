import { describe, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { ReviewSession, type TurnReview } from "./session";

const PAGE = "page" as Id<"pages">;

function turn(): TurnReview {
  return {
    threadId: "thread" as Id<"chatThreads">,
    projectId: "project" as Id<"projects">,
    chatPromptId: "prompt",
    status: "pending",
    pages: [
      {
        pageId: PAGE,
        checkpointId: "checkpoint" as Id<"checkpoints">,
        ops: [],
        trace: [],
        hunks: [
          {
            id: "hunk",
            kind: "update",
            added: [],
            removed: [],
            changed: [],
            moved: [],
            opIndices: [],
          },
        ],
        // Older and interrupted rows can omit an explicit pending entry. The
        // UI has always drawn that shape as pending, so answering must agree.
        status: {},
        replacing: [],
        before: [],
      },
    ],
  };
}

function fixture() {
  const mutation = vi.fn(async () => null);
  const session = new ReviewSession({
    convex: { mutation, query: vi.fn(async () => null) } as never,
    openPage: vi.fn(),
    editorFor: vi.fn(async () => {
      throw new Error("the legacy answer path does not need an editor");
    }),
  });
  (session as unknown as { turns: TurnReview[] }).turns = [turn()];
  return { session, mutation };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("review answers", () => {
  it("answers a visible hunk whose stored pending status is absent", async () => {
    const { session, mutation } = fixture();

    await session.acceptAll();

    expect(session.getSnapshot()[0].pages[0].status.hunk).toBe("accepted");
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("reports an answer immediately while durable work is queued and ignores a duplicate click", async () => {
    const { session, mutation } = fixture();
    const gate = deferred();
    (session as unknown as { queue: Promise<unknown> }).queue = gate.promise;

    const updates: Array<string | null> = [];
    session.subscribe(() => updates.push(session.answeringAs("hunk")));

    const first = session.accept("hunk");
    const duplicate = session.accept("hunk");

    expect(session.answeringAs("hunk")).toBe("accepted");
    expect(mutation).not.toHaveBeenCalled();

    gate.release();
    await Promise.all([first, duplicate]);

    expect(session.answeringAs("hunk")).toBeNull();
    expect(session.getSnapshot()[0].pages[0].status.hunk).toBe("accepted");
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(updates).toContain("accepted");
    expect(updates.at(-1)).toBeNull();
  });
});
