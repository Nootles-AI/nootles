"use client";

/**
 * The canvas context menu — Figma's set, shared by the surface and the layers
 * panel.
 *
 * Every entry dispatches the op the keymap already dispatches for the shortcut
 * printed beside it, and the hint comes from the same table, so the menu cannot
 * drift from the keyboard. It operates on the selection, never on the row that
 * was right-clicked: the caller selects first, the menu reads what is selected.
 */

import {
  Fragment,
  useCallback,
  useLayoutEffect,
  useState,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { shortcutHint, type ShortcutId } from "./engine/shortcuts";
import type { SceneStore } from "./engine/useScene";
import type { SelectionStore } from "./engine/useSelection";
import type { PageCanvas } from "./page/PageCanvas";
import { Glyph, glyphFor } from "./panels/layerGlyph";
import type { Candidate } from "./scene/picking";
import { laidOutScene } from "./scene/autoLayout";
import { booleanOps, canBoolean, flattenOps, loadClipper } from "./scene/boolean";
import { compileSelection } from "@/app/lib/ai/html/toHtml";
import { duplicateNodes, mintId } from "./scene/ops";
import {
  displayName,
  findNode,
  findParent,
  isContainer,
  isGroup,
  selectedNodes,
  walk,
  type NodeId,
  type Point,
  type Scene,
  type SceneLike,
  isBoolean,
  type BooleanOp,
} from "./scene/types";
import "./canvas.css";

/**
 * The menus' rank — `.nt-menu`'s own, and the catchers under them sit level
 * with it. Opened over the toolbar and the panels, and over the storyboard's
 * full-size view, so nothing below the popover rank may cover it.
 */
const MENU_Z = "var(--z-popover)";

export interface MenuAction {
  label: string;
  /** Its row in the keymap — the source of both the binding and the hint. */
  shortcut: ShortcutId;
  disabled: boolean;
  danger?: boolean;
  run(): void; // ignored when `submenu` is set
  /** A nested list; the row shows a chevron and opens it on hover, ArrowRight or Enter. */
  submenu?: readonly LayerRow[];
}

/** Groups are separated by a rule, in Figma's order. */
type MenuActions = readonly (readonly MenuAction[])[];

/** One row of the "Select layer ▸" submenu — a painted candidate under the pointer. */
export interface LayerRow {
  id: NodeId;
  /** `displayName(node)`. */
  name: string;
  /** Disambiguation when `name` repeats among the rows: the parent's display name, else the id. */
  hint: string | null;
  /** `glyphFor(node)`. */
  glyph: string;
  selected: boolean;
}

/**
 * Front-to-back layer rows for the "Select layer ▸" submenu, from PICK's
 * candidate list at the point the menu opened. A repeated display name is
 * disambiguated by the parent's name (or `"top level"`); if that still
 * repeats, the id is appended. Pure.
 */
export function layerRows(
  _scene: SceneLike,
  candidates: readonly Candidate[],
  selected: ReadonlySet<NodeId>,
): LayerRow[] {
  const names = new Map<string, number>();
  for (const c of candidates) {
    const name = displayName(c.node);
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  const base = candidates.map((c) => {
    const name = displayName(c.node);
    const parent = c.chain.length >= 2 ? c.chain[c.chain.length - 2] : null;
    const hintBase =
      (names.get(name) ?? 0) > 1 ? (parent ? displayName(parent) : "top level") : null;
    return {
      id: c.node.id,
      name,
      hintBase,
      glyph: glyphFor(c.node),
      selected: selected.has(c.node.id),
    };
  });
  const pairCount = new Map<string, number>();
  for (const row of base) {
    const key = `${row.name}::${row.hintBase ?? ""}`;
    pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
  }
  return base.map((row) => {
    const key = `${row.name}::${row.hintBase ?? ""}`;
    const hint =
      row.hintBase !== null && (pairCount.get(key) ?? 0) > 1
        ? `${row.hintBase} · ${row.id}`
        : row.hintBase;
    return { id: row.id, name: row.name, hint, glyph: row.glyph, selected: row.selected };
  });
}

/**
 * Copies through `duplicateNodes`, landed as inserts.
 *
 * The store takes ops rather than scenes, so the copies the op layer built are
 * read back out of the scene it returned along with where they went — in
 * document order, so each index still counts the inserts before it.
 */
function duplicate(target: MenuTarget, ids: readonly NodeId[]): void {
  const { store } = target;
  const current = store.getScene();
  const { scene: next, ids: copies } = duplicateNodes(current, ids);
  if (copies.length === 0) return;
  store.dispatch(
    copies.map((id) => {
      const parent = findParent(next, id);
      const siblings =
        parent && isContainer(parent) ? parent.children : next.nodes;
      return {
        type: "insert" as const,
        nodes: [findNode(next, id)!],
        parentId: parent?.id ?? null,
        index: siblings.findIndex((node) => node.id === id),
      };
    }),
  );
  target.select(copies);
}

/**
 * A selection's outermost nodes, however deep the ids run — the same
 * question `compileSelection` asks of its own `ids` argument internally, but
 * this one only needs a yes/no on "does the clipper have to be in before we
 * copy" (COMPILE, §2.5), so it walks every SELECTED node's own subtree rather
 * than re-deriving `compileSelection`'s outermost-wins reduction.
 */
function selectionHasBoolean(scene: Scene, ids: readonly NodeId[]): boolean {
  let found = false;
  for (const node of selectedNodes(scene, ids)) {
    walk([node], (n) => {
      if (isBoolean(n)) found = true;
    });
  }
  return found;
}

/**
 * "Copy as HTML" / "Copy as React" (COMPILE, §2.5): the selection, compiled
 * to standard markup and put on the system clipboard — a second, independent
 * write path from ⌘C, which stays canvas HTML (`engine/shortcuts.ts`'s own
 * `onCopy`). Silent on success, matching ⌘C's own silence; a rejected
 * `navigator.clipboard.write` (denied permission, insecure context, a host
 * that refuses a `text/html` `ClipboardItem`) is caught and logged, not
 * surfaced — the canvas has no toast primitive to show it in today.
 */
async function copyAs(store: SceneStore, ids: readonly NodeId[], flavour: "html" | "jsx"): Promise<void> {
  try {
    const laid = laidOutScene(store.getScene());
    if (selectionHasBoolean(laid, ids)) await loadClipper();
    const out = compileSelection(laid, ids, { flavour });
    if (!out) return;
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([out.code], { type: "text/html" }),
        "text/plain": new Blob([out.code], { type: "text/plain" }),
      }),
    ]);
  } catch (err) {
    console.warn(`Copy as ${flavour === "jsx" ? "React" : "HTML"} failed`, err);
  }
}

