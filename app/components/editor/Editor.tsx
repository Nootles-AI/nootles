"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, type ReactElement } from "react";
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
import { useConvex, useQuery } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useYjsEditor } from "@/app/lib/sync/useYjsEditor";
import { initEmptyYDoc, migrateLegacyDoc } from "@/app/lib/sync/migrate";
import { collabColor } from "@/app/lib/sync/colors";
import { schema } from "./schema";
import { armBlock, SERVICES } from "./media/search";
import { usePages, type PageRef } from "../PagesContext";
import { pageTitle } from "./inline/PageMention";
import { useRegisterEditor } from "./EditorRegistry";
import { BlockSideMenu } from "./BlockSideMenu";
import { PageTitleProvider } from "./PageTitleContext";
import { InlineCodeButton } from "./InlineCodeButton";
import { completionExtension } from "./ai/completionExtension";
import { hintExtension } from "./ai/hintText";
import { reviewExtension } from "./ai/reviewExtension";
import { ReviewOverlay } from "./ai/ReviewOverlay";
import { track } from "@/app/lib/telemetry";
import { serializeStoryboard } from "./storyboard/serialize";
import { emptyStoryboard } from "./storyboard/types";
import { useTabCompletion, type PageMode } from "./ai/useTabCompletion";
import { useReformat } from "./ai/useReformat";
import { ReformatBar } from "./ai/ReformatBar";
import { arrivalFlashExtension } from "./arrivalFlash";
import { blockSelection, blockSelectionExtension } from "./blockSelection";
import { useBlockMarquee } from "./useBlockMarquee";
import { SlashMenu } from "./SlashMenu";
import * as Icon from "../Icons";
import { useReadOnly } from "./readOnly";
import { EditorSkeleton } from "../Skeleton";
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

// One section per group name. The menu keys its sections by group, so a group
// that appears in the defaults AND in our items — Media does — would render as
// duplicate-keyed twins, which React warns about and draws wrong.
function groupAdjacent(
  items: DefaultReactSuggestionItem[],
): DefaultReactSuggestionItem[] {
  const order = new Map<string | undefined, number>();
  for (const item of items) {
    if (!order.has(item.group)) order.set(item.group, order.size);
  }
  return [...items].sort(
    (a, b) => order.get(a.group)! - order.get(b.group)!,
  );
}

function filterItems(
  items: DefaultReactSuggestionItem[],
  query: string,
): DefaultReactSuggestionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  // An item NAMED what was typed outranks one that merely answers to it —
  // "/media" must land on Media, not on the first thing with a "media" alias.
  // Ranking moves whole groups (by their best item), never items across
  // groups, so each group stays one contiguous — one-keyed — section.
  const score = (i: DefaultReactSuggestionItem): number =>
    i.title.toLowerCase().startsWith(q)
      ? 0
      : i.title.toLowerCase().includes(q)
        ? 1
        : i.aliases?.some((a) => a.toLowerCase().includes(q))
          ? 2
          : 3;
  const kept = items
    .map((item, index) => ({ item, index, score: score(item) }))
    .filter((e) => e.score < 3);
  const groupBest = new Map<string | undefined, number>();
  const groupOrder = new Map<string | undefined, number>();
  for (const e of kept) {
    const g = e.item.group;
    groupBest.set(g, Math.min(groupBest.get(g) ?? 3, e.score));
    if (!groupOrder.has(g)) groupOrder.set(g, groupOrder.size);
  }
  return kept
    .sort(
      (a, b) =>
        groupBest.get(a.item.group)! - groupBest.get(b.item.group)! ||
        groupOrder.get(a.item.group)! - groupOrder.get(b.item.group)! ||
        a.score - b.score ||
        a.index - b.index,
    )
    .map((e) => e.item);
}

/**
 * What a command is FOR, which is what someone reaching for one is thinking.
 *
 * The old sections were what each block technically IS — nine of them, with
 * Heading 1-3 in one and Heading 4-6 in another, Table alone under "Advanced",
 * Emoji alone under "Others". Four intents instead, everyday text first so the
 * common case needs no scrolling and the rich blocks sit below it.
 */
const WRITE = "Write";
const ORGANISE = "Organise";
const INSERT = "Insert";
const COMPUTE = "Compute";

