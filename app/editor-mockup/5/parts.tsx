"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Block, PageNode } from "../_kit/data";
import { useScene, useUi } from "../_kit/store";
import { Pop } from "../_kit/overlays";
import { PageMenuItems } from "../_kit/Shell";
import { Plus, Sparkle } from "../_kit/icons";

/** What a block looks like from across the room. */
function Bars({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b) =>
        b.type === "diagram" ? (
          <span key={b.id} className="s-b-dia">
            <i />
            <i />
            <i />
          </span>
        ) : b.type === "p" ? (
          <span key={b.id} className="s-b-p">
            <i />
            <i />
          </span>
        ) : (
          <i key={b.id} className={`s-b-${b.type}`} />
        ),
      )}
    </>
  );
}

/** Pages nobody has written yet still differ: their lines are cut from their own id. */
function Lines({ id }: { id: string }) {
  const seed = [...id].reduce((n, c) => n + c.charCodeAt(0), 0);
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <i key={i} className="s-b-bullet" style={{ width: `${46 + ((seed * (i + 3)) % 48)}%` }} />
      ))}
    </>
  );
}

function Leaf({ page, blocks }: { page: PageNode; blocks: Block[] }) {
  return (
    <span className="s-leaf" aria-hidden>
      {!page.blank && <i className="s-b-title" />}
      {page.id === "overview" ? <Bars blocks={blocks} /> : !page.blank && <Lines id={page.id} />}
    </span>
  );
}

function Thumb({ page, depth = 0 }: { page: PageNode; depth?: number }) {
  const { ui, act } = useUi();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const current = ui.pageId === page.id;
  return (
    <li
      className="s-frame"
      data-thumb={page.id}
      data-current={current}
      style={{ "--depth": depth } as CSSProperties}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <button type="button" className="s-thumb" aria-current={current ? "page" : undefined} aria-label={`Open ${page.title || "Untitled"}`} onClick={() => act.openPage(page.id)}>
        <Leaf page={page} blocks={ui.blocks} />
      </button>
      {ui.renaming === page.id ? (
        <input
          autoFocus
          aria-label="Page name"
          defaultValue={page.title}
          placeholder="Untitled"
          className="ek-row-edit s-cap-edit"
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => act.renamePage(page.id, e.currentTarget.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") act.set({ renaming: null });
          }}
        />
      ) : (
        <span className="s-cap" data-tip="Double-click to rename" onDoubleClick={() => act.set({ renaming: page.id })}>
          {page.title || "Untitled"}
        </span>
      )}
      <Pop open={menu !== null} onClose={() => setMenu(null)} anchor={menu ?? { x: 0, y: 0 }} gap={2} label="Page actions">
        <PageMenuItems page={page} />
      </Pop>
    </li>
  );
}

function place(list: HTMLElement | null, key: string) {
  const thumb = list?.querySelector<HTMLElement>(`[data-thumb="${key}"] .s-thumb`);
  if (!list || !thumb) return;
  // Offsets, not rects: the frames are mid-entrance the first time this runs.
  let x = 0;
  let y = 0;
  for (let el: HTMLElement | null = thumb; el && el !== list; el = el.offsetParent as HTMLElement | null) {
    x += el.offsetLeft;
    y += el.offsetTop;
  }
  list.style.setProperty("--ring-x", `${x}px`);
  list.style.setProperty("--ring-y", `${y}px`);
  list.style.setProperty("--ring-w", `${thumb.offsetWidth}px`);
  list.style.setProperty("--ring-h", `${thumb.offsetHeight}px`);
  list.dataset.ringed = "true";
}

/**
 * The pages as a filmstrip: each one a sheet lying in a well, as on the
 * projects grid, at the size of a thumbnail. One ink ring travels between them.
 */
