"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronRight, FileDoc } from "@/app/components/Icons";
import type { NotionPageNode } from "@/app/lib/notion/plan";
import "./notion.css";

/**
 * Notion's page tree as a list of ticks — the one picker every Notion door
 * uses, so choosing pages to import and choosing pages to read into context
 * behave the same: ticking a page takes the pages under it, a page with some
 * of its pages ticked says so, and a search keeps the path to what it found.
 */

type Row = {
  node: NotionPageNode;
  depth: number;
  parent?: string;
  open: boolean;
  /** Its place among its siblings, which a flat list of rows cannot otherwise say. */
  pos: number;
  size: number;
};

/**
 * The tree as the flat list of rows it shows, which is also the list the
 * arrow keys walk. Top-level pages open by default and deeper ones closed;
 * `toggled` holds the ones whose default has been flipped.
 */
function flatten(
  nodes: NotionPageNode[],
  depth: number,
  parent: string | undefined,
  toggled: ReadonlySet<string>,
  forceOpen: boolean,
  into: Row[] = [],
): Row[] {
  nodes.forEach((node, index) => {
    const open = forceOpen || (depth === 0) !== toggled.has(node.id);
    into.push({ node, depth, parent, open, pos: index + 1, size: nodes.length });
    if (open) flatten(node.children, depth + 1, node.id, toggled, forceOpen, into);
  });
  return into;
}

