import { DOMParser } from "linkedom";
import { describe, expect, it } from "vitest";
import { createNudgeRun } from "../engine/shortcuts";
import { SceneStore } from "../engine/useScene";
import { createSelectionStore } from "../engine/useSelection";
import type { CanvasApi } from "../render/CanvasSurface";
import { isBoolean } from "../scene/types";
import { commandApplies, commandsFor, PALETTE_COMMANDS, runAcross } from "./pageCommands";
import { createPageCanvas, type DiagramEntry } from "./PageCanvas";

// The store parses diagram HTML, and this environment has no DOM.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

const rect = (id: string, x: number, y = 20) =>
  `<nt-rect id="${id}" x="${x}" y="${y}" w="100" h="60"></nt-rect>`;

function diagram(blockId: string, shapes: string) {
  const store = new SceneStore(`<nt-diagram h="300">${shapes}</nt-diagram>`, undefined, true);
  const selection = createSelectionStore(store.getScene());
  store.subscribe(() => selection.setScene(store.getScene()));
  const entry: DiagramEntry = {
    blockId,
    api: {
      store,
      selection,
      ownSelection: selection,
      band: { current: null },
      openPath: () => {},
      openLabel: () => {},
    } as unknown as CanvasApi,
    readOnly: false,
    flushMirror: () => {},
    remove: () => {},
    blocks: {} as DiagramEntry["blocks"],
  };
  return { store, selection, entry };
}

function page(...diagrams: ReturnType<typeof diagram>[]) {
  const steps = { n: 0 };
  let depth = 0;
  const canvas = createPageCanvas({
    pane: "main",
    pageId: "p",
    tools: null,
    batch: (fn) => {
      if (depth === 0) steps.n++;
      depth++;
      try {
        return fn();
      } finally {
        depth--;
      }
    },
  });
  for (const d of diagrams) canvas.register(d.entry);
  return { canvas, steps };
}

const offered = (canvas: ReturnType<typeof page>["canvas"]) =>
  PALETTE_COMMANDS.filter(({ id }) => commandApplies(canvas, id)).map(({ id }) => id);

describe("what the palette offers over the page's selection", () => {
  it("nothing, with nothing selected", () => {
    const a = diagram("a", rect("r1", 0));
    const { canvas } = page(a);
    expect(offered(canvas)).toEqual([]);
  });

  it("one shape aligns and flips; it takes two for a boolean, three to distribute", () => {
    const a = diagram("a", rect("r1", 0) + rect("r2", 200) + rect("r3", 500));
    const { canvas } = page(a);
    a.selection.select(["r1"]);
    expect(offered(canvas)).not.toContain("edit.union");
    expect(offered(canvas)).not.toContain("align.distributeH");
    expect(offered(canvas)).toContain("align.left");
    expect(offered(canvas)).toContain("arrange.flipH");
    a.selection.select(["r1", "r2"]);
    expect(offered(canvas)).toContain("edit.union");
    expect(offered(canvas)).not.toContain("align.distributeV");
    a.selection.select(["r1", "r2", "r3"]);
    expect(offered(canvas)).toEqual(PALETTE_COMMANDS.map(({ id }) => id));
  });

  it("across diagrams: no boolean, and spacing only along the shared x", () => {
    const a = diagram("a", rect("r1", 0) + rect("r2", 200));
    const b = diagram("b", rect("r3", 500));
    const { canvas } = page(a, b);
    canvas.selection.selectIn("a", ["r1", "r2"]);
    canvas.selection.selectIn("b", ["r3"], { keep: true });
    const ids = offered(canvas);
    expect(ids).not.toContain("edit.union");
    expect(ids).toContain("align.distributeH");
    expect(ids).not.toContain("align.distributeV");
  });
});

describe("running a command over the page's selection", () => {
  it("flips what is selected, as one step", () => {
    const a = diagram("a", rect("r1", 0) + rect("r2", 300));
    const { canvas, steps } = page(a);
    a.selection.select(["r1", "r2"]);
    steps.n = 0;
    expect(runAcross(canvas, "arrange.flipH")).toBe(true);
    expect(a.store.getNode("r1")!.x).toBe(300);
    expect(a.store.getNode("r2")!.x).toBe(0);
    expect(steps.n).toBe(1);
  });

  it("unions two shapes and selects the result", () => {
    const a = diagram("a", rect("r1", 0) + rect("r2", 50));
    const { canvas } = page(a);
    a.selection.select(["r1", "r2"]);
    runAcross(canvas, "edit.union");
    const [id] = a.selection.getSnapshot().ids;
    const node = a.store.getNode(id)!;
    expect(isBoolean(node) && node.op).toBe("union");
  });

  it("distributes horizontally across diagrams, in one step", () => {
    const a = diagram("a", rect("r1", 0) + rect("r2", 150));
    const b = diagram("b", rect("r3", 500));
    const { canvas, steps } = page(a, b);
    canvas.selection.selectIn("a", ["r1", "r2"]);
    canvas.selection.selectIn("b", ["r3"], { keep: true });
    steps.n = 0;
    expect(runAcross(canvas, "align.distributeH")).toBe(true);
    expect(a.store.getNode("r2")!.x).toBe(250);
    expect(a.store.getNode("r1")!.x).toBe(0);
    expect(b.store.getNode("r3")!.x).toBe(500);
    expect(steps.n).toBe(1);
    expect(runAcross(canvas, "align.distributeV")).toBe(false);
  });

  it("nudges shapes in two diagrams together, as far as the tightest band lets them", () => {
    const a = diagram("a", rect("r1", 2));
    const b = diagram("b", rect("r2", 300));
    const { canvas } = page(a, b);
    canvas.selection.selectIn("a", ["r1"]);
    canvas.selection.selectIn("b", ["r2"], { keep: true });
    const left = { key: "ArrowLeft", code: "ArrowLeft", shiftKey: true } as KeyboardEvent;
    const runs = [a, b].map((d) => createNudgeRun(d.store, d.selection));
    const commands = (target: Parameters<typeof commandsFor>[0], shared: Parameters<typeof commandsFor>[1]) =>
      commandsFor(target, { nudge: () => runs[target.blockId === "a" ? 0 : 1], ...shared });
    expect(runAcross(canvas, "move.nudgeFar", left, { commands })).toBe(true);
    expect(a.store.getNode("r1")!.x).toBe(0);
    expect(b.store.getNode("r2")!.x).toBe(298);
    runs.forEach((run) => run.dispose());
  });

  it("aligns each diagram's selection, as the keys do", () => {
    const a = diagram("a", rect("r1", 40) + rect("r2", 300));
    const { canvas } = page(a);
    a.selection.select(["r1", "r2"]);
    runAcross(canvas, "align.left");
    expect(a.store.getNode("r2")!.x).toBe(40);
  });
});