/**
 * BlockNote spells a shortcut "⌘-Alt-1" / "Ctrl-Alt-1": modifier names joined
 * by hyphens, which reads as a range rather than a chord. Ours are the
 * platform's own glyphs, unseparated on Apple where that is the convention.
 */
function tidyBadge(badge?: string): string | undefined {
  if (!badge) return undefined;
  const parts = badge.split("-").filter(Boolean);
  if (!badge.includes("⌘")) return parts.join("+");
  const glyph: Record<string, string> = { Alt: "⌥", Shift: "⇧", Ctrl: "⌃" };
  return parts.map((p) => glyph[p] ?? p.toUpperCase()).join("");
}

/**
 * Every "/" command, in intent order, each carrying one of our own icons.
 *
 * The stock items are kept for their insertion behaviour and re-dressed rather
 * than reimplemented — `onItemClick` is BlockNote's and stays BlockNote's. What
 * we take over is the wording, the section and the glyph, because ten of our
 * own items had no icon at all while eighteen stock ones did, and the menu read
 * as two menus stacked.
 */
function slashItems(editor: EditorInstance): DefaultReactSuggestionItem[] {
  const d = editor.dictionary.slash_menu;
  const stock = new Map(
    getDefaultReactSlashMenuItems(editor).map((i) => [i.title, i] as const),
  );
  const restyle = (
    title: string,
    group: string,
    icon: ReactElement,
    over: Partial<DefaultReactSuggestionItem> = {},
  ): DefaultReactSuggestionItem[] => {
    const item = stock.get(title);
    // Absent only if a block spec stopped qualifying; dropping the row is
    // better than rendering one whose click does nothing.
    if (!item) return [];
    return [{ ...item, group, icon, badge: tidyBadge(item.badge), ...over }];
  };

  return [
    // ---- Write ----------------------------------------------------------
    ...restyle(d.paragraph.title, WRITE, <Icon.Paragraph />, {
      title: "Text",
      subtext: "Plain paragraph",
    }),
    ...restyle(d.heading.title, WRITE, <Icon.Heading1 />, {
      subtext: "Top-level section",
    }),
    ...restyle(d.heading_2.title, WRITE, <Icon.Heading2 />, {
      subtext: "Section inside a section",
    }),
    ...restyle(d.heading_3.title, WRITE, <Icon.Heading3 />, {
      subtext: "The level below that",
    }),
    ...restyle(d.quote.title, WRITE, <Icon.Quote />, {
      subtext: "Set a passage apart",
    }),

    // ---- Organise -------------------------------------------------------
    ...restyle(d.bullet_list.title, ORGANISE, <Icon.BulletList />, {
      title: "Bullet list",
      subtext: "An unordered list",
    }),
    ...restyle(d.numbered_list.title, ORGANISE, <Icon.NumberedList />, {
      title: "Numbered list",
      subtext: "A list that counts",
    }),
    ...restyle(d.check_list.title, ORGANISE, <Icon.TodoList />, {
      title: "To-do list",
      subtext: "Checkboxes you can tick",
    }),
    ...restyle(d.toggle_list.title, ORGANISE, <Icon.ToggleList />, {
      title: "Toggle list",
      subtext: "A list that folds away",
    }),
    ...restyle(d.table.title, ORGANISE, <Icon.Table />, {
      subtext: "Rows and columns",
    }),
    ...restyle(d.divider.title, ORGANISE, <Icon.Divider />, {
      subtext: "A line between things",
    }),

    // ---- Insert ---------------------------------------------------------
    {
      title: "Diagram",
      subtext: "Draw a canvas with shapes and connectors",
      aliases: ["diagram", "canvas", "draw", "flowchart", "board", "graph"],
      group: INSERT,
      icon: <Icon.Diagram />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "canvas", props: { data: "" } });
        track("block_created", { type: "canvas" });
      },
    },
    {
      title: "Storyboard",
      subtext: "Shot frames with room to write underneath",
      aliases: [
        "storyboard", "board", "shots", "frames", "panels", "scene",
        "film", "sequence", "shotlist", "previs",
      ],
      group: INSERT,
      icon: <Icon.Storyboard />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, {
          type: "storyboard",
          props: { data: serializeStoryboard(emptyStoryboard()) },
        });
        track("block_created", { type: "storyboard" });
      },
    },
    {
      // Ahead of Album on purpose: both answer to "video", and a tie goes to
      // the earlier item — "/video" should reach the player, not the gallery.
      title: "Media",
      subtext: "A song or video by link — or a file",
      aliases: [
        "media", "audio", "video", "song", "music", "track", "sound",
        "spotify", "apple music", "youtube", "vimeo", "soundcloud",
        "uppbeat", "mp3", "mp4", "podcast", "film", "embed",
      ],
      group: INSERT,
      icon: <Icon.MediaPlay />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        // `audio` only until a link or file settles it — the block converts
        // itself to `video` when what lands in it is one.
        editor.updateBlock(block, {
          type: "audio",
          props: { url: "", name: "", caption: "" },
        });
        track("block_created", { type: "media" });
      },
    },
    // The two services that can be searched from inside the block. Each is the
    // Media block, opened already looking at that shelf.
    ...(["spotify", "apple"] as const).map((service) => ({
      title: SERVICES[service].label,
      subtext: `Search ${SERVICES[service].label} and pick a song`,
      aliases:
        service === "spotify"
          ? ["spotify", "song", "music", "search"]
          : ["apple music", "applemusic", "apple", "itunes", "song", "music", "search"],
      group: INSERT,
      icon: service === "spotify" ? <Icon.Spotify /> : <Icon.AppleMusic />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        armBlock(block.id, service);
        editor.updateBlock(block, {
          type: "audio",
          props: { url: "", name: "", caption: "" },
        });
        track("block_created", { type: `media-${service}` });
      },
    })),
    {
      title: "Location",
      subtext: "A place, with a map, photos and reviews",
      aliases: [
        "location", "place", "map", "maps", "address", "cafe", "restaurant",
        "pin", "google maps", "directions", "venue",
      ],
      group: INSERT,
      icon: <Icon.Location />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "location", props: { data: "" } });
        track("block_created", { type: "location" });
      },
    },
    {
      title: "Album",
      subtext: "Photos and videos, in a waterfall",
      aliases: ["album", "photos", "gallery", "waterfall", "masonry", "images", "video", "media"],
      group: INSERT,
      icon: <Icon.Album />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "album", props: { data: "" } });
        track("block_created", { type: "album" });
      },
    },
    {
      title: "Inline code",
      subtext: "Format text as code, for variable names",
      aliases: ["code", "inline code", "mono", "variable", "`"],
      group: COMPUTE,
      icon: <Icon.InlineCode />,
      // Empty selection just arms the mark, so whatever you type next is code.
      onItemClick: () => editor.toggleStyles({ code: true }),
    },
    {
      title: "Math equation",
      subtext: "Inline LaTeX equation",
      aliases: ["math", "math-equation", "equation", "latex", "tex", "inline math"],
      group: COMPUTE,
      icon: <Icon.Equation />,
      onItemClick: () => {
        editor.insertInlineContent([{ type: "math", props: { latex: "" } }, " "]);
        track("block_created", { type: "inline-math" });
      },
    },
    {
      title: "Math block",
      subtext: "Reactive equations with live variables",
      aliases: ["math-block", "mathblock", "calc", "variables", "compute", "notebook"],
      group: COMPUTE,
      icon: <Icon.MathBlock />,
      onItemClick: () => {
        const block = editor.getTextCursorPosition().block;
        editor.updateBlock(block, { type: "mathBlock", props: { source: "" } });
        track("block_created", { type: "math" });
      },
    },

    // The rest of the stock set, re-dressed. `groupAdjacent` gathers each
    // section by where its group first appeared, so these land beside their
    // own kind rather than where they sit in this list.
    ...restyle(d.image.title, INSERT, <Icon.Image />, {
      subtext: "A picture, with a caption",
    }),
    ...restyle(d.file.title, INSERT, <Icon.FileBlock />, {
      subtext: "Any file, to download",
    }),
    ...restyle(d.emoji.title, INSERT, <Icon.Emoji />, {
      subtext: "Search and drop one in",
    }),
    ...restyle(d.code_block.title, COMPUTE, <Icon.CodeBlock />, {
      title: "Code block",
      subtext: "Syntax-highlighted, in any language",
    }),
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

