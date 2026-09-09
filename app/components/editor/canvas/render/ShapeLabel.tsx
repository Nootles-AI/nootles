"use client";

/**
 * A shape's label, in both of its lives.
 *
 * `LabelContent` is the label at rest: its blocks and runs (see
 * `scene/label.ts`) as the elements they are, with any page reference as a
 * chip that opens the page. `LabelEdit` is the label open for editing: the
 * same blocks poured into a contentEditable, chips as atomic (non-editable)
 * islands, an "@" menu that inserts one — the same grammar the chat composer
 * speaks, against the same page list — and the marks a hand expects from ⌘B,
 * ⌘I and ⌘U, through the browser's own editing so what is committed is what
 * was typed.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { createPortal } from "react-dom";
import type { Id } from "@/convex/_generated/dataModel";
import {
  filterMentions,
  mentionTrigger,
  type MentionItem,
  type MentionTrigger,
} from "@/app/lib/ai/chat/mentions";
import { track } from "@/app/lib/telemetry";
import { FILE_DOC_PATHS, FileDoc } from "../../../Icons";
import { MentionMenu } from "../../../MentionMenu";
import { useCurrentPage, useOpenPageOptional } from "../../../OpenPageContext";
import { usePages } from "../../../PagesContext";
import {
  labelBlocks,
  labelOfElement,
  type LabelBlock,
  type LabelRun,
  type LabelStyle,
} from "../scene/label";
import { formatMark, registerLabelEditor } from "./labelEditing";

const chipTitle = (title: string) => title.trim() || "Untitled";

/** `font-size` → `fontSize`, for a run's inline style. */
function cssObject(style: LabelStyle): CSSProperties {
  const out: Record<string, string> = {};
  for (const prop in style) {
    out[prop.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = style[prop];
  }
  return out as CSSProperties;
}

/** True when the blocks are more than one bare paragraph. */
const isRich = (blocks: LabelBlock[]) =>
  blocks.length > 1 || blocks[0].kind !== "p" || blocks[0].style !== undefined;

// ---------------------------------------------------------------------------
// At rest
// ---------------------------------------------------------------------------

/** A run, wrapped in its marks from the inside out, so nesting is the grammar's. */
function RunView({ run }: { run: LabelRun & { kind: "text" } }) {
  let el: ReactNode = run.text;
  const { marks } = run;
  if (marks.strike) el = <s>{el}</s>;
  if (marks.underline) el = <u>{el}</u>;
  if (marks.italic) el = <i>{el}</i>;
  if (marks.bold) el = <b>{el}</b>;
  if (marks.style) el = <span style={cssObject(marks.style)}>{el}</span>;
  if (marks.href) {
    el = (
      <a
        href={marks.href}
        target="_blank"
        rel="noopener noreferrer"
        // A press on a link is a visit, not a shape selection or a drag.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {el}
      </a>
    );
  }
  return <>{el}</>;
}

function RunsView({ runs, onEdit }: { runs: LabelRun[]; onEdit?: () => void }) {
  return (
    <>
      {runs.map((run, i) =>
        run.kind === "ref" ? (
          <PageChip key={i} pageId={run.pageId} title={run.title} onEdit={onEdit} />
        ) : (
          <RunView key={i} run={run} />
        ),
      )}
    </>
  );
}

/** Blocks as `<p>`s, with consecutive items of one list under one `<ul>`/`<ol>`. */
function BlocksView({ blocks, onEdit }: { blocks: LabelBlock[]; onEdit?: () => void }) {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === "li") {
      const list = block.list ?? "ul";
      const items: ReactNode[] = [];
      while (i < blocks.length && blocks[i].kind === "li" && (blocks[i].list ?? "ul") === list) {
        const item = blocks[i];
        items.push(
          <li key={i} style={item.style ? cssObject(item.style) : undefined}>
            <RunsView runs={item.runs} onEdit={onEdit} />
          </li>,
        );
        i += 1;
      }
      const List = list;
      out.push(<List key={`list-${i}`}>{items}</List>);
      continue;
    }
    out.push(
      <p key={i} style={block.style ? cssObject(block.style) : undefined}>
        <RunsView runs={block.runs} onEdit={onEdit} />
      </p>,
    );
    i += 1;
  }
  return <>{out}</>;
}

