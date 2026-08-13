"use client";

import { useEffect, useRef } from "react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import {
  getDefaultReactSlashMenuItems,
  getFormattingToolbarItems,
  FormattingToolbar,
  FormattingToolbarController,
  SuggestionMenuController,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { autoPlacement, offset, shift, size } from "@floating-ui/react";
import { useBlockNoteSync } from "@convex-dev/prosemirror-sync/blocknote";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { schema } from "./schema";
import { usePages, type PageRef } from "../PagesContext";
import { pageTitle } from "./inline/PageMention";
import { useRegisterEditor } from "./EditorRegistry";
import { BlockSideMenu } from "./BlockSideMenu";
import { PageTitleProvider } from "./PageTitleContext";
import { InlineCodeButton } from "./InlineCodeButton";
import { SubstrateHarness } from "./ai/SubstrateHarness";
import { completionExtension } from "./ai/completionExtension";
import { hintExtension } from "./ai/hintText";
import { reviewExtension } from "./ai/reviewExtension";
import { ReviewOverlay } from "./ai/ReviewOverlay";
import { track } from "@/app/lib/telemetry";
import { useTabCompletion, type PageMode } from "./ai/useTabCompletion";
import { useReformat } from "./ai/useReformat";
import { ReformatBar } from "./ai/ReformatBar";
import "./editor.css";

type EditorInstance = typeof schema.BlockNoteEditor;

/**
 * The default toolbar plus an inline-code button, next to the other text styles
 * rather than tacked on the end. BlockNote ships bold/italic/underline/strike
 * and stops there, but the document grammar has always had `<code>` — so
 * without this the AI could produce a mark the user could not.
 *
 * `getFormattingToolbarItems` is called with no argument, exactly as the stock
 * toolbar does: BlockTypeSelect then falls back to its own dictionary-derived
 * option list.
 *
 * Note the `formattingToolbar={false}` on BlockNoteView above. Without it the
 * default UI mounts its own controller too, and two controllers sharing one
 * extension store fight over the open state — clicking the block-type dropdown
 * closed the whole toolbar. Same reason sideMenu and slashMenu are disabled.
 */
function Toolbar() {
  const items = getFormattingToolbarItems();
  const code = <InlineCodeButton key="codeStyleButton" />;
  const i = items.findIndex((el) => el.key === "strikeStyleButton");
  return (
    <FormattingToolbar>
      {i === -1
        ? [...items, code]
        : [...items.slice(0, i + 1), code, ...items.slice(i + 1)]}
    </FormattingToolbar>
  );
}

/**
 * A label and about four rows — less room than this below the caret and the
 * menu is better off above it.
 */
const ROOM_FOR_MENU = 200;

/**
 * BlockNote's own placement for the `/` and `@` menus, with one change.
 *
 * Its chain caps the menu at whatever room `size` found on the side
 * `autoPlacement` picked — and the next pass measures that capped box, so a
 * menu crushed into the sliver under the last line of a page reads as one that
 * fits there and never flips above. Holding the cap to `ROOM_FOR_MENU` breaks
 * the circle: a sliver stops counting as somewhere the menu fits, and the side
 * with room wins.
 *
 * Passing `middleware` replaces theirs rather than extending it, so the rest of
 * the chain is restated here as they have it.
 */
const menuPlacement = {
  useFloatingOptions: {
    middleware: [
      offset(10),
      autoPlacement({
        allowedPlacements: ["bottom-start", "top-start"],
        padding: 10,
      }),
      shift(),
      size({
        apply({ elements, availableHeight }) {
          elements.floating.style.maxHeight = `${Math.max(ROOM_FOR_MENU, availableHeight)}px`;
        },
        padding: 10,
      }),
    ],
  },
};

function filterItems(
  items: DefaultReactSuggestionItem[],
  query: string,
): DefaultReactSuggestionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (i) =>
      i.title.toLowerCase().includes(q) ||
      i.aliases?.some((a) => a.toLowerCase().includes(q)),
  );
}

