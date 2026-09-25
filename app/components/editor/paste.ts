import { createExtension, type BlockNoteEditorOptions } from "@blocknote/core";
import { Fragment, Slice } from "prosemirror-model";
import { Plugin, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

type PasteHandler = NonNullable<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BlockNoteEditorOptions<any, any, any>["pasteHandler"]
>;

type KeyChord = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">;

/**
 * ⌘⇧V on a Mac (⌥⇧⌘V too), Ctrl+Shift+V elsewhere — by physical key, so the
 * Option layer's `◊` still counts as V.
 */
export function isPlainPasteKey(event: KeyChord, mac: boolean): boolean {
  if (event.code !== "KeyV" || !event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && !event.altKey;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Every line, blank ones included: Notion keeps an empty line as an empty block. */
export function plainLines(text: string): string[] {
  return text.split(/\r\n?|\n/);
}

/** Views whose next paste was asked for as plain text. */
const plain = new WeakSet<EditorView>();

/** Bumped by anything that should void a clipboard read still in flight. */
let generation = 0;
const READ_DEADLINE_MS = 1500;

/** Set for the length of a fallback paste through ProseMirror's own path. */
let pastingPlain = false;

/**
 * The first line continues the caret's block and the last takes up what
 * followed the caret, as typed text would — ProseMirror's own plain paste
 * hands back a slice closed at its start, which put the first line in a block
 * of its own. `tr.replace` rather than `replaceSelection`, whose defining-node
 * rule would turn an empty bullet into the pasted paragraph.
 */
function pastePlain(view: EditorView, text: string) {
  const { state } = view;
  const { selection, schema } = state;
  const { $from, from, to } = selection;
  const container = $from.depth > 0 ? $from.node($from.depth - 1) : null;
  if ($from.parent.type.spec.code) {
    view.dispatch(state.tr.insertText(text).scrollIntoView().setMeta("paste", true));
    return;
  }
  if (!(selection instanceof TextSelection) || container?.type.name !== "blockContainer") {
    pastingPlain = true;
    try {
      view.pasteText(text);
    } finally {
      pastingPlain = false;
    }
    return;
  }
  const marks = state.storedMarks ?? $from.marks();
  const blocks = plainLines(text).map((line) =>
    container.type.create(null, schema.nodes.paragraph.create(null, line ? schema.text(line, marks) : null)),
  );
  const tr = state.tr.replace(from, to, new Slice(Fragment.from(blocks), 2, 2));
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(to)), -1));
  view.dispatch(tr.scrollIntoView().setMeta("paste", true));
}

/**
 * ⌘⇧V pastes the clipboard's text with none of its formatting. BlockNote reads
 * every paste the same way, so the chord marks the view for the handler
 * below; and Chrome on a Mac fires no paste for the chord at all, so when none
 * has come by the next task the clipboard is read directly — dropped if the
 * person has since moved on, since a permission prompt can hold it for long.
 */
export const plainPasteExtension = createExtension({
  key: "nt-plain-paste",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (!isPlainPasteKey(event, MAC) || event.target !== view.dom) {
            if (!/^(Meta|Control|Shift|Alt)$/.test(event.key)) generation++;
            return false;
          }
          const chord = ++generation;
          const deadline = Date.now() + READ_DEADLINE_MS;
          plain.add(view);
          setTimeout(() => {
            if (!plain.delete(view)) return;
            void navigator.clipboard?.readText().then(
              (text) => {
                if (generation !== chord || Date.now() > deadline) return;
                if (text && view.editable && !view.isDestroyed) pastePlain(view, text);
              },
              () => {},
            );
          });
          return false;
        },
        handleDOMEvents: {
          mousedown() {
            generation++;
            return false;
          },
        },
        handlePaste(view, _event, slice) {
          if (!pastingPlain) return false;
          view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true));
          return true;
        },
      },
    }),
  ],
});

const DASH_RULE = /^ {0,3}-(?:[ \t]*-){2,}[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * A `---` straight under a line is a divider, as Notion reads it, not
 * CommonMark's setext underline, which turned the line into a heading and ate
 * the rule. A blank line before it is all the difference; code fences are left
 * exactly as they are. Known gaps: `===` is still a setext H1, and a quoted
 * `> ---` is left alone, as a quote here holds no divider.
 */
export function dividersNotHeadings(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const opener = FENCE.exec(line)?.[1];
    if (fence) {
      if (opener?.[0] === fence[0] && opener.length >= fence.length && line.trim() === opener) {
        fence = null;
      }
    } else if (opener) {
      fence = opener;
    } else if (DASH_RULE.test(line) && out.length && out[out.length - 1].trim() !== "") {
      out.push("");
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Plain text when it was asked for; otherwise BlockNote's own paste, which
 * alone knows which flavour to read as markdown, with that markdown rewritten
 * for the length of the call.
 */
export const pasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
  generation++;
  const view = editor.prosemirrorView;
  if (view && plain.delete(view)) {
    const text = event.clipboardData?.getData("text/plain");
    if (text) {
      pastePlain(view, text);
      return true;
    }
  }
  const pasteMarkdown = editor.pasteMarkdown;
  editor.pasteMarkdown = (markdown) => pasteMarkdown.call(editor, dividersNotHeadings(markdown));
  try {
    return defaultPasteHandler();
  } finally {
    delete (editor as { pasteMarkdown?: unknown }).pasteMarkdown;
  }
};
