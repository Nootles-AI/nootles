"use client";

import {
  SideMenuController,
  BlockColorsItem,
  RemoveBlockItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
  useExtensionState,
} from "@blocknote/react";
import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import {
  detectOverflow,
  offset,
  type Middleware,
  type MiddlewareState,
} from "@floating-ui/react";
import type { SVGProps } from "react";

import { Plus } from "../Icons";

/* BlockNote's side menu is context-driven — it passes no block via props. The
   target comes from the side-menu extension's own state, which is what the
   built-in items read.

   It must NOT come from getTextCursorPosition(): code, math and diagram blocks
   hold no editable content, so a text cursor can never land in one. Asking for
   the cursor's block while hovering a code block returns a NEIGHBOUR, and the
   menu then deletes or duplicates that instead. The side-menu prop types are
   incomplete, hence the `Any` casts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/* ---- Geometry -----------------------------------------------------------
   The handle lives in the page's own left padding — `PageSurface` reserves
   24px below 640px and 56px above. Two 24px controls plus this gap is 52px,
   which clears the wide gutter; the narrow one cannot hold them, so the
   cluster is clamped into the pane and wears a backdrop instead of sitting
   naked on the words (see `gutterFit`). */
const GUTTER_GAP = 4;
/** Keeps the cluster off the pane's own edge. The wide gutter has to hold the
    whole budget — 24 + 24 of controls, the gap, and this — inside its 56px, or
    every block would come up clamped. */
const EDGE_PAD = 2;
/* A block taller than this is a code block, an image or a diagram: align to
   the top of it rather than its middle. Sized to clear an h1's line box, so a
   heading still centres on its text the way a paragraph does. */
const MAX_ALIGN_SPAN = 56;

/** The block element the handle is positioned against. */
function anchorOf(state: MiddlewareState): HTMLElement | null {
  const reference = state.elements.reference;
  if (reference instanceof HTMLElement) return reference;
  const context = "contextElement" in reference ? reference.contextElement : undefined;
  return context instanceof HTMLElement ? context : null;
}

/** First line box of the block's OWN text — not a nested child block's, and
    not an image caption's. Null when the block holds no editable text at all,
    which is every code block, diagram and image. */
function firstLineBox(anchor: Element): DOMRect | null {
  const inline = anchor.querySelector(
    ":scope > .bn-inline-content, .bn-block-content > .bn-inline-content",
  );
  if (!inline) return null;
  const range = document.createRange();
  range.selectNodeContents(inline);
  const rects = range.getClientRects();
  for (let i = 0; i < rects.length; i++) {
    if (rects[i].height > 0) return rects[i];
  }
  return inline.getBoundingClientRect();
}

/* The floating element is absolutely positioned against an ancestor OUTSIDE
   the pane's scroller, so nothing clips it — a handle in a narrow column would
   otherwise float over the sidebar. Resolved once per block. */
const clippers = new WeakMap<Element, Element | null>();
function clipperOf(el: Element): Element | null {
  const known = clippers.get(el);
  if (known !== undefined) return known;
  let node = el.parentElement;
  let found: Element | null = null;
  while (node && node !== document.body) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      found = node;
      break;
    }
    node = node.parentElement;
  }
  clippers.set(el, found);
  return found;
}

/** Idempotent: this runs on every scroll frame, and a redundant write still
    costs a style invalidation. */
function flag(el: Element, name: string, on: boolean) {
  if (on === el.hasAttribute(name)) return;
  if (on) el.setAttribute(name, "");
  else el.removeAttribute(name);
}

/** The block each mounted handle was last placed against, and how long its
    glide has left to run — see `data-nt-slide`. Mirrors `--dur`. */
const SLIDE_MS = 170;
const placedAgainst = new WeakMap<HTMLElement, Element>();
const slideUntil = new WeakMap<HTMLElement, number>();