/** Figma's boolean submenu, flat: four operations and the flatten. */
const BOOLEANS: { label: string; shortcut: ShortcutId; op: BooleanOp }[] = [
  { label: "Union", shortcut: "edit.union", op: "union" },
  { label: "Subtract", shortcut: "edit.subtract", op: "subtract" },
  { label: "Intersect", shortcut: "edit.intersect", op: "intersect" },
  { label: "Exclude", shortcut: "edit.exclude", op: "exclude" },
];

/**
 * One diagram the menu acts on: its store, its own selection, and how a
 * result lands as its selection — replacing the page's when the menu speaks
 * for one diagram, beside the others' when it speaks for several.
 */
export interface MenuTarget {
  store: SceneStore;
  selection: SelectionStore;
  select(ids: readonly NodeId[]): void;
}

const identity = <T,>(fn: () => T): T => fn();

/**
 * Delete what is selected, in every target at once and as one step:
 * connectors where a diagram holds connectors (the two never share a
 * selection), its shapes otherwise. False when there was nothing to delete.
 */
export function deleteSelection(
  targets: readonly MenuTarget[],
  batch: <T>(fn: () => T) => T = identity,
): boolean {
  const parts = targets.map((target) => {
    const { ids, edgeIds } = target.selection.getSnapshot();
    const nodes = selectedNodes(target.store.getScene(), ids).map((node) => node.id);
    return { target, nodes, edgeIds };
  });
  if (!parts.some((part) => part.nodes.length || part.edgeIds.length)) return false;
  batch(() => {
    for (const { target, nodes, edgeIds } of parts) {
      if (edgeIds.length) target.store.dispatch({ type: "removeEdge", ids: [...edgeIds] });
      else if (nodes.length) target.store.dispatch({ type: "remove", ids: nodes });
      else continue;
      target.selection.clear();
    }
  });
  return true;
}

/**
 * The menu over every diagram holding part of the selection. What makes sense
 * of shapes wherever they are — delete, duplicate, lock, hide, arrange — acts
 * on each, in one undo step; what makes one thing out of several — a group, a
 * boolean — or copies the selection out is for one diagram only.
 */
