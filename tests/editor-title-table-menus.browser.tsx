import { createRoot, type Root } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { SuggestionMenuController } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { TextSelection } from "prosemirror-state";
import { schema } from "../app/components/editor/schema";
import { mentionItems, slashItems } from "../app/components/editor/Editor";
import { PageMentionMenu, SlashMenu } from "../app/components/editor/SlashMenu";
import { Editable } from "../app/components/Editable";
import type { PageRef } from "../app/components/PagesContext";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { completionExtension } from "../app/components/editor/ai/completionExtension";
import { hintExtension } from "../app/components/editor/ai/hintText";
import { reviewExtension } from "../app/components/editor/ai/reviewExtension";
import { arrivalFlashExtension } from "../app/components/editor/arrivalFlash";
import { blockSelectionExtension } from "../app/components/editor/blockSelection";
import { commentExtension } from "../app/components/editor/comments/commentExtension";
import { tableKeysExtension } from "../app/components/editor/tableKeys";
import {
  leaveTitle,
  TITLE_ATTR,
  titleBoundaryExtension,
} from "../app/components/editor/titleBoundary";
import { PAGE_LINK_TRIGGER, pageLinkTriggerExtension } from "../app/components/editor/inline/pageLinkTrigger";
import { trailingParagraphExtension } from "../app/components/editor/trailingParagraph";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";
import "../app/components/editor/slashMenu.css";

// The production list, from `Editor.tsx`, in its order: which Tab and which
// Backspace win is decided by where each keymap sits in it.
const extensions = () => [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
  commentExtension,
  tableKeysExtension,
  titleBoundaryExtension,
  pageLinkTriggerExtension(),
  trailingParagraphExtension({ enabled: () => true }),
];

type Editor = typeof schema.BlockNoteEditor;
type PartialBlock = typeof schema.PartialBlock;

const PAGES = [
  { _id: "page-roadmap", title: "Roadmap" },
  { _id: "page-hiring", title: "Hiring plan" },
] as unknown as PageRef[];

let root: Root | undefined;
let editor: Editor;
let titleValue = "";
let committed = "";
const persisted: string[] = [];

function Page({ value }: { value: Editor }) {
  return (
    <main data-page-id="page-here" style={{ maxWidth: 760, padding: "60px 56px" }}>
      <div {...{ [TITLE_ATTR]: "" }}>
        <Editable
          value={titleValue}
          onInput={(text) => (titleValue = text)}
          onKeyDown={(e) =>
            // As PageSurface's commit: a write, and a record, only on a change.
            leaveTitle(e, async () => value as unknown as LiveEditor, (text) => {
              if (text === committed) return;
              committed = titleValue = text;
              persisted.push(text);
            })
          }
          label="Page title"
          placeholder="Untitled"
          className="nt-title"
        />
      </div>
      <div style={{ marginTop: 32 }}>
        <BlockNoteView
          editor={value}
          theme="light"
          className="nt-editor"
          sideMenu={false}
          slashMenu={false}
          formattingToolbar={false}
        >
          <SuggestionMenuController
            triggerCharacter="/"
            suggestionMenuComponent={SlashMenu}
            getItems={async (query) =>
              slashItems(value).filter((item) =>
                item.title.toLowerCase().includes(query.toLowerCase()),
              )
            }
          />
          {["@", PAGE_LINK_TRIGGER].map((trigger) => (
            <SuggestionMenuController
              key={trigger}
              triggerCharacter={trigger}
              suggestionMenuComponent={PageMentionMenu}
              getItems={async (query) =>
                mentionItems(value, PAGES).filter((item) =>
                  item.title.toLowerCase().includes(query.toLowerCase()),
                )
              }
            />
          ))}
        </BlockNoteView>
      </div>
    </main>
  );
}

type RawBlock = { id: string; type: string; props: Record<string, unknown>; content?: unknown };

function describeContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return (content as { type: string; text?: string; props?: { pageId?: string } }[])
      .map((inline) =>
        inline.type === "text" ? inline.text : `<${inline.type}${inline.props?.pageId ? `:${inline.props.pageId}` : ""}>`,
      )
      .join("");
  }
  if (content && typeof content === "object" && "rows" in content) {
    return (content as { rows: { cells: { content: { text?: string }[] }[] }[] }).rows.map((row) =>
      row.cells.map((cell) => cell.content.map((run) => run.text ?? "").join("")),
    );
  }
  return null;
}

const harness = {
  mount(blocks: PartialBlock[], title = "") {
    root?.unmount();
    root = undefined;
    titleValue = committed = title;
    persisted.length = 0;
    editor = BlockNoteEditor.create({ schema, initialContent: blocks, extensions: extensions() }) as Editor;
    root = createRoot(document.getElementById("app")!);
    root.render(<Page value={editor} />);
  },
  blocks: () =>
    (editor.document as unknown as RawBlock[]).map((block) => ({
      type: block.type,
      level: block.props.level,
      content: describeContent(block.content),
    })),
  titleText: () => document.querySelector(`[${TITLE_ATTR}] [contenteditable]`)?.textContent ?? null,
  persisted: () => [...persisted],
  /** Where focus is, and where the caret sits within it. */
  focus: () => {
    const active = document.activeElement;
    const inTitle = !!active?.closest(`[${TITLE_ATTR}]`);
    if (inTitle) {
      const selection = window.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(active!);
      range.setEnd(selection.anchorNode!, selection.anchorOffset);
      return { where: "title", offset: range.toString().length };
    }
    if (active?.closest(".bn-editor")) {
      const { $head } = editor.prosemirrorState.selection;
      const index = editor.document.findIndex(
        (block) => block.id === editor.getTextCursorPosition().block.id,
      );
      return { where: "editor", block: index, offset: $head.parentOffset, text: $head.parent.textContent };
    }
    return { where: active?.tagName ?? null };
  },
  /** A point on the title's text: at the character offset given. */
  titlePoint: (offset: number) => {
    const el = document.querySelector(`[${TITLE_ATTR}] [contenteditable]`)!;
    const node = el.firstChild;
    if (!node) {
      const box = el.getBoundingClientRect();
      return { x: box.left + 2, y: box.top + box.height / 2 };
    }
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset);
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return { x: rect.left, y: rect.top + rect.height / 2 };
  },
  /** A point at the start or end of the text of top-level block `index`. */
  blockPoint: (index: number, where: "start" | "end" = "end") => {
    const id = editor.document[index].id;
    const content = document.querySelector(`[data-node-type="blockContainer"][data-id="${id}"] .bn-block-content`)!;
    const node = document.createTreeWalker(content, NodeFilter.SHOW_TEXT).nextNode();
    if (!node) {
      const box = content.getBoundingClientRect();
      return { x: box.left + 2, y: box.top + box.height / 2 };
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    return { x: where === "start" ? rect.left + 1 : rect.right + 3, y: rect.top + rect.height / 2 };
  },
  /** Put the caret in the table's cell by its text, at its end. */
  caretInCell: (text: string) => {
    const view = editor.prosemirrorView!;
    let pos = -1;
    view.state.doc.descendants((node, p) => {
      if (pos < 0 && node.isText && node.text === text) pos = p + node.nodeSize;
      return pos < 0;
    });
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
    view.focus();
  },
  cell: () => {
    const { $head } = editor.prosemirrorState.selection;
    for (let d = $head.depth; d > 0; d--) {
      if ($head.node(d).type.name === "tableRow") {
        return { row: $head.index(d - 1), col: $head.index(d), text: $head.parent.textContent, offset: $head.parentOffset };
      }
    }
    return null;
  },
  menu: () =>
    [...document.querySelectorAll(".nt-slash .nt-slash-title")].map((el) => el.textContent),
  undo: () => editor.undo(),
  /** The ids of the blocks selected whole, as document indices. */
  selectedBlocks: () => {
    const ids = [...document.querySelectorAll(".nt-block-selected")].map((el) => el.getAttribute("data-id"));
    return ids.map((id) => editor.document.findIndex((block) => block.id === id));
  },
};

declare global {
  interface Window {
    seam: typeof harness;
  }
}
window.seam = harness;