/**
 * Everything the stock controller leaves undone, in one pass over the position
 * it already computed:
 *
 * - centres the cluster on the block's FIRST LINE. BlockNote instead ships a
 *   fixed menu height per block type (108px for an h1), tuned for its own 16px
 *   base — against our 15px an h1 measures ~91px, a permanent overhang.
 * - clamps it into the pane so a narrow column cannot throw it over the
 *   sidebar, marking `data-nt-tight` when it had to.
 * - hides it once the block has scrolled past the pane's edge, which is the
 *   job BlockNote does by dismissing the menu on any ancestor scroll — and
 *   which flickers the handle out from under a stationary cursor.
 * - marks `data-nt-slide` only when the target block CHANGED, so the handle
 *   glides between blocks without trailing the text during a scroll.
 */
const gutterFit: Middleware = {
  name: "ntGutterFit",
  async fn(state) {
    const floating = state.elements.floating;
    const anchor = anchorOf(state);
    if (!anchor) return {};

    /* Armed for the length of the glide, not for a single pass: autoUpdate
       fires again the moment it re-observes the new block, and disarming on
       that pass would cancel the transition it had just started. */
    const previous = placedAgainst.get(floating);
    placedAgainst.set(floating, anchor);
    const now = performance.now();
    if (previous !== undefined && previous !== anchor) {
      slideUntil.set(floating, now + SLIDE_MS);
    }
    flag(floating, "data-nt-slide", (slideUntil.get(floating) ?? 0) > now);

    /* Short blocks centre on themselves. Taller ones centre on their first
       line of text — a heading's, a wrapped paragraph's — and anything with no
       line near its top (a diagram, an image and its caption) aligns to the
       top instead, where the block starts. */
    const box = anchor.getBoundingClientRect();
    let centre = box.top + box.height / 2;
    if (box.height > MAX_ALIGN_SPAN) {
      const line = firstLineBox(anchor);
      centre =
        line && line.top - box.top <= MAX_ALIGN_SPAN
          ? line.top + Math.min(line.height, MAX_ALIGN_SPAN) / 2
          : box.top + MAX_ALIGN_SPAN / 2;
    }
    const y = state.y + (centre - box.top) - state.rects.floating.height / 2;

    const clipper = clipperOf(anchor);
    const overflow = clipper
      ? await detectOverflow({ ...state, y }, { boundary: clipper, padding: EDGE_PAD })
      : null;
    const nudge = overflow ? Math.max(overflow.left, 0) : 0;
    flag(floating, "data-nt-tight", nudge > 0);
    flag(
      floating,
      "data-nt-offscreen",
      overflow !== null && (overflow.top > 0 || overflow.bottom > 0),
    );
    /* Whether the block under the handle is part of a block selection. The
       cluster otherwise paints its own paper over the selection plate, which
       reads as a hole punched in the very thing it is standing on. Read off the
       DOM rather than the store: this already has the block element, and the
       class is the same fact. */
    flag(
      floating,
      "data-nt-selected",
      !!anchor.closest?.(".nt-block-selected"),
    );

    return { x: state.x + nudge, y };
  },
};

/** Position tracking without BlockNote's hide-on-scroll, which blinks. */
const trackOnly = () => () => {};

const floatingUIOptions = {
  useFloatingOptions: {
    middleware: [offset(GUTTER_GAP), gutterFit],
    whileElementsMounted: trackOnly,
  },
  elementProps: {
    className: "nt-side-menu-anchor",
    // Below the app's menus, above the document. BlockNote hardcodes 20, which
    // is `--z-dropdown` exactly — the drag menu and the handle would tie.
    style: { zIndex: "var(--nt-z-block-handle)" },
  },
};

/** The one icon the app's set is missing. Same 24-unit grid, same 2px stroke,
    same ring-as-dot idiom as `MoreHorizontal`, so it sits beside `Plus`. */
function Grip(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  );
}

/** The blocks an action applies to: the whole selection when the hovered block
    is inside it, otherwise just that block. BlockNote's own Delete resolves it
    this way; Duplicate and Copy have to agree with it or the menu contradicts
    itself between two adjacent lines. */
function targetBlocks(editor: Any, block: Any): Any[] {
  const selection = editor.getSelection()?.blocks as Any[] | undefined;
  return selection?.some((b: Any) => b.id === block.id) ? selection : [block];
}

