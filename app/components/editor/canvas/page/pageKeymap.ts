import { effectiveScale } from "@/app/lib/columnScale";
import {
  isCanvasHtml,
  landFragment,
  lastCopy,
  pageClipboardHtml,
  rememberCopy,
  type ClipboardPart,
} from "../engine/clipboard";
import {
  createDiagramCommands,
  createNudgeRun,
  DUPLICATE_OFFSET,
  isApplePlatform,
  matchShortcut,
  nudgeDelta,
  pasteLevel,
  toolKeyAllowed,
  type CanvasTool,
  type NudgeRun,
  type ShortcutId,
} from "../engine/shortcuts";
import { bandLeft, bandWidth } from "../scene/band";
import { parseScene } from "../scene/parse";
import { topSelection } from "../scene/types";
import { registerPaneDiagrams } from "./diagramKeys";
import type { DiagramEntry, DiagramTarget, PageCanvas } from "./PageCanvas";

/**
 * The page's keymap: one listener per pane, speaking for every diagram on it.
 *
 * It listens on the pane in the capture phase. That puts it behind everything
 * on the window and the document — the pen, a connector or page draw in
 * progress, the block marquee, a colour pick, the spine's ⌘Z, the zoom keys —
 * whatever order they registered in, and ahead of ProseMirror and of a label
 * being edited, so it has to step aside for text entry itself.
 *
 * Its keys are the diagram keymap's, with the page's meaning: an edit acts on
 * every diagram holding part of the selection, as one undo step; Enter and
 * Tab act on the diagram the page is focused on. Escape and ⌘A climb out of a
 * diagram and onto the page a step at a time (see {@link escapeStep} and
 * {@link climbSelectAll}).
 */

/** The ProseMirror root: the caret is in the page's text. */
export function isPageText(el: Element | null): boolean {
  return el instanceof HTMLElement && el.classList.contains("ProseMirror");
}

/** A field with a caret of its own — a label, an input, a comment, a code block. */
export function isField(el: Element | null): boolean {
  if (!(el instanceof HTMLElement) || isPageText(el)) return false;
  const tag = el.tagName;
  return (
    el.isContentEditable ||
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    tag === "MATH-FIELD"
  );
}

export type EscapeStep =
  /** Not the page's key: a field's, the text's, or whoever is around the page. */
  | "pass"
  /** Back on Move, the lock let go. */
  | "tool"
  /** Out of the entered group, onto it. */
  | "out"
  /** The page's selection let go. */
  | "clear"
  /** The diagram itself, as a block of the page. */
  | "block";

/**
 * Where Escape goes: a tool in hand is put down first — even with the caret in
 * the text, where nothing else of the canvas's is heard — then out of a group,
 * then the selection let go, and last the diagram itself selected as a block,
 * from which the page's own keys take over.
 */
export function escapeStep(key: {
  field: boolean;
  page: boolean;
  tool: CanvasTool;
  locked: boolean;
  entered: boolean;
  shapes: boolean;
  bandFocused: boolean;
}): EscapeStep {
  if (key.field) return "pass";
  if (key.tool !== "move" || key.locked) return "tool";
  if (key.page) return "pass";
  if (key.entered) return "out";
  if (key.shapes) return "clear";
  if (key.bandFocused) return "block";
  return "pass";
}

/** What ⌘A can do to the diagram it is pressed over. */
export interface SelectAllLadder {
  entered: boolean;
  /** Everything at the current level; false when that was the selection already. */
  selectAll(): boolean;
  /** Out of every entered group. */
  toTop(): void;
  clearAll(): void;
  /** Every block on the page. */
  selectBlocks(): void;
}

/**
 * ⌘A, pressed again and again: the entered group's shapes, then the whole
 * diagram, then the whole page as blocks — each press taking the next rung
 * only once the one below it is already held.
 */
export function climbSelectAll(ladder: SelectAllLadder): "diagram" | "blocks" {
  if (ladder.entered) {
    if (ladder.selectAll()) return "diagram";
    ladder.toTop();
  }
  if (ladder.selectAll()) return "diagram";
  ladder.clearAll();
  ladder.selectBlocks();
  return "blocks";
}

/** The keys that speak to the one diagram the page is focused on, never to all. */
const FOCUSED_ONLY: ReadonlySet<ShortcutId> = new Set([
  "edit.vector",
  "select.parent",
  "select.next",
  "select.previous",
]);