function buildActions(
  targets: readonly MenuTarget[],
  batch: <T>(fn: () => T) => T,
  layers?: readonly LayerRow[],
): MenuActions {
  const parts = targets.map((target) => {
    const nodes = selectedNodes(target.store.getScene(), target.selection.getSnapshot().ids);
    return { target, nodes, ids: nodes.map((node) => node.id) };
  });
  const across = targets.length > 1;
  const all = parts.flatMap((part) => part.nodes);
  const none = all.length === 0;
  const locked = !none && all.every((node) => node.locked);
  const hidden = !none && all.every((node) => node.hidden);
  const each = (fn: (part: (typeof parts)[number]) => void) =>
    batch(() => {
      for (const part of parts) if (part.ids.length) fn(part);
    });

  // Only ever read for one diagram: every action below that uses it is
  // disabled across several.
  const { target, nodes, ids } = parts[0] ?? { target: null, nodes: [], ids: [] };
  const store = target?.store;
  const scene = store?.getScene();
  const groups = nodes.filter(isGroup);
  const single = (disabled: boolean) => across || !store || disabled;

  const arrange = (
    label: string,
    shortcut: ShortcutId,
    at: "front" | "forward" | "backward" | "back",
  ): MenuAction => ({
    label,
    shortcut,
    disabled: none,
    run: () => each((part) => part.target.store.dispatch({ type: "reorder", ids: part.ids, to: { at } })),
  });

  const base: MenuActions = [
    [
      {
        label: "Copy as HTML",
        shortcut: "edit.copyHtml",
        disabled: single(none),
        run: () => store && void copyAs(store, ids, "html"),
      },
      {
        label: "Copy as React",
        shortcut: "edit.copyJsx",
        disabled: single(none),
        run: () => store && void copyAs(store, ids, "jsx"),
      },
    ],
    [
      {
        label: "Group",
        shortcut: "edit.group",
        disabled: single(ids.length < 2),
        run: () => {
          if (!store || !scene || !target) return;
          const groupId = mintId(scene);
          store.dispatch({ type: "group", ids, groupId });
          target.select([groupId]);
        },
      },
      {
        label: "Ungroup",
        shortcut: "edit.ungroup",
        disabled: single(groups.length === 0),
        run: () => {
          if (!store || !target) return;
          const children = groups.flatMap((group) =>
            group.children.map((child) => child.id),
          );
          store.dispatch({
            type: "ungroup",
            ids: groups.map((group) => group.id),
          });
          target.select(children);
        },
      },
      {
        label: "Duplicate",
        shortcut: "edit.duplicate",
        disabled: none,
        run: () => each((part) => duplicate(part.target, part.ids)),
      },
      {
        label: "Delete",
        shortcut: "edit.delete",
        disabled: none,
        danger: true,
        run: () => void deleteSelection(targets, batch),
      },
    ],
    [
      ...BOOLEANS.map(
        ({ label, shortcut, op }): MenuAction => ({
          label,
          shortcut,
          disabled: single(!canBoolean(nodes)),
          run: () => {
            if (!store || !scene || !target) return;
            const result = booleanOps(scene, nodes, op);
            if (!result) return;
            store.dispatch(result.ops);
            target.select(result.select);
          },
        }),
      ),
      {
        label: "Flatten",
        shortcut: "edit.flatten",
        disabled: single(!nodes.some(isBoolean)),
        run: () =>
          store &&
          void loadClipper().then(() => {
            const ops = flattenOps(store.getScene(), ids);
            if (ops.length) store.dispatch(ops);
          }),
      },
    ],
    [
      arrange("Bring to front", "arrange.front", "front"),
      arrange("Bring forward", "arrange.forward", "forward"),
      arrange("Send backward", "arrange.backward", "backward"),
      arrange("Send to back", "arrange.back", "back"),
    ],
    [
      {
        label: locked ? "Unlock" : "Lock",
        shortcut: "toggle.locked",
        disabled: none,
        run: () =>
          each((part) =>
            part.target.store.dispatch({ type: "setLocked", ids: part.ids, locked: !locked }),
          ),
      },
      {
        label: hidden ? "Show" : "Hide",
        shortcut: "toggle.hidden",
        disabled: none,
        run: () =>
          each((part) =>
            part.target.store.dispatch({ type: "setHidden", ids: part.ids, hidden: !hidden }),
          ),
      },
    ],
  ];

  // Figma places the layer list first, above every other group — including
  // COMPILE's static Copy-as group already at index 0 of `base`.
  if (layers && layers.length > 0) {
    return [
      [
        {
          label: "Select layer",
          shortcut: "select.layers",
          disabled: false,
          run: () => {},
          submenu: layers,
        },
      ],
      ...base,
    ];
  }
  return base;
}

