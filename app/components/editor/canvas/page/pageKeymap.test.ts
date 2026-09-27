import { describe, expect, it } from "vitest";
import { toolKeyAllowed } from "../engine/shortcuts";
import { climbSelectAll, escapeStep, type SelectAllLadder } from "./pageKeymap";

const at = (over: Partial<Parameters<typeof escapeStep>[0]> = {}) => ({
  field: false,
  page: false,
  tool: "move" as const,
  locked: false,
  entered: false,
  shapes: false,
  bandFocused: false,
  ...over,
});

describe("the Escape ladder", () => {
  it("leaves a field's Escape to the field", () => {
    expect(escapeStep(at({ field: true, tool: "rect", shapes: true }))).toBe("pass");
  });

  it("puts a tool in hand down first — from the page's text too", () => {
    expect(escapeStep(at({ tool: "rect", shapes: true, entered: true }))).toBe("tool");
    expect(escapeStep(at({ tool: "pen", page: true }))).toBe("tool");
  });

  it("lets a lock go, even on a tool the bar shows as Move", () => {
    expect(escapeStep(at({ locked: true }))).toBe("tool");
  });

  it("is the text's own below that", () => {
    expect(escapeStep(at({ page: true, shapes: true }))).toBe("pass");
  });

  it("steps out of a group before letting the selection go", () => {
    expect(escapeStep(at({ entered: true, shapes: true }))).toBe("out");
    expect(escapeStep(at({ shapes: true }))).toBe("clear");
  });

  it("selects the diagram as a block once nothing in it is held", () => {
    expect(escapeStep(at({ bandFocused: true }))).toBe("block");
  });

  it("and gives the key back when there is no diagram to climb out of", () => {
    expect(escapeStep(at())).toBe("pass");
  });
});

function ladder(start: { entered: boolean; inGroup: boolean[]; atTop: boolean[] }) {
  const calls: string[] = [];
  let entered = start.entered;
  const inGroup = [...start.inGroup];
  const atTop = [...start.atTop];
  const steps: SelectAllLadder = {
    entered,
    selectAll: () => {
      const changed = (entered ? inGroup : atTop).shift() ?? false;
      calls.push(`${entered ? "group" : "top"}:${changed}`);
      return changed;
    },
    toTop: () => {
      entered = false;
      calls.push("toTop");
    },
    clearAll: () => void calls.push("clearAll"),
    selectBlocks: () => void calls.push("blocks"),
  };
  return { steps, calls };
}

describe("the ⌘A ladder", () => {
  it("takes the entered group's shapes first", () => {
    const { steps, calls } = ladder({ entered: true, inGroup: [true], atTop: [] });
    expect(climbSelectAll(steps)).toBe("diagram");
    expect(calls).toEqual(["group:true"]);
  });

  it("then the whole diagram, out of the group", () => {
    const { steps, calls } = ladder({ entered: true, inGroup: [false], atTop: [true] });
    expect(climbSelectAll(steps)).toBe("diagram");
    expect(calls).toEqual(["group:false", "toTop", "top:true"]);
  });

  it("then the page, as blocks, with the shapes let go", () => {
    const { steps, calls } = ladder({ entered: false, inGroup: [], atTop: [false] });
    expect(climbSelectAll(steps)).toBe("blocks");
    expect(calls).toEqual(["top:false", "clearAll", "blocks"]);
  });
});

describe("the tool keys (F1)", () => {
  const key = (over: Partial<Parameters<typeof toolKeyAllowed>[0]>) =>
    toolKeyAllowed({ chord: false, field: false, page: false, shapes: false, ...over });

  it("answer to ⌥⇧ and a letter from anywhere, the page's text included", () => {
    expect(key({ chord: true })).toBe(true);
    expect(key({ chord: true, page: true })).toBe(true);
  });

  it("answer to the bare letter only over shapes in hand, with no caret in the page", () => {
    expect(key({ shapes: true })).toBe(true);
    expect(key({})).toBe(false);
    expect(key({ shapes: true, page: true })).toBe(false);
  });

  it("never while a field has the caret", () => {
    expect(key({ chord: true, field: true })).toBe(false);
  });
});
