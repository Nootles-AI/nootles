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
import { shortcutHint, type ShortcutId } from "./engine/shortcuts";
import type { SceneStore } from "./engine/useScene";
import type { SelectionStore } from "./engine/useSelection";
import { duplicateNodes, mintId } from "./scene/ops";
import {
  findNode,
  findParent,
  isContainer,
  isGroup,
  selectedNodes,
  type NodeId,
  type Point,
} from "./scene/types";
import "./canvas.css";

/**
 * Above the toolbar and the panels rather than at the dropdown register the
 * menu pill defaults to: this one is opened over that chrome and is asking a
 * question, so nothing may cover it.
 */
const MENU_Z = "var(--z-modal)";

export interface MenuAction {
  label: string;
  /** Its row in the keymap — the source of both the binding and the hint. */
  shortcut: ShortcutId;
  disabled: boolean;
  danger?: boolean;
  run(): void;
}

/** Groups are separated by a rule, in Figma's order. */
type MenuActions = readonly (readonly MenuAction[])[];

/**
 * Copies through `duplicateNodes`, landed as inserts.
 *
 * The store takes ops rather than scenes, so the copies the op layer built are
 * read back out of the scene it returned along with where they went — in
 * document order, so each index still counts the inserts before it.
 */
function duplicate(
  store: SceneStore,
  selection: SelectionStore,
  ids: readonly NodeId[],
): void {
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
  selection.select(copies);
}

function buildActions(
  store: SceneStore,
  selection: SelectionStore,
): MenuActions {
  const scene = store.getScene();
  const nodes = selectedNodes(scene, selection.getSnapshot().ids);
  const ids = nodes.map((node) => node.id);
  const groups = nodes.filter(isGroup);
  const none = ids.length === 0;
  const locked = !none && nodes.every((node) => node.locked);
  const hidden = !none && nodes.every((node) => node.hidden);

  const arrange = (
    label: string,
    shortcut: ShortcutId,
    at: "front" | "forward" | "backward" | "back",
  ): MenuAction => ({
    label,
    shortcut,
    disabled: none,
    run: () => store.dispatch({ type: "reorder", ids, to: { at } }),
  });

  return [
    [
      {
        label: "Group",
        shortcut: "edit.group",
        disabled: ids.length < 2,
        run: () => {
          const groupId = mintId(scene);
          store.dispatch({ type: "group", ids, groupId });
          selection.select([groupId]);
        },
      },
      {
        label: "Ungroup",
        shortcut: "edit.ungroup",
        disabled: groups.length === 0,
        run: () => {
          const children = groups.flatMap((group) =>
            group.children.map((child) => child.id),
          );
          store.dispatch({
            type: "ungroup",
            ids: groups.map((group) => group.id),
          });
          selection.select(children);
        },
      },
      {
        label: "Duplicate",
        shortcut: "edit.duplicate",
        disabled: none,
        run: () => duplicate(store, selection, ids),
      },
      {
        label: "Delete",
        shortcut: "edit.delete",
        disabled: none,
        danger: true,
        run: () => {
          store.dispatch({ type: "remove", ids });
          selection.clear();
        },
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
          store.dispatch({ type: "setLocked", ids, locked: !locked }),
      },
      {
        label: hidden ? "Show" : "Hide",
        shortcut: "toggle.hidden",
        disabled: none,
        run: () =>
          store.dispatch({ type: "setHidden", ids, hidden: !hidden }),
      },
    ],
  ];
}

/**
 * Opened at a point rather than anchored to a trigger, which is the one thing
 * `Menu` cannot do; everything else — the pill, the items, the dismissal
 * shield — is the app's own menu language.
 */
export function ContextMenu({
  at,
  actions,
  onClose,
}: {
  at: Point;
  actions: MenuActions;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

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
            {group.map((action) => (
              <button
                key={action.label}
                role="menuitem"
                disabled={action.disabled}
                className={`nt-menu-item${action.danger ? " is-danger" : ""}`}
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
            ))}
          </Fragment>
        ))}
      </div>
    </>
  );
}

/** The menu, its state and the handler that opens it — one call per host. */
export function useContextMenu(store: SceneStore, selection: SelectionStore) {
  const [at, setAt] = useState<Point | null>(null);
  const open = useCallback(
    (event: { clientX: number; clientY: number }) =>
      setAt({ x: event.clientX, y: event.clientY }),
    [],
  );
  const close = useCallback(() => setAt(null), []);
  return {
    open,
    menu: at && (
      <ContextMenu
        at={at}
        actions={buildActions(store, selection)}
        onClose={close}
      />
    ),
  };
}
