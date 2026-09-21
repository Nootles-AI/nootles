"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { thread, threads, type Msg } from "../_kit/data";
import { useScene, useUi } from "../_kit/store";
import { IconBtn } from "../_kit/controls";
import { Pop } from "../_kit/overlays";
import { ArrowLeft, ArrowUp, FileDoc, Paperclip, RotateCcw, Sparkle, X } from "../_kit/icons";
import { Account, ContextRow, Facepile, FindButton, Pages, ProjectTitle } from "../_kit/Shell";
import { SharePanel } from "../_kit/Share";
import { Chat } from "../_kit/Chat";

/** One segment of the status line, and the surface it opens under itself. */
function Seg({
  label,
  lead,
  pop,
  popClass = "",
  align = "start",
  open,
  onOpen,
}: {
  label: ReactNode;
  lead?: ReactNode;
  pop: ReactNode;
  popClass?: string;
  align?: "start" | "end";
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={anchor} type="button" className="n-seg" aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpen(!open)}>
        {lead}
        <span>{label}</span>
      </button>
      <Pop open={open} onClose={() => onOpen(false)} anchor={anchor} align={align} gap={8} role="dialog" label={typeof label === "string" ? label : "Panel"} className={`n-pop ${popClass}`} exitMs={160}>
        {pop}
      </Pop>
    </>
  );
}

/**
 * The whole chrome: one line in the mono voice the app already uses for labels.
 * Left says where you are, right says what state it is in. Entering the diagram
 * hands the right half to the canvas.
 */
export function StatusLine({ saved }: { saved: React.RefObject<HTMLSpanElement | null> }) {
  const { ui, act } = useUi();
  const [open, setOpen] = useState<"project" | "page" | "history" | "share" | null>(null);
  const [seen, setSeen] = useState(ui.pageId);
  const page = ui.pages.find((p) => p.id === ui.pageId);
  const diagram = ui.mode === "diagram";

  // Picking a page is the end of looking for one — unless it was just made and
  // is still being named, in which case the list is where that happens.
  if (ui.pageId !== seen) {
    setSeen(ui.pageId);
    if (!ui.renaming) setOpen(null);
  }
  const toggle = (name: NonNullable<typeof open>) => (on: boolean) => setOpen(on ? name : null);

  return (
    <header className="n-status">
      <nav className="n-crumbs" aria-label="Where you are">
        <Link href="/" className="n-seg">
          <ArrowLeft width={12} height={12} />
          <span>Projects</span>
        </Link>
        <i>/</i>
        <Seg
          label="Rate limiting"
          open={open === "project"}
          onOpen={toggle("project")}
          popClass="n-pop-project"
          pop={
            <>
              <ProjectTitle />
              <ContextRow />
              <FindButton />
            </>
          }
        />
        <i>/</i>
        <Seg label={page?.title || "Untitled"} open={open === "page"} onOpen={toggle("page")} popClass="n-pop-pages" pop={<Pages />} />
      </nav>

      <div className="n-state" data-on={!diagram} inert={diagram}>
        <span className="n-fact">
          {ui.pages.length} {ui.pages.length === 1 ? "page" : "pages"}
        </span>
        <i>·</i>
        <span className="n-fact n-here">
          <Facepile />2 here
        </span>
        <i>·</i>
        <span ref={saved} className="n-fact n-saved" role="status" data-saving="false">
          <span>Saved</span>
          <span>Saving…</span>
        </span>
        <Seg
          label="History"
          lead={<RotateCcw width={12} height={12} />}
          align="end"
          open={open === "history"}
          onOpen={toggle("history")}
          popClass="n-pop-history"
          pop={
            <div className="n-history">
              <Chat />
            </div>
          }
        />
        <button type="button" className="n-seg" aria-label="Find a page or an action" onClick={() => act.set({ palette: true })}>
          <kbd className="ek-kbd">⌘K</kbd>
        </button>
        <Seg label="Share" align="end" open={open === "share"} onOpen={toggle("share")} popClass="ek-pop-share" pop={<SharePanel />} />
        <Account align="end" />
      </div>

      <div className="n-state is-canvas" data-on={diagram} inert={!diagram}>
        <button type="button" className="n-seg" aria-pressed={ui.left} onClick={() => act.set({ left: !ui.left })}>
          <span>Layers</span>
          <kbd className="ek-kbd">⌘\</kbd>
        </button>
        <button type="button" className="n-seg" aria-pressed={ui.right} onClick={() => act.set({ right: !ui.right })}>
          <span>Design</span>
          <kbd className="ek-kbd">⌘J</kbd>
        </button>
        <i>·</i>
        <button type="button" className="n-seg" onClick={() => act.set({ mode: "page", expanded: false })}>
          <kbd className="ek-kbd">esc</kbd>
          <span>Back to page</span>
        </button>
      </div>
    </header>
  );
}