export function LabelContent({
  label,
  clamp,
  onEdit,
}: {
  label: string;
  /** The shape's `-webkit-line-clamp`, applied to the label rather than the box. */
  clamp?: string;
  /** Open this label for editing — the shape's own double-click, offered. */
  onEdit?: () => void;
}) {
  const blocks = useMemo(() => labelBlocks(label), [label]);
  const runs = blocks.flatMap((block) => block.runs);
  // A label that IS a chip leaves no words beside it to click for editing, so
  // there the chip offers the choice instead of navigating outright.
  const solo =
    runs.filter((run) => run.kind === "ref").length === 1 &&
    runs.every((run) => run.kind === "ref" || run.text.trim() === "");
  const edit = solo ? onEdit : undefined;
  const lines = clamp ? Number.parseInt(clamp, 10) : 0;
  const rich = isRich(blocks);
  return (
    // One wrapper span, not a fragment: the shape is a flex container, and a
    // fragment would hand it every run — each chip and each <b> — as its own
    // flex item, laid out side by side. One span is one item, exactly as the
    // plain text node was, and the runs flow as inline content inside it.
    // The class is the hook remote label carets resolve against (`presence`).
    <span
      className={`nt-label${rich ? " nt-label-blocks" : ""}${lines > 0 ? " is-clamped" : ""}`}
      style={lines > 0 ? { WebkitLineClamp: lines } : undefined}
    >
      {rich ? <BlocksView blocks={blocks} onEdit={edit} /> : <RunsView runs={runs} onEdit={edit} />}
    </span>
  );
}

function PageChip({
  pageId,
  title,
  onEdit,
}: {
  pageId: string;
  title: string;
  onEdit?: () => void;
}) {
  const pages = usePages();
  const openPage = useOpenPageOptional();
  const here = useCurrentPage();
  const live = pages?.find((p) => p._id === pageId);
  const [menu, setMenu] = useState<{ left: number; bottom: number } | null>(null);

  const go = openPage
    ? () => openPage.follow(pageId as Id<"pages">, here)
    : undefined;

  return (
    <span
      className="nt-ref"
      // The press must not select the shape or start a drag — the chip is a
      // destination, not a handle. Double-click still bubbles, so entering the
      // label for editing works from the chip too.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={
        go
          ? (e) => {
              e.stopPropagation();
              if (!onEdit) {
                go();
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ left: rect.left, bottom: rect.bottom });
            }
          : undefined
      }
    >
      <FileDoc className="nt-ref-icon" aria-hidden />
      {chipTitle(live?.title ?? title)}
      {menu && go && onEdit && (
        <ChipMenu
          at={menu}
          onGo={go}
          onEdit={onEdit}
          onClose={() => setMenu(null)}
        />
      )}
    </span>
  );
}

/**
 * The choice a solo chip offers: follow it, or edit the words it lives in.
 * Portalled beside the chip; the `.nt-mention-anchor` wrapper is what the
 * canvas's outside-press listeners already treat as canvas chrome.
 */
function ChipMenu({
  at,
  onGo,
  onEdit,
  onClose,
}: {
  at: { left: number; bottom: number };
  onGo: () => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    // Capture-phase and non-swallowing: an outside press closes the menu and
    // still does whatever it was for.
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".nt-chip-menu")) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      className="nt-mention-anchor"
      style={{ left: at.left, top: at.bottom + 6, width: 180 }}
      onPointerDown={stop}
      // A portal's events still bubble through the React tree — without this,
      // a pick would reach the chip's own onClick and reopen the menu.
      onClick={stop}
      onDoubleClick={stop}
    >
      <div role="menu" aria-label="Page reference" className="nt-menu nt-chip-menu">
        <button
          role="menuitem"
          className="nt-menu-item"
          onClick={() => {
            onClose();
            onGo();
          }}
        >
          Go to page
        </button>
        <button
          role="menuitem"
          className="nt-menu-item"
          onClick={() => {
            onClose();
            onEdit();
          }}
        >
          Edit text
        </button>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Under edit
// ---------------------------------------------------------------------------

/** What the menu renders from: the query and where on screen the "@…" is. */
type Menu = { query: string; left: number; bottom: number };

/** Where the "@…" lives in the DOM — a handle, not render state. */
type Spot = { node: Text; trigger: MentionTrigger; caret: number };

const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * The chip as the label editor builds it — the same glyph-then-title the
 * rendered chip shows, but as plain DOM: the browser owns the editable span,
 * so React must not have opinions about its children. The commit reads the
 * `data-` attributes, never this markup.
 */
function chipEl(pageId: string, title: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "nt-ref";
  chip.contentEditable = "false";
  chip.dataset.page = pageId;
  chip.dataset.title = title;
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "nt-ref-icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  for (const d of FILE_DOC_PATHS) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    icon.append(path);
  }
  chip.append(icon, document.createTextNode(chipTitle(title)));
  return chip;
}

/** A text run's DOM, wrapped in its marks from the inside out. */
function runEl(run: LabelRun & { kind: "text" }): Node {
  let node: Node = document.createTextNode(run.text);
  const wrap = (tag: string) => {
    const el = document.createElement(tag);
    el.append(node);
    node = el;
  };
  const { marks } = run;
  if (marks.strike) wrap("s");
  if (marks.underline) wrap("u");
  if (marks.italic) wrap("i");
  if (marks.bold) wrap("b");
  if (marks.style) {
    wrap("span");
    for (const prop in marks.style) (node as HTMLElement).style.setProperty(prop, marks.style[prop]);
  }
  if (marks.href) {
    wrap("a");
    (node as HTMLAnchorElement).href = marks.href;
  }
  return node;
}

