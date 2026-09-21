"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PageNode } from "../_kit/data";
import { usePresence } from "../_kit/presence";
import { useUi } from "../_kit/store";
import { Pop } from "../_kit/overlays";
import { PageMenuItems } from "../_kit/Shell";
import { Plus } from "../_kit/icons";

export type Dir = "next" | "prev";

const WIDTHS = [92, 78, 86, 64, 88, 72];

/** What a page looks like from too far away to read: a title bar and the grey of its lines. */
function Lines({ seed, diagram }: { seed: number; diagram?: boolean }) {
  return (
    <span className="d-lines" aria-hidden>
      {WIDTHS.slice(0, 4 + (seed % 3)).map((_, i) => (
        <i key={i} style={{ width: `${WIDTHS[(i + seed) % WIDTHS.length]}%` }} />
      ))}
      {diagram && <b />}
    </span>
  );
}

/**
 * A neighbour in the stack: the real next (or previous) sheet, lying behind the
 * open one with its edge showing. Pages further off are only their edges.
 */
export function Peek({ page, seed, side, far, onTurn }: { page: PageNode; seed: number; side: Dir; far: number; onTurn: () => void }) {
  const title = page.title || "Untitled";
  return (
    <>
      {Array.from({ length: far }, (_, i) => far - i).map((n) => (
        <i key={n} className={`d-edge is-${side}`} style={{ "--n": n } as CSSProperties} aria-hidden />
      ))}
      <button
        type="button"
        className={`d-peek is-${side}`}
        aria-label={`${side === "next" ? "Next" : "Previous"} page: ${title}`}
        data-tip={title}
        data-keys={side === "next" ? "⌥→" : "⌥←"}
        onClick={onTurn}
      >
        <Lines seed={seed} />
        <span className="d-peek-title">{title}</span>
      </button>
    </>
  );
}

/** The whole project fanned out across the desk, to pick a sheet from. */
export function Fan({ open, onClose, onTurn, onAdd }: { open: boolean; onClose: () => void; onTurn: (id: string) => void; onAdd: () => void }) {
  const { ui, act } = useUi();
  const { mounted, state } = usePresence(open, 240);
  const [menu, setMenu] = useState<{ page: PageNode; x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) root.current?.querySelector<HTMLElement>("[aria-current='page']")?.focus({ preventScroll: true });
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      ref={root}
      className="d-fan"
      role="dialog"
      aria-label="All pages"
      data-state={state}
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || ui.renaming) return;
        e.stopPropagation();
        onClose();
      }}
    >
      <ul className="d-fan-row">
        {ui.pages.map((p, i) => {
          const current = p.id === ui.pageId;
          const style = { "--i": i } as CSSProperties;
          const face = (
            <>
              <span className="d-mini-sheet">
                <Lines seed={i} diagram={p.id === "overview"} />
              </span>
              {ui.renaming === p.id ? (
                <input
                  autoFocus
                  aria-label="Page name"
                  defaultValue={p.title}
                  placeholder="Untitled"
                  className="ek-row-edit d-mini-edit"
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={(e) => act.renamePage(p.id, e.currentTarget.value.trim())}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.currentTarget.blur();
                      onClose();
                    }
                    if (e.key === "Escape") act.set({ renaming: null });
                  }}
                />
              ) : (
                <span className="d-mini-name">{p.title || "Untitled"}</span>
              )}
              {p.folder && <span className="ek-meta">{p.folder}</span>}
            </>
          );
          return (
            <li
              key={p.id}
              style={style}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ page: p, x: e.clientX, y: e.clientY });
              }}
            >
              {ui.renaming === p.id ? (
                <div className="d-mini" data-current={current}>
                  {face}
                </div>
              ) : (
                <button
                  type="button"
                  className="d-mini"
                  data-current={current}
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    onTurn(p.id);
                    onClose();
                  }}
                  onDoubleClick={() => act.set({ renaming: p.id })}
                >
                  {face}
                </button>
              )}
            </li>
          );
        })}
        <li style={{ "--i": ui.pages.length } as CSSProperties}>
          <button type="button" className="d-mini is-new" onClick={onAdd}>
            <span className="d-mini-sheet">
              <Plus width={16} height={16} />
            </span>
            <span className="d-mini-name">New page</span>
          </button>
        </li>
      </ul>
      <p className="d-fan-foot">
        <kbd className="ek-kbd">⌥←</kbd>
        <kbd className="ek-kbd">⌥→</kbd> turn pages without opening this · <kbd className="ek-kbd">esc</kbd> to put them back
      </p>
      <Pop open={menu !== null} onClose={() => setMenu(null)} anchor={menu ?? { x: 0, y: 0 }} gap={2} label="Page actions">
        {menu && <PageMenuItems page={menu.page} />}
      </Pop>
    </div>
  );
}
