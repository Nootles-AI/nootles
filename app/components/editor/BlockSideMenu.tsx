"use client";

import {
  SideMenuController,
  BlockColorsItem,
  RemoveBlockItem,
  useBlockNoteEditor,
  useComponentsContext,
  useExtension,
  useExtensionState,
  type PortalElementsMap,
} from "@blocknote/react";
import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import {
  detectOverflow,
  offset,
  type Middleware,
  type MiddlewareState,
} from "@floating-ui/react";
import { useEffect, type ReactElement, type SVGProps } from "react";
import { effectiveScale, onScaleWithin } from "@/app/lib/columnScale";

import * as Icon from "../Icons";
import { duplicateAndSelect } from "./blockKeys";
import { blockSelection } from "./blockSelection";
import {
  TURN_INTO,
  canTurnInto,
  isCurrentType,
  turnIntoUpdate,
  type TurnIntoTarget,
} from "./turnInto";

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
   The handle lives in the page's own left padding — the column's gutter,
   56px unless the pane is narrower than `NARROW_BREAKPOINT`, then 24px.
   Two 24px controls plus this gap is 52px, which clears the wide gutter; the
   narrow one cannot hold them, so the cluster is clamped into the pane and
   wears a backdrop instead of sitting naked on the words (see `gutterFit`).

   The cluster is portalled to the body and never zoomed; the page under it
   may be. So the gutter it measures against is in client px, and the block
   heights it compares are scaled into them. */
const GUTTER_GAP = 4;
/** Keeps the cluster off the pane's own edge. The wide gutter has to hold the
    whole budget — 24 + 24 of controls, the gap, and this — inside its 56px, or
    every block would come up clamped. */
const EDGE_PAD = 2;
/* A block taller than this is a code block, an image or a diagram: align to
   the top of it rather than its middle. Sized to clear an h1's line box, so a
   heading still centres on its text the way a paragraph does. In the page's
   own px — scaled by its zoom before it meets a client rect. */
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
const SLIDE_MS = 145;
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
    const span = MAX_ALIGN_SPAN * effectiveScale(anchor);
    let centre = box.top + box.height / 2;
    if (box.height > span) {
      const line = firstLineBox(anchor);
      centre =
        line && line.top - box.top <= span
          ? line.top + Math.min(line.height, span) / 2
          : box.top + span / 2;
    }
    const y = state.y + (centre - box.top) - state.rects.floating.height / 2;
    const reach = wideReach(anchor, box);
    const x = state.x + reach;
    flag(floating, "data-nt-reach", reach < 0);

    const clipper = clipperOf(anchor);
    const overflow = clipper
      ? await detectOverflow({ ...state, x, y }, { boundary: clipper, padding: EDGE_PAD })
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

    return { x: x + nudge, y };
  },
};

/** How far past the block's left edge its own wide diagram reaches — where its handle belongs. */
function wideReach(anchor: Element, box: DOMRect): number {
  const content = anchor.matches(".bn-block-content") ? anchor : anchor.querySelector(".bn-block-content");
  const band = content?.querySelector(".nt-canvas[data-wide]:not(.nt-canvas-shot)");
  return band ? Math.min(0, band.getBoundingClientRect().left - box.left) : 0;
}

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

const TURN_INTO_ICONS: Record<string, (props: SVGProps<SVGSVGElement>) => ReactElement> = {
  text: Icon.Paragraph,
  h1: Icon.Heading1,
  h2: Icon.Heading2,
  h3: Icon.Heading3,
  bullet: Icon.BulletList,
  numbered: Icon.NumberedList,
  todo: Icon.TodoList,
  toggle: Icon.ToggleList,
  quote: Icon.Quote,
  code: Icon.CodeBlock,
};

/** One step for the whole selection, which stays selected after — the plate
    is what says which blocks just changed. */
function turnBlocksInto(editor: Any, blocks: Any[], target: TurnIntoTarget) {
  const turnable = blocks.filter(canTurnInto);
  editor.transact(() => {
    for (const block of turnable) editor.updateBlock(block, turnIntoUpdate(block, target));
  });
  blockSelection(editor).select(blocks.map((block) => block.id));
}

function TurnIntoItem({ block }: { block: Any }) {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  if (!canTurnInto(block)) return null;

  return (
    <Components.Generic.Menu.Root position="right" sub>
      <Components.Generic.Menu.Trigger sub>
        <Components.Generic.Menu.Item className="bn-menu-item" subTrigger>
          Turn into
        </Components.Generic.Menu.Item>
      </Components.Generic.Menu.Trigger>
      <Components.Generic.Menu.Dropdown sub className="bn-menu-dropdown nt-turn-into-menu">
        {TURN_INTO.map((target) => {
          const Glyph = TURN_INTO_ICONS[target.key];
          return (
            <Components.Generic.Menu.Item
              key={target.key}
              className="bn-menu-item"
              icon={<Glyph />}
              checked={isCurrentType(block, target)}
              onClick={() => turnBlocksInto(editor, targetBlocks(editor, block), target)}
            >
              {target.label}
            </Components.Generic.Menu.Item>
          );
        })}
      </Components.Generic.Menu.Dropdown>
    </Components.Generic.Menu.Root>
  );
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
      <Icon.Plus />
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
          onClick={() =>
            duplicateAndSelect(
              editor as Any,
              targetBlocks(editor, block).map((target) => target.id),
            )
          }
        >
          Duplicate
        </Components.Generic.Menu.Item>
        <Components.Generic.Menu.Item
          className="bn-menu-item"
          onClick={() => void copyBlocks(editor, targetBlocks(editor, block))}
        >
          Copy
        </Components.Generic.Menu.Item>
        <TurnIntoItem block={block} />
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

/**
 * Mount BlockNote's OWN portal container at body level. This keeps every
 * floating control outside Workspace's isolated document column while
 * retaining the `.bn-root`/`.bn-mantine` theme scope BlockNote applies to that
 * container. More importantly, `editor.isWithinEditor()` recognizes this
 * exact element. A separate lookalike host does not belong to the editor, so a
 * drag beginning on its gutter grip is treated as an external paste and its
 * stable block ID is replaced (NT-55).
 */
export const editorPortalElements: PortalElementsMap = { default: null };

export function BlockSideMenu() {
  const editor = useBlockNoteEditor();
  const sideMenu = useExtension(SideMenuExtension);
  // Placement tracks the pointer, not the page, so after a zoom the handle
  // would stand where its block used to be until the next move.
  useEffect(
    () => onScaleWithin(() => editor.domElement, () => sideMenu.hideMenuIfNotFrozen()),
    [editor, sideMenu],
  );
  // BlockNote lets the menu go once the pointer is 250px from the text, and a
  // wide diagram's handle stands past its band's edge, further out than that:
  // it vanished under the pointer reaching for it. Over that handle the
  // pointer's moves are BlockNote's business no longer — they would only ever
  // say "still here". Window capture runs ahead of its document listener.
  useEffect(() => {
    const keep = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-nt-reach]")) {
        event.stopPropagation();
      }
    };
    window.addEventListener("mousemove", keep, true);
    return () => window.removeEventListener("mousemove", keep, true);
  }, []);
  return (
    <SideMenuController
      sideMenu={SideMenuBody}
      floatingUIOptions={floatingUIOptions}
    />
  );
}
