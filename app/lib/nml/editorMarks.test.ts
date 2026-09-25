import { describe, expect, test } from "vitest";
import { editorMarks } from "./normalize";

describe("editorMarks", () => {
  test("code keeps only itself: bold code is code", () => {
    expect(editorMarks(["bold", "code"], false)).toEqual(["code"]);
    expect(editorMarks(["code", "italic", "strike", "underline"], false)).toEqual(["code"]);
  });

  test("inside a link, code gives way and the rest stays", () => {
    expect(editorMarks(["code"], true)).toEqual([]);
    expect(editorMarks(["bold", "code"], true)).toEqual(["bold"]);
  });

  test("marks that combine are left as they are", () => {
    expect(editorMarks(["bold", "italic"], false)).toEqual(["bold", "italic"]);
    expect(editorMarks(["underline"], true)).toEqual(["underline"]);
    expect(editorMarks([], false)).toEqual([]);
  });
});