function runsToDom(runs: LabelRun[]): Node[] {
  return runs.map((run) => (run.kind === "ref" ? chipEl(run.pageId, run.title) : runEl(run)));
}

/** The label's blocks as DOM, for seeding the editable. */
function blocksToDom(blocks: LabelBlock[]): Node[] {
  if (!isRich(blocks)) return runsToDom(blocks[0].runs);
  const out: Node[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.kind === "li") {
      const kind = block.list ?? "ul";
      const list = document.createElement(kind);
      while (i < blocks.length && blocks[i].kind === "li" && (blocks[i].list ?? "ul") === kind) {
        const item = document.createElement("li");
        const style = blocks[i].style;
        if (style) for (const prop in style) item.style.setProperty(prop, style[prop]);
        item.append(...runsToDom(blocks[i].runs));
        // An empty item still needs a line box to put the caret in.
        if (!blocks[i].runs.length) item.append(document.createElement("br"));
        list.append(item);
        i += 1;
      }
      out.push(list);
      continue;
    }
    const p = document.createElement("p");
    if (block.style) for (const prop in block.style) p.style.setProperty(prop, block.style[prop]);
    p.append(...runsToDom(block.runs));
    if (!block.runs.length) p.append(document.createElement("br"));
    out.push(p);
    i += 1;
  }
  return out;
}

/** The block the caret is in, if the label has blocks at all. */
function blockAtCaret(el: HTMLElement): HTMLElement | null {
  const node = window.getSelection()?.anchorNode;
  if (!node || !el.contains(node)) return null;
  const from = node.nodeType === 3 ? node.parentElement : (node as Element);
  const block = from?.closest("p, li");
  return block && el.contains(block) && block !== el ? (block as HTMLElement) : null;
}

/**
 * Start a new paragraph at the caret. A label that had none gets its words
 * wrapped in one first, so the split has a paragraph to split.
 */
function splitParagraph(el: HTMLElement) {
  if (!el.querySelector("p, li")) {
    const p = document.createElement("p");
    p.append(...Array.from(el.childNodes));
    el.append(p);
  }
  document.execCommand("insertParagraph");
}

