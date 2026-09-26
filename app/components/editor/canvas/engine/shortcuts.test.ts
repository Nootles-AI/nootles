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

  it("hands the tool keys to no one when it has no tool of its own", () => {
    const { commands } = diagram();
    expect(commands["tool.rect"](keyEvent({ key: "r" }))).toBe(false);
  });
});
