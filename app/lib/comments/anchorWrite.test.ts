import { describe, expect, it } from "vitest";
import { persistable } from "./anchorWrite";

describe("persistable", () => {
  const anchor = { blockId: "p_1", exact: "by Friday", prefix: "ship it ", suffix: " if", offsetHint: 8 };

  it("stamps an orphan with the given time and clears one with null", () => {
    expect(persistable({ orphaned: true }, 42)).toEqual({ orphanedAt: 42 });
    expect(persistable({ orphaned: false }, 42)).toEqual({ orphanedAt: null });
  });

  it("carries the anchor and the ambiguity flag through unchanged", () => {
    expect(persistable({ anchor, ambiguous: true }, 42)).toEqual({ anchor, ambiguous: true });
  });

  it("turns no writes into an empty write", () => {
    expect(persistable({}, 42)).toEqual({});
  });
});
