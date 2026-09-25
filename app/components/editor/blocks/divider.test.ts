import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import { parseHTML } from "linkedom";
import type { Node as PMNode } from "prosemirror-model";
import {
  EditorState as State,
  NodeSelection,
  type Plugin,
  TextSelection,
  type EditorState,
  type Transaction,
} from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "../schema";
import { dashesToDivider, typingKey } from "./divider";

if (!("document" in globalThis)) {
  const { document, window } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { document, window });
}

type Editor = typeof schema.BlockNoteEditor;
type Blocks = (typeof schema.PartialBlock)[];

const editors: Editor[] = [];
afterAll(() => editors.forEach((editor) => editor._tiptapEditor?.destroy()));

function editorOf(blocks: Blocks): Editor {
  const editor = BlockNoteEditor.create({ schema, initialContent: blocks });
  editors.push(editor);
  return editor;
}

function stateOf(blocks: Blocks): EditorState {
  return editorOf(blocks).prosemirrorState;
}

function posOf(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs.id === id) found = pos;
    return found < 0;
  });
  if (found < 0) throw new Error(`no block ${id}`);
  return found;
}

/** Each block as `type:text`, in reading order, nested ones included. */
function outline(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((node) => {
    if (node.type.isInGroup("blockContent")) {
      out.push(`${node.type.name}:${node.textContent}`);
    }
    return true;
  });
  return out;
}

/** The dashes' range inside `id`'s text, as the input rule reports it. */
function dashes(state: EditorState, id: string) {
  const start = posOf(state.doc, id) + 2;
  return { start, end: start + 3 };
}

function caretBlock(tr: Transaction): string {
  const { $from, empty } = tr.selection;
  expect(empty).toBe(true);
  return `${$from.parent.type.name}:${$from.parent.textContent}`;
}

