import { createExtension, type BlockNoteEditorOptions } from "@blocknote/core";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

type PasteHandler = NonNullable<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  BlockNoteEditorOptions<any, any, any>["pasteHandler"]
>;

type KeyChord = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "code">;

/**
 * Paste as plain text: ⌘⇧V on a Mac (⌥⇧⌘V, the system's own spelling, too),
 * Ctrl+Shift+V elsewhere. Read by physical key, so the Option layer's `◊`
 * still counts as V.
 */
export function isPlainPasteKey(event: KeyChord, mac: boolean): boolean {
  if (event.code !== "KeyV" || !event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey && !event.altKey;
}

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Views whose next paste was asked for as plain text. */
const plain = new WeakSet<EditorView>();

/** Set for the length of `pastePlain`'s own paste. */
let pastingPlain = false;

/**
 * ProseMirror's own plain-text paste — a paragraph a line, the marks at the
 * caret — landed without the `uiEvent: "paste"` that tiptap's paste rules
 * wait for, or they would turn `**this**` back into bold.
 */
function pastePlain(view: EditorView, text: string) {
  pastingPlain = true;
  try {
    view.pasteText(text);
  } finally {
    pastingPlain = false;
  }
}

/**
 * ⌘⇧V pastes the clipboard's text with none of its formatting, as Notion does.
 *
 * Two things stood in the way. BlockNote's paste handler reads every paste the
 * same way — its markdown or HTML over its text — so where the platform does
 * fire a paste for the chord, the formatting came along regardless. And
 * Chrome on a Mac fires none: ⌘⇧V is bound to nothing there, so the chord
 * pasted nothing at all.
 *
 * So the chord marks the view, and the paste handler below takes a marked
 * paste as plain text. A paste arrives inside the keydown's own task when the
 * platform sends one; when none has by the next task, the clipboard is read
 * directly, which the browser may first ask permission for.
 */
export const plainPasteExtension = createExtension({
  key: "nt-plain-paste",
  prosemirrorPlugins: [
    new Plugin({
      props: {
        handleKeyDown(view, event) {
          if (!isPlainPasteKey(event, MAC) || event.target !== view.dom) return false;
          plain.add(view);
          setTimeout(() => {
            if (!plain.delete(view)) return;
            void navigator.clipboard?.readText().then(
              (text) => {
                if (text && view.editable && !view.isDestroyed) pastePlain(view, text);
              },
              () => {},
            );
          });
          return false;
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
 * Markdown in which a `---` straight under a line of text is a divider, as
 * Notion reads it, rather than CommonMark's setext underline — which quietly
 * turned the line above into a heading and ate the divider someone meant.
 * A blank line before the rule is all the difference; code fences are left
 * exactly as they are.
 */
export function dividersNotHeadings(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
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
 * The editor's paste: plain text when it was asked for, and otherwise
 * BlockNote's own, with dividers kept as dividers.
 *
 * BlockNote's handler is the one that knows which of the clipboard's flavours
 * to read as markdown — the detector it decides with isn't exported — so it
 * stays in charge, and only the markdown it is about to paste is rewritten,
 * for the length of the call.
 */
export const pasteHandler: PasteHandler = ({ event, editor, defaultPasteHandler }) => {
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
    editor.pasteMarkdown = pasteMarkdown;
  }
};