/** Ids are stripped all the way down, so a duplicated list does not hand its
    children's ids to the copy. */
function withoutIds(block: Any): Any {
  const { id: _id, children, ...rest } = block;
  return children ? { ...rest, children: children.map(withoutIds) } : rest;
}

function duplicateBlocks(editor: Any, blocks: Any[]) {
  editor.insertBlocks(blocks.map(withoutIds), blocks[blocks.length - 1], "after");
}

async function copyBlocks(editor: Any, blocks: Any[]) {
  const [html, md] = await Promise.all([
    editor.blocksToHTMLLossy(blocks),
    editor.blocksToMarkdownLossy(blocks),
  ]);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([md], { type: "text/plain" }),
    }),
  ]);
}

function AddBlockButton({ block }: { block: Any }) {
  const editor = useBlockNoteEditor() as Any;
  const suggestions = useExtension(SuggestionMenu);

  /* An empty block takes the menu where it stands; anything else gets a fresh
     paragraph below it first, so the caret lands where the new block will. */
  const insert = () => {
    const isEmpty = Array.isArray(block.content) && block.content.length === 0;
    const target = isEmpty
      ? block
      : editor.insertBlocks([{ type: "paragraph" }], block, "after")[0];
    editor.setTextCursorPosition(target);
    suggestions.openSuggestionMenu("/");
  };

  return (
    <button
      type="button"
      className="nt-icon-btn is-sm nt-block-handle"
      aria-label="Insert a block below"
      onClick={insert}
    >
      <Plus />
    </button>
  );
}

function DragHandleButton({ block }: { block: Any }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const sideMenu = useExtension(SideMenuExtension);

  return (
    <Components.Generic.Menu.Root
      position="left"
      onOpenChange={(open: boolean) =>
        open ? sideMenu.freezeMenu() : sideMenu.unfreezeMenu()
      }
    >
      <Components.Generic.Menu.Trigger>
        {/* draggable and onClick both live on the BUTTON. BlockNote hangs the
            add button's onClick off its icon instead, so two controls that
            look identical answer to different hit areas. */}
        <button
          type="button"
          className="nt-icon-btn is-sm nt-block-handle"
          aria-label="Block actions"
          draggable
          onDragStart={(e) => sideMenu.blockDragStart(e, block)}
          onDragEnd={() => sideMenu.blockDragEnd()}
        >
          <Grip />
        </button>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown
        className="bn-menu-dropdown bn-drag-handle-menu"
      >
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          onClick={() => duplicateBlocks(editor, targetBlocks(editor, block))}
        >
          Duplicate
        </Components.Generic.Menu.Item>
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          onClick={() => void copyBlocks(editor, targetBlocks(editor, block))}
        >
          Copy
        </Components.Generic.Menu.Item>
        <BlockColorsItem>Colors</BlockColorsItem>
        {/* BlockNote's own item — it also removes a whole multi-block selection
            when the hovered block is part of one. */}
        <RemoveBlockItem>Delete</RemoveBlockItem>
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
}

/* Module scope, deliberately. The controller renders `<Component />` from the
   `sideMenu` prop, so an inline arrow would be a new component type on every
   render — React tears the subtree down and rebuilds it for each block, and
   nothing that is remounted can transition. */
function SideMenuBody() {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (s) => s?.block,
  }) as Any;

  if (!block) return null;

  /* `bn-side-menu` is kept only because BlockNote hangs the drag menu's item
     metrics off it. Its own per-block-type heights — the ones that left an
     invisible 84px box over the gutter below a heading — are overridden in
     editor.css, where pointer-events also settle what may be clicked. */
  return (
    <div className="nt-block-handles bn-side-menu">
      <AddBlockButton block={block} />
      <DragHandleButton block={block} />
    </div>
  );
}

export function BlockSideMenu() {
  return (
    <SideMenuController
      sideMenu={SideMenuBody}
      floatingUIOptions={floatingUIOptions}
    />
  );
}