type EditorProps = {
  docId: string;
  pageId?: Id<"pages">;
  /** Emitted as <title> in the model's view of the document. */
  title?: string;
  /** How eager ambient suggestions should be on this page. */
  mode?: PageMode;
};

/** The flag the Yjs cutover ships behind; off means the app you had. */
const YJS_ON = process.env.NEXT_PUBLIC_YJS === "1";

const EXTENSIONS = [
  completionExtension,
  reviewExtension,
  hintExtension,
  arrivalFlashExtension,
  blockSelectionExtension,
];

/**
 * A document on its way: the prose shape it will land in.
 *
 * Distinct from `blank` below, and the distinction is honesty — this one says
 * "something is coming", so it must only be shown where something is.
 */
const loading = (
  <div className="min-h-[40vh]" aria-busy="true">
    <EditorSkeleton />
  </div>
);

/**
 * Room where a document would be, and nothing else. For the one case that is
 * not loading at all: a viewer looking at a page nobody has written yet. A
 * shimmer there would promise words that are never going to arrive.
 */
const blank = <div className="min-h-[40vh]" aria-hidden />;

/**
 * Development only, and it brings the whole op/projection stack with it — so
 * it is fetched when a dev opens it rather than shipped with the editor.
 */
const SubstrateHarness = dynamic(
  () => import("./ai/SubstrateHarness").then((m) => m.SubstrateHarness),
  { ssr: false },
);

