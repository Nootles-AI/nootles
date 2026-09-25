import {
  createExtension,
  getNodeById,
  insertOrUpdateBlockForSlashMenu,
  type BlockNoteEditor,
} from "@blocknote/core";
import { NodeSelection, Plugin, Selection, TextSelection } from "prosemirror-state";
import { blockText, type AnyBlock } from "@/app/lib/ai/projection";
import { blockSelection } from "../blockSelection";
import { preloadCodeEditor } from "../codemirror/CodeSurface";
import type { CodeExit } from "../codemirror/exits";
import {
  cancelWaiting,
  focusCodeBlock,
  holdKey,
  type CodeCaret,
} from "../codemirror/focusRequests";
import { fenceLanguage } from "../codemirror/languages";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/** Notion's "turn into code". Also the slash menu's badge. */
export const CODE_BLOCK_SHORTCUT = "Mod-Alt-8";

/** Put the caret into block `id`'s code, now or as soon as its editor mounts. */
export function enterCodeBlock(editor: Editor, id: string, at: CodeCaret): void {
  const view = editor.prosemirrorView;
  // A read-only page's code editors never answer, and a request left waiting
  // would hold the keys typed after it.
  if (view?.editable) focusCodeBlock(view.dom, id, at);
}

/**
 * The slash menu's code block. BlockNote's own item leaves the caret in the
 * next text block down, because ProseMirror cannot hold one in a block without
 * text — so what was typed next landed below the block it was meant for.
 */
export function insertCodeBlock(editor: Editor): void {
  const block = insertOrUpdateBlockForSlashMenu(editor, { type: "codeBlock" });
  enterCodeBlock(editor, block.id, "start");
}

/**
 * Take the caret out of code block `id` the way `exit` says (see `codeExit`).
 * False when there is nowhere to go, so the key stays CodeMirror's.
 *
 * The arrows go to the neighbour in document order, nesting included, and
 * treat it as a click would: text takes the caret, another code block takes
 * it in its own editor, and a block with no text — a diagram, an image — is
 * selected whole rather than left holding an invisible node selection. Given
 * the caret's `x`, text takes it at that column of its nearest line.
 */
export function leaveCodeBlock(
  editor: Editor,
  id: string,
  exit: CodeExit,
  x?: number,
): boolean {
  const view = editor.prosemirrorView;
  if (!view) return false;

  if (exit === "select") {
    blockSelection(editor).select([id]);
    return true;
  }
  if (exit === "unwrap") {
    editor.transact(() => {
      editor.updateBlock(id, { type: "paragraph" });
      editor.setTextCursorPosition(id, "start");
    });
    editor.focus();
    return true;
  }

  const { doc } = view.state;
  const found = getNodeById(id, doc);
  const content = found?.node.firstChild;
  if (!found || !content) return false;
  const back = exit === "previous";
  const $edge = doc.resolve(
    back ? found.posBeforeNode : found.posBeforeNode + 1 + content.nodeSize,
  );
  const target = Selection.findFrom($edge, back ? -1 : 1);

  if (!target) {
    if (back) return false;
    // Nothing below to take the caret: Notion makes a line to write on.
    editor.transact(() => {
      const [paragraph] = editor.insertBlocks([{ type: "paragraph" }], id, "after");
      editor.setTextCursorPosition(paragraph, "start");
    });
    editor.focus();
    return true;
  }
  if (target instanceof NodeSelection) {
    const neighbour: unknown = target.$from.parent.attrs.id;
    if (typeof neighbour !== "string") return false;
    if (target.node.type.name === "codeBlock") {
      enterCodeBlock(editor, neighbour, back ? "end" : "start");
    } else {
      blockSelection(editor).select([neighbour]);
    }
    return true;
  }
  view.dispatch(
    view.state.tr
      .setSelection(x === undefined ? target : atColumn(view, target, x))
      .scrollIntoView()
      .setMeta("addToHistory", false),
  );
  view.focus();
  return true;
}

type View = NonNullable<Editor["prosemirrorView"]>;

/**
 * The caret in `edge`'s text block at horizontal position `x`, on the line
 * `edge` sits on — its last line from above, its first from below. `edge`
 * itself when that point is not in the block.
 */
function atColumn(view: View, edge: Selection, x: number): Selection {
  const { $from } = edge;
  try {
    const line = view.coordsAtPos($from.pos);
    const hit = view.posAtCoords({ left: x, top: (line.top + line.bottom) / 2 });
    if (hit && hit.pos >= $from.start() && hit.pos <= $from.end()) {
      return TextSelection.create(view.state.doc, hit.pos);
    }
  } catch {
    // Not laid out (a hidden pane): the edge is still the right block.
  }
  return edge;
}

/**
 * Notion's "turn into code": every selected block with text becomes a code
 * block holding that text — a mention as its title, maths as its source (the
 * projection's plain text). One block turned from the caret takes the caret
 * into its code; several stay selected, as blocks. False when nothing
 * selected has text to turn.
 */
