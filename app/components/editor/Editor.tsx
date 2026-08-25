"use client";

import dynamic from "next/dynamic";
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
import { useReadOnly } from "./readOnly";
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
      title: "Storyboard",
      subtext: "Shot frames with room to write underneath",
      aliases: [
        "storyboard", "board", "shots", "frames", "panels", "scene",
        "film", "sequence", "shotlist", "previs",
      ],
      group: "Canvas",
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
      group: "Media",
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
      group: "Media",
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
      group: "Media",
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
      group: "Media",
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
];

const placeholder = <div className="min-h-[40vh]" aria-hidden />;

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
  const state = useQuery(
    api.ydoc.state,
    YJS_ON ? { docId: props.docId } : "skip",
  );
  if (!YJS_ON || (state === "legacy" && readOnly)) {
    return <LegacyEditor {...props} />;
  }
  if (state === undefined) return placeholder;
  if (state === "yjs") return <YjsEditor {...props} />;
  if (readOnly) return placeholder;
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
  return placeholder;
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
  if (!editor) return placeholder;
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

  if (!sync.editor) return placeholder;
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

  return (
    <PageTitleProvider value={title}>
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
              getItems={async (query) =>
                filterItems(
                  groupAdjacent(
                    [
                      // The stock Audio and Video items still qualify against
                      // our block specs; our Media item replaces both.
                      ...getDefaultReactSlashMenuItems(editor).filter(
                        (item) =>
                          item.title !== editor.dictionary.slash_menu.audio.title &&
                          item.title !== editor.dictionary.slash_menu.video.title,
                      ),
                      ...customSlashItems(editor),
                    ].map((item) =>
                      // The menu keys section labels and item titles in one
                      // list, so a group named exactly like our Media item
                      // would be its duplicate key. "Media blocks" also reads
                      // like the stock "Basic blocks" section.
                      item.group === editor.dictionary.slash_menu.image.group
                        ? { ...item, group: "Media blocks" }
                        : item,
                    ),
                  ),
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
          </>
        )}
      </BlockNoteView>
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