/**
 * The block editor for a single page — a dispatcher over two sync pipelines.
 *
 * Every doc lives on exactly one: the reactive `state` query says which, and
 * a doc still on the legacy pipeline is migrated on first open by anyone with
 * the pen (viewers keep reading it live through the old path until then; the
 * same reactivity flips them over the moment it moves). The editor itself,
 * its chrome and its AI layer are identical either way — only how the
 * document reaches it differs.
 */
export function Editor(props: EditorProps) {
  const readOnly = useReadOnly();
  /*
   * `meta` rather than `state` is the first question asked, because for a Yjs
   * doc — which by now is nearly all of them — it is the ONLY question: a
   * non-null answer means there is a `ydocs` row, which is exactly what
   * `state` would have reported. It is also the query the provider opens with,
   * so by the time this renders the editor that fetch is already answered from
   * the client's cache and the document's bytes are the next round trip rather
   * than the third. `state` is still asked, but only where `meta` cannot tell
   * legacy from never-written.
   */
  const meta = useQuery(api.ydoc.meta, YJS_ON ? { docId: props.docId } : "skip");
  const state = useQuery(
    api.ydoc.state,
    YJS_ON && meta === null ? { docId: props.docId } : "skip",
  );
  if (!YJS_ON) return <LegacyEditor {...props} />;
  if (meta === undefined) return loading;
  if (meta !== null) return <YjsEditor {...props} />;
  // No `ydocs` row: legacy or never-written, and only `state` tells them apart.
  if (state === undefined) return loading;
  if (state === "yjs") return <YjsEditor {...props} />;
  if (readOnly) {
    return state === "legacy" ? <LegacyEditor {...props} /> : blank;
  }
  return <BecomeYjs docId={props.docId} state={state} />;
}

/**
 * Runs the one-way move (or, for a never-opened doc, the plain birth) and
 * renders nothing: the `state` flip is what remounts the real editor, here
 * and in every other tab with the page open.
 */
const migrating = new Set<string>();
function BecomeYjs({ docId, state }: { docId: string; state: "legacy" | "empty" }) {
  const convex = useConvex();
  useEffect(() => {
    if (migrating.has(docId)) return;
    migrating.add(docId);
    const run = state === "legacy" ? migrateLegacyDoc : initEmptyYDoc;
    run(convex, docId).finally(() => migrating.delete(docId));
  }, [convex, docId, state]);
  return loading;
}

function YjsEditor({ docId, pageId, title = "", mode = "create" }: EditorProps) {
  const { user } = useUser();
  const { editor } = useYjsEditor<EditorInstance>({
    docId,
    user: {
      name: user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "Someone",
      color: collabColor(user?.id ?? "anonymous"),
      ...(user?.imageUrl ? { imageUrl: user.imageUrl } : {}),
    },
    editorOptions: { schema, extensions: EXTENSIONS },
  });
  if (!editor) return loading;
  return (
    <EditorSurface
      editor={editor}
      docId={docId}
      pipeline="yjs"
      pageId={pageId}
      title={title}
      mode={mode}
    />
  );
}