export function LabelEdit({
  label,
  onEnd,
  onLive,
}: {
  label: string;
  onEnd: (label: string) => void;
  /**
   * The label as it stands mid-edit, on a short debounce — how collaborators
   * watch it being typed instead of having it appear whole on blur. The
   * caller brackets these into one undo entry; blur still commits.
   */
  onLive?: (label: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const pages = usePages();
  const [menu, setMenu] = useState<Menu | null>(null);
  const [active, setActive] = useState(0);
  const spot = useRef<Spot | null>(null);
  const menuId = useId();

  const items = useMemo<MentionItem[]>(() => {
    if (!menu || !pages) return [];
    return filterMentions(
      pages.map((page) => ({
        key: page._id,
        label: page.title.trim() || "Untitled",
        hint: "Page",
        pick: { kind: "page" as const, pageId: page._id, title: page.title },
      })),
      menu.query,
    );
  }, [menu, pages]);
  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));

  // React renders the editable element with no children and never touches its
  // content again: the blocks go in from here and the browser owns the DOM
  // from there until the edit commits. Reconciling React's idea of the label
  // against the nodes the browser made while typing is what duplicated the
  // text and detached a node out from under `removeChild`.
  //
  // Seeded from the label AS THE EDIT OPENED, exactly once: with live commits
  // streaming out mid-edit, the prop comes straight back changed, and
  // re-seeding on it would take the caret out from under the typing hand.
  const opened = useRef(label);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(...blocksToDom(labelBlocks(opened.current)));
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  // The mid-edit stream, debounced to word pace. Cancelled at commit: a timer
  // firing after the blur would dispatch outside the caller's bracket.
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (liveTimer.current) clearTimeout(liveTimer.current);
    },
    [],
  );
  const onInput = useCallback(() => {
    if (!onLive) return;
    if (liveTimer.current) clearTimeout(liveTimer.current);
    liveTimer.current = setTimeout(() => {
      if (ref.current) onLive(labelOfElement(ref.current));
    }, 250);
  }, [onLive]);

  // Offered to the style panel while open, so the section edits the selected
  // range the way Figma's does.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerLabelEditor(el, onInput);
  }, [onInput]);

  // The "@" being typed, read from wherever the caret is. `selectionchange`
  // covers typing, arrows and clicks alike, and a chip boundary splits the
  // text nodes, so the trigger can only see the words beside it.
  useEffect(() => {
    const read = () => {
      const el = ref.current;
      const selection = window.getSelection();
      const node = selection?.anchorNode;
      if (
        !el ||
        !selection?.isCollapsed ||
        !node ||
        node.nodeType !== 3 ||
        !el.contains(node)
      ) {
        spot.current = null;
        setMenu(null);
        return;
      }
      const caret = selection.anchorOffset;
      const trigger = mentionTrigger(node.textContent ?? "", caret);
      if (!trigger) {
        spot.current = null;
        setMenu(null);
        return;
      }
      if (spot.current?.trigger.query !== trigger.query) setActive(0);
      spot.current = { node: node as Text, trigger, caret };
      const range = document.createRange();
      range.setStart(node, trigger.start);
      range.setEnd(node, caret);
      const rect = range.getBoundingClientRect();
      setMenu({ query: trigger.query, left: rect.left, bottom: rect.bottom });
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);

  /** Replaces the "@…" being typed with a chip, and puts the caret after it. */
  const take = useCallback((item: MentionItem) => {
    if (!spot.current || item.pick.kind !== "page") return;
    const { node, trigger, caret } = spot.current;
    const text = node.textContent ?? "";
    const tail = text.slice(caret);
    node.textContent = text.slice(0, trigger.start);
    const chip = chipEl(item.pick.pageId, item.pick.title);
    // One space after it, whoever supplied it — same rule as the composer.
    const rest = document.createTextNode(
      ` ${tail.startsWith(" ") ? tail.slice(1) : tail}`,
    );
    node.after(chip, rest);
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(rest, 1);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    spot.current = null;
    setMenu(null);
    track("mention_inserted", { surface: "canvas" });
  }, []);

  // Natively, not through React. ProseMirror listens on its own element, which
  // sits between this one and the React root — so a synthetic stopPropagation
  // runs too late and the editor has already acted. ⌘A was reaching it as
  // "select the whole document", and the Backspace after it deleted the
  // diagram. The menu keys live here too, ahead of the blur-on-Enter.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const open = menu !== null && items.length > 0;
    const onKey = (event: KeyboardEvent) => {
      event.stopPropagation();
      if (open) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const step = event.key === "ArrowDown" ? 1 : -1;
          setActive(Math.min(Math.max(activeIndex + step, 0), items.length - 1));
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          take(items[activeIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setMenu(null);
          return;
        }
      }
      const mod = event.metaKey || event.ctrlKey;
      // The marks a hand expects, through the browser's own editing. The
      // commit reads them back as the grammar's tags whichever way the engine
      // wrote them.
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase();
        const mark =
          key === "b" ? "bold"
          : key === "i" ? "italic"
          : key === "u" ? "underline"
          : key === "x" && event.shiftKey ? "strike"
          : null;
        if (mark) {
          event.preventDefault();
          formatMark(mark);
          onInput();
          return;
        }
      }
      if (event.key === "Enter" && event.altKey) {
        // A new paragraph. Enter alone commits, as it always has on a label;
        // Shift+Enter is the browser's line break; this is Figma's third one.
        event.preventDefault();
        splitParagraph(el);
        onInput();
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        // Inside a list, Enter is the browser's own next item.
        if (blockAtCaret(el)?.tagName === "LI") return;
        event.preventDefault();
        // Blur commits, so both endings go through one path.
        el.blur();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        el.blur();
        return;
      }
      // Select all means all of THIS label. Left to the browser, ⌘A in an
      // inline editable reaches past it and selects the whole document.
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [menu, items, activeIndex, take, onInput]);

  // Through the same walker the grammar parser uses, so a ⌘B and a Shift+Enter
  // survive the commit exactly as they will survive the round trip.
  const commit = () => {
    if (liveTimer.current) clearTimeout(liveTimer.current);
    onEnd(ref.current ? labelOfElement(ref.current) : "");
  };

  return (
    <>
      <span
        ref={ref}
        className="nt-edit"
        contentEditable
        suppressContentEditableWarning
        onKeyUp={stop}
        onBeforeInput={stop}
        onInput={onInput}
        onPointerDown={stop}
        onDoubleClick={stop}
        onBlur={commit}
      />
      {menu !== null &&
        items.length > 0 &&
        createPortal(
          <div
            className="nt-mention-anchor"
            style={{ left: menu.left, top: menu.bottom + 6 }}
            // A press here is part of the label edit, not a canvas press. No
            // preventDefault: cancelling pointerdown would also cancel the
            // mousedown the menu picks rows with.
            onPointerDown={stop}
          >
            <MentionMenu
              id={menuId}
              items={items}
              active={activeIndex}
              onPick={take}
              onHover={setActive}
              className="nt-mention-caret"
            />
          </div>,
          document.body,
        )}
    </>
  );
}