describe("dashesToDivider", () => {
  it("turns the block into a divider and puts the caret in a new line below", () => {
    const state = stateOf([
      { id: "a", type: "paragraph", content: "---" },
      { id: "b", type: "paragraph", content: "after" },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:", "paragraph:after"]);
    expect(caretBlock(tr)).toBe("paragraph:");
    // The divider keeps the block's identity.
    expect(tr.doc.nodeAt(posOf(tr.doc, "a"))!.firstChild!.type.name).toBe("divider");
  });

  it("reuses an empty paragraph already below", () => {
    const state = stateOf([
      { id: "a", type: "paragraph", content: "---" },
      { id: "b", type: "paragraph" },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:"]);
    expect(tr.selection.from).toBe(posOf(tr.doc, "b") + 2);
  });

  it("lets the block's nested blocks step out, since a divider holds none", () => {
    const state = stateOf([
      {
        id: "a",
        type: "paragraph",
        content: "---",
        children: [{ id: "c", type: "paragraph", content: "child" }],
      },
    ]);
    const { start, end } = dashes(state, "a");
    const tr = dashesToDivider(state, start, end)!;
    expect(outline(tr.doc)).toEqual(["divider:", "paragraph:", "paragraph:child"]);
    expect(caretBlock(tr)).toBe("paragraph:");
    expect(tr.doc.nodeAt(posOf(tr.doc, "a"))!.childCount).toBe(1);
    // Siblings all: the new line and the lifted child sit where the divider does.
    const depth = (pos: number) => tr.doc.resolve(pos).depth;
    const { $from } = tr.selection;
    expect(depth($from.before($from.depth - 1))).toBe(depth(posOf(tr.doc, "a")));
    expect(depth(posOf(tr.doc, "c"))).toBe(depth(posOf(tr.doc, "a")));
  });

  it("declines when text follows the dashes", () => {
    const state = stateOf([{ id: "a", type: "paragraph", content: "---kept" }]);
    const { start, end } = dashes(state, "a");
    expect(dashesToDivider(state, start, end)).toBeNull();
  });
});

/** The plugins the editor would mount with, in the order it would ask them. */
function pluginsOf(editor: Editor): Plugin[] {
  return (editor._tiptapEditor as unknown as { extensionManager: { plugins: Plugin[] } })
    .extensionManager.plugins;
}

/**
 * Just enough of an EditorView to run the editor's own plugin chain: props are
 * asked in plugin order, and every dispatch goes through `apply`, appended
 * transactions included.
 */
function viewOf(
  editor: Editor,
  selection: (doc: PMNode) => NodeSelection | TextSelection,
) {
  const { doc } = editor.prosemirrorState;
  let state = State.create({ doc, plugins: pluginsOf(editor), selection: selection(doc) });
  const view = {
    get state() {
      return state;
    },
    composing: false,
    dispatch(tr: Transaction) {
      state = state.apply(tr);
    },
    someProp(name: string, f?: (prop: (...args: unknown[]) => unknown) => unknown) {
      for (const plugin of state.plugins) {
        const prop = (plugin.props as Record<string, unknown>)[name];
        if (typeof prop !== "function") continue;
        const result = f ? f(prop.bind(plugin)) : prop;
        if (result) return result;
      }
    },
  };
  // Tiptap's plugins read the view off the editor rather than their arguments.
  Object.defineProperty(editor._tiptapEditor, "view", { get: () => view, configurable: true });
  return view as unknown as EditorView & { state: EditorState };
}

/** Text typed at the caret, as ProseMirror offers it before inserting it. */
function type(view: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = view.state.selection;
    const deflt = () => view.state.tr.insertText(char, from, to);
    if (!view.someProp("handleTextInput", (f) => f(view, from, to, char, deflt))) {
      view.dispatch(deflt());
    }
  }
}

function keydown(view: EditorView, key: string) {
  let prevented = false;
  const event = {
    key,
    code: "",
    keyCode: 0,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: () => (prevented = true),
  } as unknown as KeyboardEvent;
  const handled = !!view.someProp("handleKeyDown", (f) => f(view, event));
  return handled && prevented;
}

const onDivider = (id: string) => (doc: PMNode) => NodeSelection.create(doc, posOf(doc, id) + 1);

describe("the `---` rule, through the editor's plugins", () => {
  it("fires when the dashes are the whole block", () => {
    const view = viewOf(editorOf([{ id: "a", type: "paragraph" }]), (doc) =>
      TextSelection.create(doc, posOf(doc, "a") + 2),
    );
    type(view, "---");
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:"]);
    expect(view.state.selection).toBeInstanceOf(TextSelection);
  });

  it("keeps text the dashes were typed ahead of", () => {
    const view = viewOf(editorOf([{ id: "a", type: "paragraph", content: "abc" }]), (doc) =>
      TextSelection.create(doc, posOf(doc, "a") + 2),
    );
    type(view, "---");
    expect(outline(view.state.doc)).toEqual(["paragraph:---abc"]);
  });
});

describe("typing on a selected divider", () => {
  it("is caught ahead of BlockNote's guard, which drops the key", () => {
    const keys = pluginsOf(editorOf([{ type: "paragraph" }])).map((plugin) => (plugin as unknown as { key: string }).key);
    const ours = keys.indexOf((typingKey as unknown as { key: string }).key);
    expect(ours).toBeGreaterThanOrEqual(0);
    expect(ours).toBeLessThan(keys.findIndex((key) => key.startsWith("node-selection-keyboard")));
  });

  it("writes the keystroke on a new line below it", () => {
    const view = viewOf(
      editorOf([
        { id: "a", type: "divider" },
        { id: "b", type: "paragraph", content: "after" },
      ]),
      onDivider("a"),
    );
    expect(keydown(view, "x")).toBe(true);
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:x", "paragraph:after"]);
    expect(view.state.selection.$from.parentOffset).toBe(1);
  });

  it("writes into an empty paragraph below instead of making another", () => {
    const view = viewOf(
      editorOf([
        { id: "a", type: "divider" },
        { id: "b", type: "paragraph" },
      ]),
      onDivider("a"),
    );
    keydown(view, "x");
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:x"]);
  });

  it("does the same with the divider's whole block selected", () => {
    const view = viewOf(editorOf([{ id: "a", type: "divider" }]), (doc) =>
      NodeSelection.create(doc, posOf(doc, "a")),
    );
    keydown(view, "x");
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:x"]);
  });

  it("opens the slash menu for a `/`", () => {
    const editor = editorOf([{ id: "a", type: "divider" }]);
    editor.getExtension(SuggestionMenu)!.addSuggestionMenu({ triggerCharacter: "/" });
    const view = viewOf(editor, onDivider("a"));
    keydown(view, "/");
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:/"]);
    const menu = view.state.plugins
      .find((plugin) => (plugin as unknown as { key: string }).key.startsWith("SuggestionMenuPlugin$"))!
      .getState(view.state);
    expect(menu?.triggerCharacter).toBe("/");
  });

  it("leaves other selections alone", () => {
    const view = viewOf(
      editorOf([
        { id: "a", type: "divider" },
        { id: "b", type: "paragraph", content: "after" },
      ]),
      (doc) => TextSelection.create(doc, posOf(doc, "b") + 2),
    );
    expect(keydown(view, "x")).toBe(false);
    expect(outline(view.state.doc)).toEqual(["divider:", "paragraph:after"]);
  });
});