function LegacyEditor({ docId, pageId, title = "", mode = "create" }: EditorProps) {
  const readOnly = useReadOnly();
  const sync = useBlockNoteSync<EditorInstance>(api.prosemirror, docId, {
    editorOptions: { schema, extensions: EXTENSIONS },
  });

  // First open of a page has no document yet — create an empty one seamlessly.
  // Guarded per-docId so StrictMode's double-invoke can't create twice. A
  // viewer never creates one: they may only be here to read. (Under the flag,
  // a brand-new doc is born on the Yjs side instead and never reaches here.)
  const createdFor = useRef<string | null>(null);
  useEffect(() => {
    if (readOnly || YJS_ON) return;
    if (!sync.isLoading && !sync.editor && createdFor.current !== docId) {
      createdFor.current = docId;
      void sync.create({ type: "doc", content: [] });
    }
  }, [sync, docId, readOnly]);

  if (!sync.editor) return loading;
  return (
    <EditorSurface
      editor={sync.editor}
      docId={docId}
      pipeline="legacy"
      pageId={pageId}
      title={title}
      mode={mode}
    />
  );
}

/** Everything above the transport: chrome, menus, and the AI layer. */
function EditorSurface({
  editor,
  docId,
  pipeline,
  pageId,
  title,
  mode,
}: {
  editor: EditorInstance;
  docId: string;
  pipeline: "legacy" | "yjs";
  pageId?: Id<"pages">;
  title: string;
  mode: PageMode;
}) {
  const pages = usePages();
  // A viewer-role workspace: same document, none of the authoring. The context
  // also reaches the custom blocks, which disable themselves through it.
  const readOnly = useReadOnly();

  useRegisterEditor(pageId, editor, docId, pipeline);
  useTabCompletion(readOnly ? null : editor, pageId, title, mode, docId);
  const reformat = useReformat(readOnly ? null : editor, pageId);

  // The band starts in the page's gutter, which is outside the
  // contenteditable — so it is heard on a layout-neutral wrapper that reaches
  // back over that strip rather than on the editor itself.
  const marqueeSurface = useRef<HTMLDivElement>(null);
  const selected = readOnly ? null : blockSelection(editor);
  useBlockMarquee({
    surfaceRef: marqueeSurface,
    selection: selected,
    enabled: !readOnly,
  });

  /**
   * A drag THROUGH prose is ProseMirror's own text selection, and the moment
   * it crosses a block boundary what was drawn is a range of blocks. Promoting
   * it here is what makes block selection reachable by the gesture people
   * actually perform; the band covers only the other half, starting out in the
   * margin where there is no text to drag through.
   *
   * On the next frame, because the DOM selection settles after mouseup and
   * reading it in the handler reads the previous one.
   */
  const promoteSpanned = () => {
    if (!selected) return;
    requestAnimationFrame(() => selected.selectSpannedBlocks());
  };

  return (
    <PageTitleProvider value={title}>
      <div
        ref={marqueeSurface}
        className="nt-marquee-surface"
        onMouseUp={promoteSpanned}
      >
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme="light"
          className="nt-editor"
          sideMenu={false}
          slashMenu={false}
          formattingToolbar={false}
        >
          {!readOnly && (
            <>
              <BlockSideMenu />
              <FormattingToolbarController formattingToolbar={Toolbar} />
              <SuggestionMenuController
                triggerCharacter="/"
                floatingUIOptions={menuPlacement}
                suggestionMenuComponent={SlashMenu}
                getItems={async (query) =>
                  filterItems(groupAdjacent(slashItems(editor)), query)
                }
              />
              <SuggestionMenuController
                triggerCharacter="@"
                floatingUIOptions={menuPlacement}
                getItems={async (query) =>
                  filterItems(mentionItems(editor, pages ?? []), query)
                }
              />
            </>
          )}
        </BlockNoteView>
      </div>
      {!readOnly && pageId && <ReviewOverlay editor={editor} pageId={pageId} />}
      {!readOnly && reformat.state && (
        <ReformatBar
          editor={editor}
          state={reformat.state}
          onAccept={reformat.accept}
          onDismiss={reformat.dismiss}
          onCycle={reformat.cycle}
        />
      )}
      {process.env.NODE_ENV !== "production" && !readOnly && pageId && (
        <SubstrateHarness editor={editor} pageId={pageId} />
      )}
    </PageTitleProvider>
  );
}