export function NotionPageTree({
  nodes,
  selection,
  setSelection,
  forceOpen,
  palette,
  onCurrent,
  label = "Pages to import",
}: {
  nodes: NotionPageNode[];
  selection: ReadonlySet<string>;
  setSelection: (next: ReadonlySet<string>) => void;
  forceOpen: boolean;
  /** Draws the palette's travelling highlight instead of lighting each row. */
  palette?: boolean;
  /** The row the pointer or the keyboard is on. */
  onCurrent?: (id: string | null) => void;
  /** What the tree is for, said to a screen reader. */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [lit, setLit] = useState<string | null>(null);
  const light = (id: string) => {
    setLit(id);
    onCurrent?.(id);
  };
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const rows = useMemo(
    () => flatten(nodes, 0, undefined, toggled, forceOpen),
    [nodes, toggled, forceOpen],
  );
  // One row carries the tab stop; when a search hides the one that had it,
  // the first row takes over rather than nothing.
  const tabbable = rows.some((row) => row.node.id === focused) ? focused : rows[0]?.node.id;

  // One highlight that travels, placed from the lit row's measured box — the
  // palette's own list does the same. A row that a collapse or a search took
  // away leaves nothing lit.
  const litIndex = rows.findIndex((row) => row.node.id === lit);
  useEffect(() => {
    const host = box.current;
    const row = host?.querySelector<HTMLElement>('[data-lit="true"]');
    if (!host || !row) return;
    host.style.setProperty("--hl-y", `${row.offsetTop}px`);
    host.style.setProperty("--hl-h", `${row.offsetHeight}px`);
  }, [litIndex, rows.length]);

  const flip = (id: string) => {
    const next = new Set(toggled);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setToggled(next);
  };

  const focusRow = (index: number) => {
    const items = ref.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    items?.[index]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const row = rows[index];
    const branch = row.node.children.length > 0;
    switch (e.key) {
      case "ArrowDown":
        focusRow(Math.min(rows.length - 1, index + 1));
        break;
      case "ArrowUp":
        focusRow(Math.max(0, index - 1));
        break;
      case "ArrowRight":
        if (!branch) return;
        if (row.open) focusRow(index + 1);
        else flip(row.node.id);
        break;
      case "ArrowLeft":
        if (branch && row.open && !forceOpen) flip(row.node.id);
        else if (row.parent) focusRow(rows.findIndex((r) => r.node.id === row.parent));
        else return;
        break;
      case "Home":
        focusRow(0);
        break;
      case "End":
        focusRow(rows.length - 1);
        break;
      default:
        // Space and Enter are the button's own: they press it, and the press
        // is the tick.
        return;
    }
    e.preventDefault();
  };

  return (
    <div ref={box} className="nt-notion-tree">
      {palette && <span className="nt-pal-hl" aria-hidden="true" data-none={litIndex < 0} />}
      {rows.length === 0 && (
        <p role="status" className="nt-notion-nomatch">
          No page here is called that.
        </p>
      )}
      <div ref={ref} role="tree" aria-label={label} aria-multiselectable>
        {rows.map((row, index) => (
          <TreeRow
            key={row.node.id}
            row={row}
            selection={selection}
            setSelection={setSelection}
            tabbable={row.node.id === tabbable}
            lit={row.node.id === lit}
            onLight={() => light(row.node.id)}
            onFocus={() => {
              setFocused(row.node.id);
              light(row.node.id);
            }}
            onKeyDown={(e) => onKeyDown(e, index)}
            onTwist={() => flip(row.node.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  row,
  selection,
  setSelection,
  tabbable,
  lit,
  onLight,
  onFocus,
  onKeyDown,
  onTwist,
}: {
  row: Row;
  selection: ReadonlySet<string>;
  setSelection: (next: ReadonlySet<string>) => void;
  tabbable: boolean;
  lit: boolean;
  onLight: () => void;
  onFocus: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onTwist: () => void;
}) {
  const { node, depth, open, pos, size } = row;
  const checked = selection.has(node.id);
  const descendants = useMemo(() => ids(node).slice(1), [node]);
  const someChildren = descendants.some((id) => selection.has(id));
  const state = checked ? "on" : someChildren ? "partial" : "off";

  const toggle = () => {
    const next = new Set(selection);
    // Ticking a page takes what is under it: the pages inside a Notion page are
    // the reason you wanted it, and hunting them one by one is not a decision
    // anybody is trying to make.
    const all = [node.id, ...descendants];
    if (checked) all.forEach((id) => next.delete(id));
    else all.forEach((id) => next.add(id));
    setSelection(next);
  };

  return (
    <div
      className="nt-notion-row"
      data-lit={lit}
      style={{ paddingLeft: `${depth * 18}px` }}
      onPointerMove={() => {
        if (!lit) onLight();
      }}
    >
      {node.children.length ? (
        <button
          type="button"
          className="nt-notion-twist"
          aria-label={open ? "Collapse" : "Expand"}
          data-open={open || undefined}
          // Pointer affordance only; the arrow keys open and close from the row.
          tabIndex={-1}
          onClick={onTwist}
        >
          <ChevronRight />
        </button>
      ) : (
        <span className="nt-notion-twist-gap" />
      )}

      <button
        type="button"
        // Checked rather than selected: the row is a tick with three states,
        // and "some of what is under this is ticked" is one of them. ARIA 1.2
        // supports either on a treeitem and forbids both; the lint predates it.
        // eslint-disable-next-line jsx-a11y/role-has-required-aria-props
        role="treeitem"
        aria-checked={checked ? true : someChildren ? "mixed" : false}
        aria-level={depth + 1}
        aria-posinset={pos}
        aria-setsize={size}
        aria-expanded={node.children.length ? open : undefined}
        tabIndex={tabbable ? 0 : -1}
        className="nt-notion-pick"
        onClick={toggle}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
      >
        <span className="nt-notion-box" data-state={state}>
          {checked && <Check />}
        </span>
        <span className="nt-notion-glyph" aria-hidden>
          {node.emoji ? <span className="nt-notion-emoji">{node.emoji}</span> : <FileDoc />}
        </span>
        <span className="nt-notion-title">{node.title}</span>
        {node.children.length > 0 && (
          <span className="nt-notion-count">{node.children.length}</span>
        )}
      </button>
    </div>
  );
}

/**
 * The tree pruned to what matches, ancestors kept.
 *
 * A page whose own title does not match still appears when something under it
 * does — otherwise a search would hide the path to its own results.
 */
export function matchingPages(nodes: NotionPageNode[], query: string): NotionPageNode[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.flatMap((node) => {
    const children = matchingPages(node.children, query);
    const hit = node.title.toLowerCase().includes(needle);
    return hit || children.length ? [{ ...node, children }] : [];
  });
}

export function ids(node: NotionPageNode): string[] {
  return [node.id, ...node.children.flatMap(ids)];
}