export function Film() {
  const { ui, act } = useUi();
  const list = useRef<HTMLUListElement>(null);
  const [fanned, setFanned] = useState(true);

  const top = ui.pages.filter((p) => !p.folder);
  const research = ui.pages.filter((p) => p.folder === "Research");
  const inFolder = research.some((p) => p.id === ui.pageId);
  const ringOn = !fanned && inFolder ? "folder" : ui.pageId;

  useLayoutEffect(() => {
    place(list.current, ringOn);
  }, [ringOn, ui.pages, ui.renaming]);

  return (
    <nav className="s-film-strip" aria-label="Pages">
      <ul ref={list} className="s-frames ek-stagger">
        <li className="s-ring" role="presentation" aria-hidden />
        {top.slice(0, 3).map((p) => (
          <Thumb key={p.id} page={p} />
        ))}
        {research.length > 0 && (
          <li className="s-frame s-folder" data-thumb="folder" data-open={fanned}>
            <button type="button" className="s-thumb is-stack" aria-expanded={fanned} aria-label="Research" onClick={() => setFanned((f) => !f)}>
              <span className="s-leaf" aria-hidden />
              <span className="s-leaf" aria-hidden />
              <span className="s-leaf" aria-hidden>
                <i className="s-b-title" />
                <Lines id="research" />
              </span>
            </button>
            <span className="s-cap is-folder">
              Research <i>{research.length}</i>
            </span>
            {/* Where the rows below come to rest is only known once the fan has
                finished moving, so the ring is placed again then. */}
            <div className="s-fan" inert={!fanned} onTransitionEnd={(e) => e.target === e.currentTarget && place(list.current, ringOn)}>
              <ul>
                {research.map((p) => (
                  <Thumb key={p.id} page={p} depth={1} />
                ))}
              </ul>
            </div>
          </li>
        )}
        {top.slice(3).map((p) => (
          <Thumb key={p.id} page={p} />
        ))}
        <li className="s-frame">
          <button type="button" className="s-thumb is-new" aria-label="New page" data-tip="New page" onClick={act.addPage}>
            <Plus width={16} height={16} />
          </button>
        </li>
      </ul>
    </nav>
  );
}

/**
 * The assistant, from the stage: a chip that opens onto the same conversation
 * the rail holds. Nothing is asked of a model — `act.send` types out a script.
 */
export function StageAsk() {
  const { ui, act } = useUi();
  const scene = useScene();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const busy = ui.streaming !== null;
  const recent = ui.msgs.slice(-2);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    act.send(text);
    setDraft("");
  };

  return (
    <>
      <button ref={anchor} type="button" className="s-ask" aria-haspopup="dialog" aria-expanded={open} data-busy={busy || undefined} onClick={() => setOpen((o) => !o)}>
        <Sparkle width={14} height={14} />
        <span>{busy ? "Drawing…" : ui.review === "open" ? "2 changes to review" : "Ask about this diagram…"}</span>
      </button>
      <Pop open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" gap={8} role="dialog" label="Ask about this diagram" className="s-ask-pop" exitMs={160}>
        <div className="s-ask-log">
          {recent.length === 0 && !busy && <p className="ek-note">Ask for a shape, a connector, a tidier layout. Changes wait for you to keep them.</p>}
          {recent.map((m) => (
            <div key={m.id} className={`ek-turn ${m.from === "you" ? "is-you" : "is-ai"}`}>
              {m.from === "ai" && m.steps?.slice(-1).map((s) => (
                <span key={s} className="ek-step">
                  {s}
                </span>
              ))}
              <p>{m.text}</p>
            </div>
          ))}
          {busy && (
            <div className="ek-turn is-ai">
              {ui.streaming === "" ? (
                <span className="ek-step">
                  <i className="ek-dot" />
                  Reading Current shape…
                </span>
              ) : (
                <p>
                  {ui.streaming}
                  <i className="ek-stream-head" />
                </p>
              )}
            </div>
          )}
        </div>
        {ui.review === "open" && (
          <div className="ek-review" role="status">
            <span className="ek-review-count">
              <b>2 changes</b> · 1 page
            </span>
            <button type="button" className="ek-btn" onClick={() => act.set({ review: "discarded" })}>
              Discard
            </button>
            <button
              type="button"
              className="ek-btn is-ink"
              onClick={() => {
                act.set({ review: "kept" });
                scene.act.applyProposal();
                act.toast("Kept 2 changes", "Undo");
                setOpen(false);
              }}
            >
              Keep
            </button>
          </div>
        )}
        <div className="ek-composer">
          <textarea
            data-autofocus
            rows={1}
            aria-label="Ask Nootles"
            placeholder="Ask, or describe a change…"
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="ek-composer-acts">
            <span />
            <button type="button" className="ek-send" disabled={!busy && !draft.trim()} onClick={send}>
              {busy ? "Stop" : "Send"}
            </button>
          </div>
        </div>
      </Pop>
    </>
  );
}