const DEEPEST = 64;

/** Every unlocked, visible top-level shape, frontmost last. */
const pickable = (entry: DiagramEntry) =>
  entry.api.store.getScene().nodes.filter((node) => !node.hidden && !node.locked);

export function attachPageKeymap(canvas: PageCanvas, pane: HTMLElement): () => void {
  const tools = canvas.tools;
  if (!tools) return () => {};
  const apple = isApplePlatform();
  /** Set by the ⌘⇧V keydown and consumed by the paste event it produces. */
  let pasteInPlace = false;
  /** Pastes of one copy back over its originals so far — each lands a step further out. */
  let repeats: { copy: ReturnType<typeof lastCopy>; blockId: string; n: number } | null = null;
  /** One run per diagram being nudged, ended together as one undo step. */
  const runs = new Map<string, NudgeRun>();

  const bandOf = (el: Element | null): DiagramEntry | null =>
    el ? (canvas.entries().find((entry) => entry.api.band.current?.contains(el)) ?? null) : null;
  const focusedEntry = (): DiagramEntry | null => {
    const id = canvas.selection.getSnapshot().focused;
    return id ? (canvas.get(id) ?? null) : null;
  };
  const writable = () => canvas.targets().filter((target) => !target.entry.readOnly);

  const endNudges = () => {
    if (runs.size === 0) return;
    const ending = [...runs.values()];
    runs.clear();
    canvas.batch(() => ending.forEach((run) => run.end()));
    ending.forEach((run) => run.dispose());
  };
  const runFor = (target: DiagramTarget) => {
    let run = runs.get(target.blockId);
    if (!run) {
      run = createNudgeRun(target.store, target.selection, endNudges);
      runs.set(target.blockId, run);
    }
    return run;
  };

  /** ⌘⇧H and ⌘⇧L read over the whole page's selection, before any of it changes. */
  const flagValue = (flag: "locked" | "hidden") =>
    !writable().every((target) =>
      topSelection(target.store.getScene(), target.selection.getSnapshot().ids).every((node) => node[flag]),
    );

  const commandsFor = (target: DiagramTarget, flag?: boolean) =>
    createDiagramCommands({
      store: target.store,
      selection: target.selection,
      get nudge() {
        return runFor(target);
      },
      band: () => {
        const scene = target.store.getScene();
        const minX = bandLeft(scene);
        return { minX, maxX: minX + bandWidth(scene) };
      },
      pathEdit: { set: target.entry.api.openPath },
      labelEdit: { open: target.entry.api.openLabel },
      flag: flag === undefined ? undefined : () => flag,
    });

  const escape = (page: boolean, band: DiagramEntry | null, shapes: boolean): boolean => {
    const diagram = band ?? focusedEntry();
    const step = escapeStep({
      field: false,
      page,
      tool: tools.get(),
      locked: tools.locked(),
      entered: !!diagram && diagram.api.ownSelection.getSnapshot().enteredPath.length > 0,
      shapes,
      bandFocused: band !== null,
    });
    switch (step) {
      case "tool":
        tools.set("move");
        return true;
      case "out":
        diagram!.api.selection.escape();
        return true;
      case "clear":
        canvas.selection.clearAll();
        return true;
      case "block":
        // A copy of the block reads its prop, which trails the diagram.
        band!.flushMirror();
        band!.blocks.select([band!.blockId]);
        return true;
      case "pass":
        return false;
    }
  };

  const selectAll = (diagram: DiagramEntry) => {
    const raw = diagram.api.ownSelection;
    canvas.batch(() =>
      climbSelectAll({
        entered: raw.getSnapshot().enteredPath.length > 0,
        selectAll: () => diagram.api.selection.selectAll(),
        toTop: () => {
          for (let i = 0; i < DEEPEST && raw.getSnapshot().enteredPath.length > 0; i++) raw.escape();
        },
        clearAll: () => canvas.selection.clearAll(),
        selectBlocks: () => diagram.blocks.selectAll(),
      }),
    );
  };

  /** A diagram edit, once per diagram holding part of the selection. */
  const acrossDiagrams = (id: ShortcutId, e: KeyboardEvent): boolean => {
    const targets = writable();
    if (FOCUSED_ONLY.has(id)) {
      const focused = canvas.selection.getSnapshot().focused;
      const target = targets.find((t) => t.blockId === focused) ?? targets[0];
      return !!target && canvas.batch(() => commandsFor(target)[id](e));
    }
    const flag =
      id === "toggle.hidden" ? flagValue("hidden") : id === "toggle.locked" ? flagValue("locked") : undefined;
    const focused = canvas.selection.getSnapshot().focused;
    let handled = id === "toggle.hidden";
    canvas.selection.keep(() =>
      canvas.batch(() => {
        for (const target of targets) if (commandsFor(target, flag)[id](e)) handled = true;
      }),
    );
    // Each diagram's own change moved the page's focus onto it.
    if (focused && canvas.selection.getSnapshot().parts.has(focused)) canvas.selection.focus(focused);
    return handled;
  };

  const decide = (id: ShortcutId, e: KeyboardEvent): boolean => {
    const active = document.activeElement;
    if (isField(active)) return false;
    const page = isPageText(active);
    const band = page ? null : bandOf(active);
    const shapes = canvas.selection.getSnapshot().parts.size > 0;

    if (id.startsWith("tool.")) {
      // A held shot has its own tools and keys; the page's are not in play.
      if (canvas.framed()) return false;
      if (!toolKeyAllowed({ chord: e.altKey && e.shiftKey, field: false, page, shapes })) return false;
      const tool = id.slice(5) as CanvasTool;
      // A text is written into a diagram, never onto the page.
      if (tool === "text" && !(band ?? focusedEntry())) return false;
      tools.set(tool);
      return true;
    }
    if (id === "edit.deselect") return escape(page, band, shapes);
    if (id === "edit.selectAll") {
      if (page && !shapes) return false;
      const diagram = band ?? focusedEntry();
      if (!diagram) return false;
      selectAll(diagram);
      return true;
    }
    if (page) return false;
    if (id === "edit.undo" || id === "edit.redo") {
      // Outside a workspace's history, which answers these on the document.
      const diagram = band ?? focusedEntry();
      if (!diagram) return false;
      if (id === "edit.undo") diagram.api.store.undo();
      else diagram.api.store.redo();
      return true;
    }
    // An empty band lets the arrows, ⌫ and Enter go on to the page. ⌘⇧H is
    // always spent: it is the browser's Home.
    if (!shapes) return id === "toggle.hidden" && band !== null;
    return acrossDiagrams(id, e);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return;
    const target = e.target;
    // A storyboard's shots keep a keymap of their own.
    if (target instanceof Element && target.closest(".nt-canvas-shot, .nt-sb-full")) return;
    // A gesture in hand owns the keys; its Escape was heard before this.
    if (canvas.pressing()) return;
    const id = matchShortcut(e, apple);
    if (!id) return;
    if (id === "edit.paste" || id === "edit.pasteInPlace") {
      pasteInPlace = id === "edit.pasteInPlace";
      return;
    }
    // Anything but another nudge closes an open run first — so an unrelated
    // edit is never folded into it.
    if (id !== "move.nudge" && id !== "move.nudgeFar") endNudges();
    if (!decide(id, e)) return;
    e.preventDefault();
    e.stopPropagation();
  };

  const onKeyUp = (e: KeyboardEvent) => {
    if (nudgeDelta(e)) endNudges();
  };

  // A caret put into text on the page lets the diagrams' selection go: the
  // keys are the text's now, and shapes held under them would look as if
  // they were not.
  const onFocusIn = (e: FocusEvent) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!(isField(el) || isPageText(el)) || bandOf(el)) return;
    if (canvas.selection.getSnapshot().parts.size > 0) canvas.selection.clearAll();
  };

  // Shapes selected let a block selection go, without taking the keyboard
  // from the band that has it.
  const offSelection = canvas.selection.subscribe(() => {
    if (canvas.selection.getSnapshot().parts.size === 0) return;
    const blocks = canvas.entries()[0]?.blocks;
    if (blocks?.getSnapshot().ids.length) blocks.clear({ focus: false });
  });

  /**
   * The clipboard is heard on the document, ahead of the editor: the browser
   * aims copy at whatever holds the DOM selection, which is not always the
   * focused element, and ProseMirror would take a paste aimed at a band.
   */
  const clipboardBand = () => {
    const el = document.activeElement;
    return el && pane.contains(el) && !isField(el) ? bandOf(el) : null;
  };

  const onCopy = (e: ClipboardEvent) => {
    if (!clipboardBand()) return;
    const held = canvas.targets().filter((t) => t.selection.getSnapshot().ids.length > 0);
    const tops = held.map((t) => {
      const band = t.entry.api.band.current;
      return band ? { top: band.getBoundingClientRect().top, scale: effectiveScale(band) } : { top: 0, scale: 1 };
    });
    const first = Math.min(...tops.map((t) => t.top));
    const parts: ClipboardPart[] = held.map((t, i) => ({
      scene: t.store.getScene(),
      ids: t.selection.getSnapshot().ids,
      dy: Math.round((tops[i].top - first) / tops[i].scale),
    }));
    const html = pageClipboardHtml(parts);
    if (!html) return;
    rememberCopy(html, held.map((t) => t.blockId));
    e.clipboardData?.setData("text/plain", html);
    e.preventDefault();
    e.stopPropagation();
  };

  const onCut = (e: ClipboardEvent) => {
    if (!clipboardBand()) return;
    const cutting = writable().map((t) => ({
      store: t.store,
      ids: topSelection(t.store.getScene(), t.selection.getSnapshot().ids).map((node) => node.id),
    }));
    onCopy(e);
    if (!e.defaultPrevented) return;
    canvas.batch(() => {
      for (const { store, ids } of cutting) if (ids.length) store.dispatch({ type: "remove", ids });
      canvas.selection.clearAll();
    });
  };

  const onPaste = (e: ClipboardEvent) => {
    const band = clipboardBand();
    if (!band || band.readOnly) return;
    // Consumed either way: a paste aimed at a diagram must never fall through
    // and drop the clipboard into the text around it.
    e.preventDefault();
    e.stopPropagation();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const copy = lastCopy();
    const html = isCanvasHtml(text) ? text : copy?.html;
    const inPlace = pasteInPlace;
    pasteInPlace = false;
    if (!html) return;
    const fragment = parseScene(html);
    const store = band.api.store;
    const scene = store.getScene();
    // Back over its own originals it lands beside them, where it can be seen,
    // and again a step further out, so no paste hides under the one before.
    const onto = !inPlace && copy?.html === html && copy.blockIds.includes(band.blockId);
    const n = onto && repeats?.copy === copy && repeats.blockId === band.blockId ? repeats.n + 1 : 1;
    repeats = onto ? { copy, blockId: band.blockId, n } : null;
    const { ops, ids } = landFragment(scene, fragment, {
      offset: onto ? DUPLICATE_OFFSET * n : 0,
      parentId: pasteLevel(scene, band.api.ownSelection),
    });
    if (ops.length === 0) return;
    canvas.batch(() => {
      store.dispatch(ops);
      band.api.selection.select(ids);
    });
    band.api.focus();
  };

  const offDiagrams = registerPaneDiagrams(pane, {
    enter: (blockId) => {
      const entry = canvas.get(blockId);
      if (!entry || entry.readOnly) return false;
      const front = pickable(entry).at(-1);
      if (front) {
        entry.api.selection.select([front.id]);
        entry.api.focus();
      } else {
        tools.set("rect");
      }
      return true;
    },
    pasted: (blockId) => {
      void canvas.whenRegistered(blockId).then((entry) => {
        if (!entry) return;
        const ids = pickable(entry).map((node) => node.id);
        if (ids.length) entry.api.selection.select(ids);
        entry.api.focus();
      });
    },
  });

  pane.addEventListener("keydown", onKeyDown, true);
  pane.addEventListener("keyup", onKeyUp, true);
  pane.addEventListener("focusin", onFocusIn);
  document.addEventListener("copy", onCopy, true);
  document.addEventListener("cut", onCut, true);
  document.addEventListener("paste", onPaste, true);
  return () => {
    // A bracket left open would wedge its store: undo refuses while one is.
    endNudges();
    offSelection();
    offDiagrams();
    pane.removeEventListener("keydown", onKeyDown, true);
    pane.removeEventListener("keyup", onKeyUp, true);
    pane.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("copy", onCopy, true);
    document.removeEventListener("cut", onCut, true);
    document.removeEventListener("paste", onPaste, true);
  };
}