function turnIntoCode(editor: Editor): boolean {
  const selected = blockSelection(editor).getSnapshot().ids;
  const ids =
    selected.length > 0
      ? selected
      : (editor.getSelection()?.blocks.map((b) => b.id) ?? [
          editor.getTextCursorPosition().block.id,
        ]);
  const turning = ids
    .map((id) => editor.getBlock(id))
    .filter(
      (block): block is NonNullable<typeof block> =>
        block !== undefined &&
        editor.schema.blockSchema[block.type]?.content === "inline",
    );
  if (!turning.length) return false;
  editor.transact(() => {
    for (const block of turning) {
      editor.updateBlock(block.id, {
        type: "codeBlock",
        props: { code: blockText(block as AnyBlock) },
      });
    }
  });
  if (turning.length === 1 && !selected.length) {
    enterCodeBlock(editor, turning[0].id, "end");
  } else {
    blockSelection(editor).select(
      selected.length ? selected : turning.map((block) => block.id),
    );
  }
  return true;
}

/**
 * A Markdown fence typed at the start of a line becomes a code block, and the
 * rest of the line becomes its code. The rule reads the state before the
 * closing character lands, so the caret is still where it was typed.
 */
function fence(editor: Editor, typed: string, language?: string) {
  const block = editor.getTextCursorPosition().block;
  // Everything before the caret is the fence, less the character being typed.
  const rest = blockText(block as AnyBlock).slice(typed.length - 1);
  enterCodeBlock(editor, block.id, "start");
  return {
    type: "codeBlock",
    props: language ? { code: rest, language } : { code: rest },
    content: [],
  };
}

const ARROWS = {
  ArrowUp: "up",
  ArrowLeft: "left",
  ArrowDown: "down",
  ArrowRight: "right",
} as const;

/**
 * An arrow pressed at the edge of a text block, onto a code block: the caret
 * goes into its code, where ProseMirror would select the block as a node.
 */
function arrowIntoCode(view: View, event: KeyboardEvent): boolean {
  const dir = ARROWS[event.key as keyof typeof ARROWS];
  if (!dir || !view.editable || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) {
    return false;
  }
  const { selection, doc } = view.state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  if (!view.endOfTextblock(dir)) return false;
  const back = dir === "up" || dir === "left";
  const { $from } = selection;
  const next = Selection.findFrom(
    doc.resolve(back ? $from.before() : $from.after()),
    back ? -1 : 1,
  );
  if (!(next instanceof NodeSelection) || next.node.type.name !== "codeBlock") {
    return false;
  }
  const id: unknown = next.$from.parent.attrs.id;
  if (typeof id !== "string") return false;
  focusCodeBlock(view.dom, id, back ? "end" : "start");
  return true;
}

/**
 * Keys the page takes on a code block's behalf. While one it asked for is on
 * its way (see `focusRequests`), what is typed is held for it rather than
 * written around it; and the editor is fetched before it is first needed.
 */
function codeBlockPagePlugin() {
  return new Plugin({
    props: {
      handleKeyDown: arrowIntoCode,
      handleDOMEvents: {
        // Ahead of every keymap and input rule: text typed while the block
        // is still arriving belongs to the block.
        keydown(view, event) {
          if (holdKey(view.dom, event)) {
            event.preventDefault();
            return true;
          }
          if (event.key === "`" || event.key === "/") preloadCodeEditor();
          return false;
        },
      },
    },
    view(view) {
      const onPointer = () => cancelWaiting(view.dom);
      const doc = view.dom.ownerDocument;
      doc.addEventListener("pointerdown", onPointer, true);
      const idle = view.editable
        ? (window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 2000)))(
            preloadCodeEditor,
          )
        : null;
      return {
        destroy() {
          doc.removeEventListener("pointerdown", onPointer, true);
          if (idle !== null) (window.cancelIdleCallback ?? clearTimeout)(idle as number);
          cancelWaiting(view.dom);
        },
      };
    },
  });
}

/**
 * The code block's keys on the document side. Its keys inside the block are
 * CodeMirror's (see `codeExit`).
 */
export const codeBlockKeysExtension = createExtension({
  key: "nt-code-block-keys",
  prosemirrorPlugins: [codeBlockPagePlugin()],
  keyboardShortcuts: {
    [CODE_BLOCK_SHORTCUT]: ({ editor }) => turnIntoCode(editor),
  },
  inputRules: [
    // Notion's: the third backtick converts, without waiting for a space.
    { find: /^```$/, replace: ({ editor, match }) => fence(editor, match[0]) },
    // A fence that names its language, on a line that already reads "```py"
    // — pasted, say — closed with a space or Enter.
    {
      find: /^```([^`\s]+)\s$/,
      replace: ({ editor, match }) =>
        fence(editor, match[0], fenceLanguage(match[1])),
    },
  ],
});
