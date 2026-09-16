import { describe, expect, it } from "vitest";
import {
  formatShortcut,
  matchShortcut,
  SHORTCUTS,
  shortcutHint,
  type Shortcut,
  type ShortcutId,
} from "./shortcuts";

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
  it("Mod+Ctrl+f matches meta+ctrl+KeyF on Apple and nothing off Apple", () => {
    const e = keyEvent({ metaKey: true, ctrlKey: true, code: "KeyF", key: "f" });
    expect(matchShortcut(e, true)).toBe("view.fullscreen");
    expect(matchShortcut(e, false)).toBeNull();
  });

  it("f11 matches on other platforms only", () => {
    const e = keyEvent({ key: "F11" });
    expect(matchShortcut(e, false)).toBe("view.fullscreen");
    expect(matchShortcut(e, true)).toBeNull();
  });

  it('Mod+. matches by code Period and by key "."', () => {
    const byKey = keyEvent({ metaKey: true, key: "." });
    expect(matchShortcut(byKey, true)).toBe("view.minimal");
    const byCode = keyEvent({ metaKey: true, code: "Period", key: "unrelated" });
    expect(matchShortcut(byCode, true)).toBe("view.minimal");
  });

  it("existing bindings still match unchanged", () => {
    const fixture: Array<{ id: ShortcutId; spec: string }> = [
      { id: "tool.move", spec: "v" },
      { id: "edit.undo", spec: "Mod+z" },
      { id: "edit.redo", spec: "Mod+Shift+z" },
      { id: "align.left", spec: "Alt+a" },
      { id: "view.zoomFit", spec: "Shift+1" },
      { id: "edit.deselect", spec: "escape" },
      { id: "tool.hand", spec: "h" },
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
  it('shortcutHint("view.fullscreen", false) === "F11"', () => {
    expect(shortcutHint("view.fullscreen", false)).toBe("F11");
  });

  it('shortcutHint("view.fullscreen", true) resolves the Apple chord', () => {
    expect(shortcutHint("view.fullscreen", true)).toBe("⌘⌃F");
  });
});
