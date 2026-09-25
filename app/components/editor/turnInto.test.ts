import { describe, expect, it } from "vitest";
import {
  TURN_INTO,
  canTurnInto,
  isCurrentType,
  plainText,
  turnIntoUpdate,
} from "./turnInto";

const target = (key: string) => TURN_INTO.find((t) => t.key === key)!;

describe("turnIntoUpdate", () => {
  it("changes only the type and its props between blocks of writing", () => {
    const block = { type: "paragraph", props: {}, content: [{ type: "text", text: "Hi" }] };
    expect(turnIntoUpdate(block, target("h2"))).toEqual({ type: "heading", props: { level: 2 } });
    expect(turnIntoUpdate(block, target("todo"))).toEqual({ type: "checkListItem", props: {} });
  });

  it("carries the words into a code block, which keeps them in a prop", () => {
    const block = {
      type: "heading",
      props: { level: 1 },
      content: [
        { type: "text", text: "Read " },
        { type: "link", content: [{ type: "text", text: "the docs" }] },
        { type: "pageMention" },
      ],
    };
    expect(turnIntoUpdate(block, target("code"))).toEqual({
      type: "codeBlock",
      props: { code: "Read the docs" },
    });
  });

  it("carries code back out as the block's words", () => {
    const block = { type: "codeBlock", props: { code: "a\nb", language: "ts" } };
    expect(turnIntoUpdate(block, target("text"))).toEqual({
      type: "paragraph",
      props: {},
      content: "a\nb",
    });
  });

  it("leaves a code block's code alone when it is turned into code", () => {
    const block = { type: "codeBlock", props: { code: "x" } };
    expect(turnIntoUpdate(block, target("code"))).toEqual({ type: "codeBlock", props: {} });
  });
});

describe("the menu's reading of a block", () => {
  it("offers Turn into only on blocks that hold writing", () => {
    expect(canTurnInto({ type: "toggleListItem", props: {} })).toBe(true);
    expect(canTurnInto({ type: "codeBlock", props: {} })).toBe(true);
    expect(canTurnInto({ type: "canvas", props: {} })).toBe(false);
    expect(canTurnInto({ type: "table", props: {} })).toBe(false);
  });

  it("marks the heading of the level the block already is", () => {
    const h2 = { type: "heading", props: { level: 2 } };
    expect(isCurrentType(h2, target("h2"))).toBe(true);
    expect(isCurrentType(h2, target("h1"))).toBe(false);
    expect(isCurrentType(h2, target("text"))).toBe(false);
  });

  it("reads plain text through links and past what has no spelling", () => {
    expect(plainText("already plain")).toBe("already plain");
    expect(plainText(undefined)).toBe("");
  });
});
