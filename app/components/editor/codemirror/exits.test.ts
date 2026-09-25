import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { codeExit } from "./exits";

const code = "const a = 1;\nconst b = 2;\nconst c = 3;";

function at(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: { anchor, head } });
}

describe("codeExit", () => {
  it("leaves upward from anywhere on the first line", () => {
    expect(codeExit("ArrowUp", at(code, 0))).toBe("previous");
    expect(codeExit("ArrowUp", at(code, 7))).toBe("previous");
    expect(codeExit("ArrowUp", at(code, 14))).toBeNull();
  });

  it("leaves downward from anywhere on the last line", () => {
    expect(codeExit("ArrowDown", at(code, code.length))).toBe("next");
    expect(codeExit("ArrowDown", at(code, code.length - 5))).toBe("next");
    expect(codeExit("ArrowDown", at(code, 14))).toBeNull();
  });

  it("leaves sideways only from the very start or the very end", () => {
    expect(codeExit("ArrowLeft", at(code, 0))).toBe("previous");
    expect(codeExit("ArrowLeft", at(code, 1))).toBeNull();
    expect(codeExit("ArrowRight", at(code, code.length))).toBe("next");
    expect(codeExit("ArrowRight", at(code, code.length - 1))).toBeNull();
  });

  it("lets a selection that spans characters collapse first", () => {
    expect(codeExit("ArrowLeft", at(code, 0, 4))).toBeNull();
    expect(codeExit("ArrowUp", at(code, 0, 4))).toBeNull();
    expect(codeExit("ArrowRight", at(code, code.length - 3, code.length))).toBeNull();
  });

  it("never treats several carets as an edge", () => {
    const state = EditorState.create({
      doc: code,
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(20),
      ]),
      extensions: EditorState.allowMultipleSelections.of(true),
    });
    expect(codeExit("ArrowUp", state)).toBeNull();
  });

  it("takes both vertical exits in a one-line block", () => {
    expect(codeExit("ArrowUp", at("x", 1))).toBe("previous");
    expect(codeExit("ArrowDown", at("x", 0))).toBe("next");
  });

  it("selects the block on Escape, wherever the caret is", () => {
    expect(codeExit("Escape", at(code, 14))).toBe("select");
    expect(codeExit("Escape", at(code, 0, 5))).toBe("select");
  });

  it("gives an empty block back as text on Backspace, and only an empty one", () => {
    expect(codeExit("Backspace", at("", 0))).toBe("unwrap");
    expect(codeExit("Backspace", at("x", 0))).toBeNull();
    expect(codeExit("Backspace", at("\n", 1))).toBeNull();
  });
});
