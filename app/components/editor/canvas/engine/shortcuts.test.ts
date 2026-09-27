import { DOMParser } from "linkedom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiagramCommands,
  createNudgeRun,
  formatShortcut,
  matchShortcut,
  SHORTCUTS,
  shortcutHint,
  type Shortcut,
  type ShortcutId,
} from "./shortcuts";
import { SceneStore } from "./useScene";
import { createSelectionStore } from "./useSelection";

/** A fake `KeyboardEvent` — this environment (edge-runtime) has no real DOM,
 *  and `matchShortcut` only ever reads these six fields (§0 of the module's
 *  own header: matching is by physical key as well as by character). */
function keyEvent(over: {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): KeyboardEvent {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  } as KeyboardEvent;
}

/**
 * The same binding grammar `shortcuts.ts` parses internally, reconstructed
 * here from the table's own public shape (`keys`/`other`) rather than reaching
 * into the module's private `parseBinding` — this test is a spec on
 * {@link SHORTCUTS} the data, not on the parser's implementation.
 */
interface Tuple {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseSpec(spec: string): Tuple {
  const parts = spec.split("+");
  const key = (parts.pop() || "+").toLowerCase();
  const tuple: Tuple = { mod: false, ctrl: false, alt: false, shift: false, key };
  for (const part of parts) {
    if (part === "Mod") tuple.mod = true;
    else if (part === "Ctrl") tuple.ctrl = true;
    else if (part === "Alt") tuple.alt = true;
    else if (part === "Shift") tuple.shift = true;
  }
  return tuple;
}

function specsFor(shortcut: Shortcut, apple: boolean): readonly string[] {
  return apple ? shortcut.keys : (shortcut.other ?? shortcut.keys);
}

function tuplesFor(apple: boolean): Array<Tuple & { id: ShortcutId }> {
  return SHORTCUTS.flatMap((shortcut) =>
    specsFor(shortcut, apple).map((spec) => ({ ...parseSpec(spec), id: shortcut.id })),
  );
}

describe("SHORTCUTS table", () => {
  it("every ShortcutId appears exactly once", () => {
    const ids = SHORTCUTS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("no two bindings collide on Apple", () => {
    assertNoCollisions(tuplesFor(true));
  });

  it("no two bindings collide off Apple", () => {
    assertNoCollisions(tuplesFor(false));
  });
});

function assertNoCollisions(tuples: Array<Tuple & { id: ShortcutId }>): void {
  const seen = new Map<string, ShortcutId>();
  for (const t of tuples) {
    const key = `${t.mod}|${t.ctrl}|${t.alt}|${t.shift}|${t.key}`;
    const owner = seen.get(key);
    if (owner && owner !== t.id) {
      throw new Error(`binding ${key} claimed by both ${owner} and ${t.id}`);
    }
    seen.set(key, t.id);
  }
}

describe("matchShortcut", () => {
  it('Mod+] matches by code BracketRight and by key "]"', () => {
    const byKey = keyEvent({ metaKey: true, key: "]" });
    expect(matchShortcut(byKey, true)).toBe("arrange.forward");
    const byCode = keyEvent({ metaKey: true, code: "BracketRight", key: "unrelated" });
    expect(matchShortcut(byCode, true)).toBe("arrange.forward");
  });

  it("Shift+0 types a parenthesis on the page and is nobody's shortcut", () => {
    expect(matchShortcut(keyEvent({ shiftKey: true, key: ")", code: "Digit0" }), true)).toBeNull();
    expect(matchShortcut(keyEvent({ shiftKey: true, key: ")", code: "Digit0" }), false)).toBeNull();
  });

  it("existing bindings still match unchanged", () => {
    const fixture: Array<{ id: ShortcutId; spec: string }> = [
      { id: "tool.move", spec: "Alt+Shift+v" },
      { id: "edit.undo", spec: "Mod+z" },
      { id: "edit.redo", spec: "Mod+Shift+z" },
      { id: "align.left", spec: "Alt+a" },
      { id: "view.zoomIn", spec: "Mod+=" },
      { id: "edit.deselect", spec: "escape" },
      { id: "tool.hand", spec: "Alt+Shift+h" },
      { id: "tool.rect", spec: "r" },
      { id: "edit.duplicate", spec: "Mod+d" },
      { id: "move.nudge", spec: "arrowleft" },
      { id: "toggle.hidden", spec: "Mod+Shift+h" },
    ];
    for (const { id, spec } of fixture) {
      const tuple = parseSpec(spec);
      // On Apple, Mod is meta and the spare modifier (unused by any of these
      // rows) is ctrl.
      expect(
        matchShortcut(
          keyEvent({
            metaKey: tuple.mod,
            altKey: tuple.alt,
            shiftKey: tuple.shift,
            key: tuple.key,
          }),
          true,
        ),
      ).toBe(id);
      // Off Apple, Mod is ctrl — a plain row parses identically either way,
      // which is the whole point of the binding-grammar rewrite leaving these
      // rows untouched.
      expect(
        matchShortcut(
          keyEvent({
            ctrlKey: tuple.mod,
            altKey: tuple.alt,
            shiftKey: tuple.shift,
            key: tuple.key,
          }),
          false,
        ),
      ).toBe(id);
    }
  });
});

describe("flip and distribute", () => {
  it("⇧H and ⇧V flip, beside the bare letters, the tool chords and ⌘⇧H", () => {
    for (const apple of [true, false]) {
      expect(matchShortcut(keyEvent({ shiftKey: true, key: "H", code: "KeyH" }), apple)).toBe("arrange.flipH");
      expect(matchShortcut(keyEvent({ shiftKey: true, key: "V", code: "KeyV" }), apple)).toBe("arrange.flipV");
      expect(matchShortcut(keyEvent({ key: "h", code: "KeyH" }), apple)).toBe("tool.hand");
      expect(matchShortcut(keyEvent({ altKey: true, shiftKey: true, key: "Ó", code: "KeyH" }), apple)).toBe("tool.hand");
      expect(matchShortcut(keyEvent({ altKey: true, shiftKey: true, key: "◊", code: "KeyV" }), apple)).toBe("tool.move");
    }
    expect(matchShortcut(keyEvent({ metaKey: true, shiftKey: true, key: "h", code: "KeyH" }), true)).toBe("toggle.hidden");
  });

  it("distribute is ⌃⌥ on a Mac and Ctrl+Alt elsewhere, with Figma's letters", () => {
    expect(matchShortcut(keyEvent({ ctrlKey: true, altKey: true, key: "˙", code: "KeyH" }), true)).toBe("align.distributeH");
    expect(matchShortcut(keyEvent({ ctrlKey: true, altKey: true, key: "√", code: "KeyV" }), true)).toBe("align.distributeV");
    expect(matchShortcut(keyEvent({ ctrlKey: true, altKey: true, key: "h", code: "KeyH" }), false)).toBe("align.distributeH");
    expect(matchShortcut(keyEvent({ ctrlKey: true, altKey: true, key: "v", code: "KeyV" }), false)).toBe("align.distributeV");
    // ⌘⌥H is macOS's Hide Others, never ours.
    expect(matchShortcut(keyEvent({ metaKey: true, altKey: true, key: "˙", code: "KeyH" }), true)).toBeNull();
    expect(shortcutHint("align.distributeH", true)).toBe("⌃⌥H");
    expect(shortcutHint("align.distributeV", false)).toBe("Ctrl+Alt+V");
    expect(shortcutHint("arrange.flipH", true)).toBe("⇧H");
  });
});

describe("formatShortcut", () => {
  it("renders ⌘⌃F, ⌘., F11", () => {
    expect(formatShortcut("Mod+Ctrl+f", true)).toBe("⌘⌃F");
    expect(formatShortcut("Mod+.", true)).toBe("⌘.");
    expect(formatShortcut("f11", false)).toBe("F11");
  });
});

describe("shortcutHint", () => {
  it("shows a tool's chord first and its bare letter as the second binding", () => {
    expect(shortcutHint("tool.rect", true)).toBe("⌥⇧R");
    expect(shortcutHint("tool.rect", true, 1)).toBe("R");
    expect(shortcutHint("tool.rect", false)).toBe("Alt+Shift+R");
  });
});

describe("a diagram has no camera", () => {
  it("binds no zoom tool, no fit, no stage and no screen modes", () => {
    const ids: readonly string[] = SHORTCUTS.map((s) => s.id);
    for (const gone of [
      "tool.zoom",
      "view.zoomFit",
      "view.zoomSelection",
      "view.stage",
      "view.minimal",
      "view.fullscreen",
    ]) {
      expect(ids).not.toContain(gone);
    }
  });
});

// The store parses diagram HTML, and this environment has no DOM.
(globalThis as { DOMParser?: unknown }).DOMParser = DOMParser;

describe("the diagram commands", () => {
  afterEach(() => vi.useRealTimers());

  const band =
    '<nt-diagram h="200"><nt-rect id="a" x="10" y="4" w="100" h="60"></nt-rect>' +
    '<nt-rect id="b" x="300" y="40" w="100" h="60" locked></nt-rect></nt-diagram>';

  function diagram() {
    const store = new SceneStore(band, undefined, true);
    const selection = createSelectionStore(store.getScene());
    store.subscribe(() => selection.setScene(store.getScene()));
    const nudge = createNudgeRun(store, selection);
    const commands = createDiagramCommands({
      store,
      selection,
      nudge,
      band: () => ({ minX: 0, maxX: 720 }),
    });
    return { store, selection, nudge, commands };
  }
  const arrow = (key: string) => keyEvent({ key, code: key.replace("arrow", "Arrow") });
  const at = (store: SceneStore, id: string) => store.getNode(id)!;

  it("nudges a held-down arrow as one undo step", () => {
    vi.useFakeTimers();
    const { store, selection, nudge, commands } = diagram();
    selection.select(["a"]);
    commands["move.nudge"](arrow("arrowright"));
    commands["move.nudge"](arrow("arrowright"));
    commands["move.nudgeFar"](arrow("arrowdown"));
    expect([at(store, "a").x, at(store, "a").y]).toEqual([12, 14]);
    nudge.end();
    store.undo();
    expect([at(store, "a").x, at(store, "a").y]).toEqual([10, 4]);
  });

  it("holds a nudge inside the band: never above the top, never off a side", () => {
    vi.useFakeTimers();
    const { store, selection, nudge, commands } = diagram();
    selection.select(["a"]);
    commands["move.nudgeFar"](arrow("arrowup"));
    commands["move.nudgeFar"](arrow("arrowleft"));
    expect([at(store, "a").x, at(store, "a").y]).toEqual([0, 0]);
    nudge.end();
  });

  it("closes an idle run before an undo steps, so the undo takes it whole", () => {
    vi.useFakeTimers();
    const { store, selection, commands } = diagram();
    selection.select(["a"]);
    commands["move.nudge"](arrow("arrowright"));
    expect(store.gesturing()).toBe(true);
    expect(store.undo()).toBe(true);
    expect(at(store, "a").x).toBe(10);
  });

  it("writes the page's reading of a lock, not its own", () => {
    const { store, selection } = diagram();
    const commands = createDiagramCommands({
      store,
      selection,
      nudge: createNudgeRun(store, selection),
      band: () => null,
      flag: () => false,
    });
    selection.select(["b"]);
    commands["toggle.locked"](keyEvent({}));
    expect(at(store, "b").locked).toBe(false);
  });

  it("flips the selection in place, one undo step", () => {
    const { store, selection, commands } = diagram();
    selection.select(["a"]);
    expect(commands["arrange.flipV"]()).toBe(true);
    expect(store.getScene().nodes[0]).toMatchObject({ x: 10, y: 4 });
    store.undo();
    expect(commands["arrange.flipH"]()).toBe(true);
    selection.clear();
    expect(commands["arrange.flipH"]()).toBe(false);
  });

  it("distributes only over three or more", () => {
    const store = new SceneStore(
      '<nt-diagram h="200">' +
        '<nt-rect id="a" x="0" y="0" w="100" h="60"></nt-rect>' +
        '<nt-rect id="b" x="120" y="0" w="100" h="60"></nt-rect>' +
        '<nt-rect id="c" x="500" y="0" w="100" h="60"></nt-rect></nt-diagram>',
      undefined,
      true,
    );
    const selection = createSelectionStore(store.getScene());
    store.subscribe(() => selection.setScene(store.getScene()));
    const commands = createDiagramCommands({ store, selection, band: () => null });
    selection.select(["a", "b"]);
    expect(commands["align.distributeH"]()).toBe(false);
    selection.select(["a", "b", "c"]);
    expect(commands["align.distributeH"]()).toBe(true);
    expect(store.getNode("b")!.x).toBe(250);
  });

  describe("⌘D repeats the step the last copy was moved", () => {
    const setup = () => {
      const store = new SceneStore(
        '<nt-diagram h="300"><nt-rect id="a" x="0" y="0" w="100" h="60"></nt-rect></nt-diagram>',
        undefined,
        true,
      );
      const selection = createSelectionStore(store.getScene());
      store.subscribe(() => selection.setScene(store.getScene()));
      const range = { minX: 0, maxX: 720 };
      const commands = createDiagramCommands({ store, selection, band: () => range });
      const picked = () => store.getNode(selection.getSnapshot().ids[0])!;
      return { store, selection, commands, picked };
    };

    it("offsets the first copy by the plain step", () => {
      const { selection, commands, picked } = setup();
      selection.select(["a"]);
      commands["edit.duplicate"]();
      expect([picked().x, picked().y]).toEqual([10, 10]);
    });

    it("steps each further copy by however far the last one was moved", () => {
      const { store, selection, commands, picked } = setup();
      selection.select(["a"]);
      commands["edit.duplicate"]();
      store.dispatch({ type: "move", ids: [picked().id], dx: 110, dy: -10 });
      expect([picked().x, picked().y]).toEqual([120, 0]);
      commands["edit.duplicate"]();
      expect([picked().x, picked().y]).toEqual([240, 0]);
      commands["edit.duplicate"]();
      expect([picked().x, picked().y]).toEqual([360, 0]);
    });

    it("takes the band wide when the step carries a copy past the column", () => {
      const { store, selection, commands, picked } = setup();
      selection.select(["a"]);
      commands["edit.duplicate"]();
      store.dispatch({ type: "move", ids: [picked().id], dx: 390, dy: -10 });
      commands["edit.duplicate"]();
      expect([picked().x, store.getScene().wide]).toEqual([800, true]);
      store.undo();
      expect([store.getScene().nodes.length, store.getScene().wide ?? false]).toEqual([2, false]);
    });

    it("falls back to the plain step rather than repeat past the wide band's edge", () => {
      const { store, selection, commands, picked } = setup();
      selection.select(["a"]);
      commands["edit.duplicate"]();
      store.dispatch({ type: "move", ids: [picked().id], dx: 490, dy: -10 });
      commands["edit.duplicate"]();
      // 1000 would end past 960: the plain step instead, from where it stands.
      expect([picked().x, picked().y, store.getScene().wide ?? false]).toEqual([510, 10, false]);
    });

    it("steps a plain copy left off the band's right edge, never past the widest band", () => {
      const store = new SceneStore(
        '<nt-diagram h="300" wide="pinned"><nt-rect id="a" x="860" y="0" w="100" h="60"></nt-rect></nt-diagram>',
        undefined,
        true,
      );
      const selection = createSelectionStore(store.getScene());
      store.subscribe(() => selection.setScene(store.getScene()));
      const commands = createDiagramCommands({ store, selection, band: () => ({ minX: -240, maxX: 960 }) });
      selection.select(["a"]);
      commands["edit.duplicate"]();
      const copy = store.getNode(selection.getSnapshot().ids[0])!;
      expect([copy.x, copy.y]).toEqual([850, 10]);
    });

    it("keeps a plain copy by the column's side in the column", () => {
      const store = new SceneStore(
        '<nt-diagram h="300"><nt-rect id="a" x="620" y="0" w="100" h="60"></nt-rect></nt-diagram>',
        undefined,
        true,
      );
      const selection = createSelectionStore(store.getScene());
      store.subscribe(() => selection.setScene(store.getScene()));
      const commands = createDiagramCommands({ store, selection, band: () => ({ minX: 0, maxX: 720 }) });
      selection.select(["a"]);
      commands["edit.duplicate"]();
      const copy = store.getNode(selection.getSnapshot().ids[0])!;
      expect([copy.x, store.getScene().wide ?? false]).toEqual([610, false]);
    });

    it("held down by the column's side, turns off the edge rather than take the band wide", () => {
      const store = new SceneStore(
        '<nt-diagram h="300"><nt-rect id="a" x="580" y="0" w="100" h="60"></nt-rect></nt-diagram>',
        undefined,
        true,
      );
      const selection = createSelectionStore(store.getScene());
      store.subscribe(() => selection.setScene(store.getScene()));
      const commands = createDiagramCommands({ store, selection, band: () => ({ minX: 0, maxX: 720 }) });
      selection.select(["a"]);
      const xs: number[] = [];
      for (let i = 0; i < 12; i++) {
        commands["edit.duplicate"]();
        xs.push(store.getNode(selection.getSnapshot().ids[0])!.x);
      }
      expect(xs).toEqual([590, 600, 610, 620, 610, 600, 590, 580, 570, 560, 550, 540]);
      expect(store.getScene().wide ?? false).toBe(false);
    });

    it("never repeats a step past the margin the page shows", () => {
      const store = new SceneStore(
        '<nt-diagram h="300"><nt-rect id="a" x="0" y="0" w="100" h="60"></nt-rect></nt-diagram>',
        undefined,
        true,
      );
      const selection = createSelectionStore(store.getScene());
      store.subscribe(() => selection.setScene(store.getScene()));
      const commands = createDiagramCommands({ store, selection, band: () => ({ minX: 0, maxX: 720 }), wideMargin: () => 100 });
      selection.select(["a"]);
      commands["edit.duplicate"]();
      store.dispatch({ type: "move", ids: [selection.getSnapshot().ids[0]], dx: 390, dy: -10 });
      commands["edit.duplicate"]();
      // 800…900 is past 720 + 100: the plain step, from where the copy stands.
      const copy = store.getNode(selection.getSnapshot().ids[0])!;
      expect([copy.x, copy.y, store.getScene().wide ?? false]).toEqual([410, 10, false]);
    });

    it("goes back to the plain step once the selection is something else", () => {
      const { store, selection, commands, picked } = setup();
      selection.select(["a"]);
      commands["edit.duplicate"]();
      store.dispatch({ type: "move", ids: [picked().id], dx: 110, dy: -10 });
      selection.select(["a"]);
      commands["edit.duplicate"]();
      expect([picked().x, picked().y]).toEqual([10, 10]);
    });
  });

  it("declines an arrow with no nudge run to carry it — a palette's command set", () => {
    const store = new SceneStore(band, undefined, true);
    const selection = createSelectionStore(store.getScene());
    const commands = createDiagramCommands({ store, selection, band: () => null });
    selection.select(["a"]);
    expect(commands["move.nudge"](arrow("arrowright"))).toBe(false);
  });

  it("hands the tool keys to no one when it has no tool of its own", () => {
    const { commands } = diagram();
    expect(commands["tool.rect"](keyEvent({ key: "r" }))).toBe(false);
  });
});