type Exchange = { you: Extract<Msg, { from: "you" }>; ai?: Extract<Msg, { from: "ai" }> };

/**
 * The assistant, in the flow of the page. It opens where it was asked, answers
 * there, and once its changes are settled it folds to one line of record — the
 * conversation is part of the page's history, not a room beside it.
 */
export function InlineAsk() {
  const { ui, act } = useUi();
  const scene = useScene();
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState(false);
  const [unfolded, setUnfolded] = useState<string[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const first = useRef(true);
  const open = ui.right && ui.mode === "page";
  const busy = ui.streaming !== null;

  useEffect(() => {
    // Not on arrival: the page opens with the caret in nobody's hands.
    if (first.current) {
      first.current = false;
      return;
    }
    if (open) box.current?.focus({ preventScroll: true });
  }, [open]);

  // What was said here, as opposed to what the thread already held.
  const base = ui.thread === threads[0].title ? thread.length : 0;
  const exchanges: Exchange[] = [];
  for (const m of ui.msgs.slice(base)) {
    if (m.from === "you") exchanges.push({ you: m });
    else if (exchanges.length) exchanges[exchanges.length - 1].ai = m;
  }

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    act.send(text);
    setDraft("");
    setFile(false);
    if (box.current) box.current.style.height = "";
  };

  return (
    <div className="n-ask" contentEditable={false}>
      {exchanges.map((x, i) => {
        const last = i === exchanges.length - 1;
        const live = last && !x.ai;
        const settled = !live && !(last && ui.review === "open");
        const outcome = !last ? "Answered" : ui.review === "kept" ? "Kept 2 changes" : ui.review === "discarded" ? "Discarded" : "Answered";
        const folded = settled && !unfolded.includes(x.you.id);
        const flip = () => setUnfolded((u) => (u.includes(x.you.id) ? u.filter((id) => id !== x.you.id) : [...u, x.you.id]));
        return (
          <section key={x.you.id} className="n-exchange" data-folded={folded} data-live={live}>
            <button type="button" className="n-record" disabled={!settled} aria-expanded={!folded} onClick={flip}>
              <b>Asked</b>
              <span className="n-record-text">{x.you.text}</span>
              {settled && <em>{outcome}</em>}
            </button>
            <div className="n-fold" inert={folded}>
              <div className="n-reply">
                {live && ui.streaming === "" && (
                  <span className="n-step is-running">
                    <i className="ek-dot" />
                    Reading Rate limiting…
                  </span>
                )}
                {x.ai?.steps?.map((s) => (
                  <span key={s} className="n-step">
                    {s}
                  </span>
                ))}
                {(x.ai || ui.streaming) && (
                  <p className="n-answer" data-live={live}>
                    {x.ai?.text ?? ui.streaming}
                    {live && <i className="ek-stream-head" />}
                  </p>
                )}
                {last && ui.review === "open" && (
                  <div className="n-review" role="status">
                    <span>
                      <b>2 changes</b> · 1 page
                    </span>
                    <button type="button" className="ek-btn" onClick={() => act.set({ review: "discarded" })}>
                      Discard
                    </button>
                    <button
                      type="button"
                      className="ek-btn is-ink"
                      onClick={() => {
                        act.set({ review: "kept", right: false });
                        scene.act.applyProposal();
                        act.toast("Kept 2 changes", "Undo");
                      }}
                    >
                      Keep
                    </button>
                  </div>
                )}
              </div>
            </div>
          </section>
        );
      })}

      <div className="n-fold n-composer-fold" data-open={open} inert={!open}>
        <div>
          <div className="n-composer" data-busy={busy || undefined}>
            <Sparkle width={16} height={16} className="n-composer-mark" />
            <div className="n-composer-body">
              {file && (
                <span className="ek-chip">
                  <FileDoc width={12} height={12} />
                  limits.csv
                  <button type="button" aria-label="Remove limits.csv" onClick={() => setFile(false)}>
                    <X width={10} height={10} />
                  </button>
                </span>
              )}
              <textarea
                ref={box}
                rows={1}
                aria-label="Ask Nootles"
                placeholder="Ask about this page, or describe a change…"
                value={draft}
                onChange={(e) => {
                  setDraft(e.currentTarget.value);
                  e.currentTarget.style.height = "";
                  e.currentTarget.style.height = `${Math.min(180, e.currentTarget.scrollHeight)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                  if (e.key === "Escape") act.set({ right: false });
                }}
              />
              <div className="n-composer-foot">
                <IconBtn tip="Attach a file" className="is-sm" onClick={() => setFile(true)}>
                  <Paperclip width={14} height={14} />
                </IconBtn>
                <span className="n-hint">
                  {ui.docMode} · <kbd>↵</kbd> send · <kbd>esc</kbd> close
                </span>
                <button type="button" className="n-send" aria-label="Send" disabled={busy || !draft.trim()} onClick={send}>
                  <ArrowUp width={14} height={14} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