/**
 * The "Select layer ▸" submenu, rendered as a **sibling** of the top-level
 * `role="menu"` div (never nested) so that menu's own roving
 * `querySelectorAll("[role='menuitem']")` never picks up a submenu row.
 *
 * `anchorRef` names the parent row's element (position beside it); `null` in
 * `layersOnly` mode, where this submenu *is* the whole menu and positions at
 * the pointer instead. Read as a ref (never `.current` during render — a
 * hooks-lint hazard) inside the effect that positions this menu, which only
 * ever runs after the anchor has mounted. Row markup is pinned by HARNESS's
 * shared `window.canvasHarness.contextMenu()` reader: `role="menuitem"` +
 * `data-layer-id` on every row.
 */
function SelectLayerSubmenu({
  rows,
  anchorRef,
  at,
  onPick,
  onHover,
  onClose,
  onBack,
}: {
  rows: readonly LayerRow[];
  anchorRef: React.RefObject<HTMLElement | null> | null;
  at: Point;
  onPick: (id: NodeId) => void;
  onHover: (id: NodeId | null) => void;
  onClose: () => void;
  onBack: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const anchor = anchorRef?.current ?? null;
    const clampTop = (v: number) => Math.max(8, Math.min(v, window.innerHeight - el.offsetHeight - 8));
    if (anchor) {
      const box = anchor.getBoundingClientRect();
      let left = box.right + 2;
      if (left + el.offsetWidth > window.innerWidth - 8) left = box.left - el.offsetWidth - 2;
      el.style.left = `${left}px`;
      el.style.top = `${clampTop(box.top - 4)}px`;
    } else {
      const clampLeft = (v: number) => Math.max(8, Math.min(v, window.innerWidth - el.offsetWidth - 8));
      el.style.left = `${clampLeft(at.x)}px`;
      el.style.top = `${clampTop(at.y)}px`;
    }
    el.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus();
  }, [anchorRef, at]);

  const rove = (step: 1 | -1 | "home" | "end") => {
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      step === "home" ? items[0] : step === "end" ? items[items.length - 1] : items[(i + step + items.length) % items.length];
    next.focus();
    onHover(next.dataset.layerId ?? null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      onBack();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      rove(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      rove(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      rove("home");
    } else if (e.key === "End") {
      e.preventDefault();
      rove("end");
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Select layer"
      tabIndex={-1}
      className="nt-ctx nt-menu nt-ctx-sub fixed"
      style={{ zIndex: MENU_Z }}
      onKeyDown={onKeyDown}
      onPointerLeave={() => onHover(null)}
    >
      {rows.map((row) => (
        <button
          key={row.id}
          role="menuitem"
          data-layer-id={row.id}
          aria-current={row.selected || undefined}
          className="nt-menu-item nt-ctx-sub-row"
          onPointerEnter={() => onHover(row.id)}
          onClick={() => onPick(row.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onPick(row.id);
            }
          }}
        >
          <Glyph d={row.glyph} className="nt-ctx-glyph" />
          <span className="nt-ctx-sub-name">{row.name}</span>
          {row.hint && <span className="nt-ctx-hint">{row.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Opened at a point rather than anchored to a trigger, which is the one thing
 * `Menu` cannot do; everything else — the pill, the items, the dismissal
 * shield — is the app's own menu language.
 *
 * `layersOnly` (⌘+right-click) renders the layer list alone, as the top-level
 * menu, skipping the action rows entirely.
 */
export function ContextMenu({
  at,
  actions,
  layers = [],
  layersOnly = false,
  onHoverLayer,
  onPickLayer,
  onClose,
}: {
  at: Point;
  actions: MenuActions;
  layers?: readonly LayerRow[];
  layersOnly?: boolean;
  onHoverLayer: (id: NodeId | null) => void;
  onPickLayer: (id: NodeId) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layerRowRef = useRef<HTMLButtonElement | null>(null);
  const [subOpen, setSubOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const clamp = (v: number, limit: number) => Math.max(8, Math.min(v, limit));
    el.style.left = `${clamp(at.x, window.innerWidth - el.offsetWidth - 8)}px`;
    el.style.top = `${clamp(at.y, window.innerHeight - el.offsetHeight - 8)}px`;
    // The canvas keymap follows focus, so the menu borrows it and gives it back.
    const previous = document.activeElement;
    el.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [at]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowRight" && document.activeElement === layerRowRef.current) {
      e.preventDefault();
      setSubOpen(true);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLButtonElement>(
        "[role='menuitem']:not(:disabled)",
      ) ?? [],
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(i + step + items.length) % items.length].focus();
  };

  // Mod+right-click: the list alone, at the pointer, no header row.
  if (layersOnly) {
    return (
      <>
        <div
          className="nt-ctx fixed inset-0"
          style={{ zIndex: MENU_Z }}
          onPointerDown={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
        <SelectLayerSubmenu
          rows={layers}
          anchorRef={null}
          at={at}
          onPick={onPickLayer}
          onHover={onHoverLayer}
          onClose={onClose}
          onBack={onClose}
        />
      </>
    );
  }

  return (
    <>
      {/* Marked `nt-ctx` so the canvas does not read dismissing this as a
          press outside itself. */}
      <div
        className="nt-ctx fixed inset-0"
        style={{ zIndex: MENU_Z }}
        onPointerDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={ref}
        role="menu"
        aria-label="Canvas actions"
        tabIndex={-1}
        className="nt-ctx nt-menu fixed"
        style={{ top: at.y, left: at.x, zIndex: MENU_Z }}
        onKeyDown={onKeyDown}
      >
        {actions.map((group, i) => (
          <Fragment key={i}>
            {i > 0 && <div className="nt-menu-sep" />}
            {group.map((action) =>
              action.submenu ? (
                <button
                  key={action.label}
                  ref={layerRowRef}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={subOpen}
                  className="nt-menu-item"
                  onPointerEnter={() => setSubOpen(true)}
                  onClick={() => setSubOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSubOpen(true);
                    }
                  }}
                >
                  {action.label}
                  <span className="nt-ctx-chevron">▸</span>
                </button>
              ) : (
                <button
                  key={action.label}
                  role="menuitem"
                  disabled={action.disabled}
                  className={`nt-menu-item${action.danger ? " is-danger" : ""}`}
                  onPointerEnter={() => setSubOpen(false)}
                  onClick={() => {
                    action.run();
                    onClose();
                  }}
                >
                  {action.label}
                  <span className="nt-ctx-key">
                    {shortcutHint(action.shortcut)}
                  </span>
                </button>
              ),
            )}
          </Fragment>
        ))}
      </div>
      {subOpen && (
        <SelectLayerSubmenu
          rows={layers}
          anchorRef={layerRowRef}
          at={at}
          onPick={onPickLayer}
          onHover={onHoverLayer}
          onClose={onClose}
          onBack={() => {
            setSubOpen(false);
            layerRowRef.current?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * The diagrams a menu opened over `store` acts on: every one holding part of
 * the page's selection when there are several, else this one.
 */
export function menuTargets(
  store: SceneStore,
  selection: SelectionStore,
  page: PageCanvas | undefined,
): MenuTarget[] {
  const targets = page?.targets() ?? [];
  if (!page || targets.length < 2) return [{ store, selection, select: (ids) => selection.select(ids) }];
  return targets.map((t) => ({
    store: t.store,
    selection: t.selection,
    select: (ids) => page.selection.selectIn(t.blockId, ids, { keep: true }),
  }));
}

/** The menu, its state and the handler that opens it — one call per host. */
export function useContextMenu(store: SceneStore, selection: SelectionStore, page?: PageCanvas) {
  const [state, setState] = useState<{
    at: Point;
    layers: readonly LayerRow[];
    layersOnly: boolean;
  } | null>(null);

  // Rows are computed once, here, at open time — not recomputed per render,
  // so the menu's own list is static while it is open even if a hover or a
  // later selection change moves the store underneath it.
  const open = useCallback(
    (
      event: { clientX: number; clientY: number },
      opts?: { layers?: readonly Candidate[]; layersOnly?: boolean },
    ) => {
      const rows = opts?.layers
        ? layerRows(store.getScene(), opts.layers, selection.getSnapshot().selected)
        : [];
      setState({
        at: { x: event.clientX, y: event.clientY },
        layers: rows,
        layersOnly: opts?.layersOnly ?? false,
      });
    },
    [store, selection],
  );
  const close = useCallback(() => {
    selection.hoverNode(null);
    setState(null);
  }, [selection]);
  return {
    open,
    // On the body: the menu is fixed at the pointer, and inside a zoomed page
    // a fixed box's offsets are zoomed with it.
    menu: state && createPortal(
      <ContextMenu
        at={state.at}
        actions={buildActions(menuTargets(store, selection, page), page?.batch ?? identity, state.layers)}
        layers={state.layers}
        layersOnly={state.layersOnly}
        onHoverLayer={(id) => selection.hoverNode(id)}
        onPickLayer={(id) => {
          selection.select([id]);
          close();
        }}
        onClose={close}
      />,
      document.body,
    ),
  };
}
