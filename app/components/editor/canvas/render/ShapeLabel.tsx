"use client";

/**
 * A shape's label, in both of its lives.
 *
 * `LabelContent` is the label at rest: its runs (see `scene/label.ts`) as text,
 * with any page reference as a chip that opens the page. `LabelEdit` is the
 * label open for editing: the same runs poured into a contentEditable span,
 * chips as atomic (non-editable) islands, and an "@" menu that inserts one —
 * the same grammar the chat composer speaks, against the same page list.
 */

import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
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
import { MentionMenu } from "../../../MentionMenu";
import { useCurrentPage, useOpenPageOptional } from "../../../OpenPageContext";
import { usePages } from "../../../PagesContext";
import { labelRuns, refToLabel, textToLabel } from "../scene/label";

const chipText = (title: string) => `@${title.trim() || "Untitled"}`;

export function LabelContent({ label }: { label: string }) {
  const runs = useMemo(() => labelRuns(label), [label]);
  return (
    <>
      {runs.map((run, i) =>
        run.kind === "text" ? (
          <Fragment key={i}>{run.text}</Fragment>
        ) : (
          <PageChip key={i} pageId={run.pageId} title={run.title} />
        ),
      )}
    </>
  );
}

function PageChip({ pageId, title }: { pageId: string; title: string }) {
  const pages = usePages();
  const openPage = useOpenPageOptional();
  const here = useCurrentPage();
  const live = pages?.find((p) => p._id === pageId);

  return (
    <span
      className="nt-ref"
      // The press must not select the shape or start a drag — the chip is a
      // destination, not a handle. Double-click still bubbles, so entering the
      // label for editing works from the chip too.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={
        openPage
          ? (e) => {
              e.stopPropagation();
              openPage.open(pageId as Id<"pages">, here);
            }
          : undefined
      }
    >
      {chipText(live?.title ?? title)}
    </span>
  );
}

// ---------------------------------------------------------------------------

/** What the menu renders from: the query and where on screen the "@…" is. */
type Menu = { query: string; left: number; bottom: number };

/** Where the "@…" lives in the DOM — a handle, not render state. */
type Spot = { node: Text; trigger: MentionTrigger; caret: number };

const stop = (event: SyntheticEvent) => event.stopPropagation();

function chipEl(pageId: string, title: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.className = "nt-ref";
  chip.contentEditable = "false";
  chip.dataset.page = pageId;
  chip.dataset.title = title;
  chip.textContent = chipText(title);
  return chip;
}

/** The edited DOM, read back as a canonical label. */
function labelOfDom(el: HTMLElement): string {
  let out = "";
  el.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      out += textToLabel(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const child = node as HTMLElement;
    out +=
      child.dataset.page !== undefined
        ? refToLabel(child.dataset.page, child.dataset.title ?? "")
        : textToLabel(child.textContent ?? "");
  });
  return out.trim();
}

export function LabelEdit({
  label,
  onEnd,
}: {
  label: string;
  onEnd: (label: string) => void;
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
  // content again: the runs go in from here and the browser owns the DOM from
  // there until the edit commits. Reconciling React's idea of the label against
  // the nodes the browser made while typing is what duplicated the text and
  // detached a node out from under `removeChild`.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren(
      ...labelRuns(label).map((run) =>
        run.kind === "text"
          ? document.createTextNode(run.text)
          : chipEl(run.pageId, run.title),
      ),
    );
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [label]);

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
      if (event.key === "Escape" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        // Blur commits, so both endings go through one path.
        el.blur();
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [menu, items, activeIndex, take]);

  const commit = () => onEnd(ref.current ? labelOfDom(ref.current) : "");

  return (
    <>
      <span
        ref={ref}
        className="nt-edit"
        contentEditable
        suppressContentEditableWarning
        onKeyUp={stop}
        onBeforeInput={stop}
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