// Our custom insert items, grouped separately from the default "Basic blocks".
function customSlashItems(editor: EditorInstance): DefaultReactSuggestionItem[] {
  return [
    {
      title: "Diagram",
      subtext: "Draw a canvas with shapes and connectors",
      aliases: ["diagram", "canvas", "draw", "flowchart", "board", "graph"],
      group: "Canvas",
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "canvas", props: { data: "" } });
        track("block_created", { type: "canvas" });
      },
    },
    {
      title: "Inline code",
      subtext: "Format text as code, for variable names",
      aliases: ["code", "inline code", "mono", "variable", "`"],
      group: "Inline",
      // Empty selection just arms the mark, so whatever you type next is code.
      onItemClick: () => editor.toggleStyles({ code: true }),
    },
    {
      title: "Math equation",
      subtext: "Inline LaTeX equation",
      aliases: ["math", "math-equation", "equation", "latex", "tex", "inline math"],
      group: "Math",
      onItemClick: () => {
        editor.insertInlineContent([{ type: "math", props: { latex: "" } }, " "]);
        track("block_created", { type: "inline-math" });
      },
    },
    {
      title: "Math block",
      subtext: "Reactive equations with live variables",
      aliases: ["math-block", "mathblock", "calc", "variables", "compute", "notebook"],
      group: "Math",
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "mathBlock", props: { source: "" } });
        track("block_created", { type: "math" });
      },
    },
  ];
}

// The "@" menu: every page in the project, as a chip to be inserted.
function mentionItems(
  editor: EditorInstance,
  pages: PageRef[],
): DefaultReactSuggestionItem[] {
  return pages.map((page) => ({
    title: pageTitle(page.title),
    subtext: "Page",
    group: "Link to page",
    onItemClick: () => {
      editor.insertInlineContent([
        { type: "pageMention", props: { pageId: page._id, title: page.title } },
        " ",
      ]);
      track("mention_inserted", { surface: "editor" });
    },
  }));
}

/**
 * The block editor for a single page, bound to its prosemirror-sync document.
 * Steps + snapshots are persisted by the Convex prosemirror-sync component, so
 * this stays a thin client: the hook owns the collaborative state, we own the
 * presentation and the (custom) schema. The slash menu's "Code Block" item
 * targets our `codeBlock` type, which is the CodeMirror-backed block.
 */
export function Editor({
  docId,
  pageId,
  title = "",
  mode = "create",
}: {
  docId: string;
  pageId?: Id<"pages">;
  /** Emitted as <title> in the model's view of the document. */
  title?: string;
  /** How eager ambient suggestions should be on this page. */
  mode?: PageMode;
}) {
  const pages = usePages();
  const sync = useBlockNoteSync<EditorInstance>(api.prosemirror, docId, {
    editorOptions: {
      schema,
      extensions: [completionExtension, reviewExtension, hintExtension],
    },
  });

  useRegisterEditor(pageId, sync.editor, docId);
  useTabCompletion(sync.editor, pageId, title, mode);
  const reformat = useReformat(sync.editor, pageId);

  // First open of a page has no document yet — create an empty one seamlessly.
  // Guarded per-docId so StrictMode's double-invoke can't create twice.
  const createdFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sync.isLoading && !sync.editor && createdFor.current !== docId) {
      createdFor.current = docId;
      void sync.create({ type: "doc", content: [] });
    }
  }, [sync, docId]);

  if (!sync.editor) {
    return <div className="min-h-[40vh]" aria-hidden />;
  }

  const editor = sync.editor;
  return (
    <PageTitleProvider value={title}>
      <BlockNoteView
        editor={editor}
        theme="light"
        className="nt-editor"
        sideMenu={false}
        slashMenu={false}
        formattingToolbar={false}
      >
        <BlockSideMenu />
        <FormattingToolbarController formattingToolbar={Toolbar} />
        <SuggestionMenuController
          triggerCharacter="/"
          floatingUIOptions={menuPlacement}
          getItems={async (query) =>
            filterItems(
              [...getDefaultReactSlashMenuItems(editor), ...customSlashItems(editor)],
              query,
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="@"
          floatingUIOptions={menuPlacement}
          getItems={async (query) =>
            filterItems(mentionItems(editor, pages ?? []), query)
          }
        />
      </BlockNoteView>
      {pageId && <ReviewOverlay editor={editor} pageId={pageId} />}
      {reformat.state && (
        <ReformatBar
          editor={editor}
          state={reformat.state}
          onAccept={reformat.accept}
          onDismiss={reformat.dismiss}
          onCycle={reformat.cycle}
        />
      )}
      {process.env.NODE_ENV !== "production" && pageId && (
        <SubstrateHarness editor={editor} pageId={pageId} />
      )}
    </PageTitleProvider>
  );
}
