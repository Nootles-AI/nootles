"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { threads } from "./data";
import { useScene, useUi } from "./store";
import { IconBtn } from "./controls";
import { Group, Item, Pop } from "./overlays";
import { ChevronsUpDown, FileDoc, Paperclip, Plus, Rewind, X } from "./icons";

/**
 * The assistant. Nothing here reaches a model: a reply is a script typed out on
 * a timer, and "Keep" applies a change that was written in advance.
 */
export function Chat({ end }: { end?: ReactNode }) {
  const { ui, act } = useUi();
  const scene = useScene();
  const [picking, setPicking] = useState(false);
  const [rewind, setRewind] = useState<string | null>(null);
  const [mention, setMention] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const pick = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const rewindAt = useRef<HTMLElement | null>(null);
  const busy = ui.streaming !== null;

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [ui.msgs.length, ui.streaming]);

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    act.send(text);
    setDraft("");
    setFiles([]);
    if (box.current) box.current.style.height = "";
  };

  return (
    <div className="ek-chat">
      <header className="ek-panel-head">
        <button ref={pick} type="button" className="ek-row ek-chat-thread" aria-expanded={picking} data-tip="Switch chat" data-tip-side="bottom" onClick={() => setPicking((o) => !o)}>
          <span className="ek-row-label">{ui.thread}</span>
          <ChevronsUpDown width={12} height={12} />
        </button>
        <IconBtn tip="New chat" side="bottom" onClick={act.newThread}>
          <Plus width={16} height={16} />
        </IconBtn>
        {end}
      </header>
      <Pop open={picking} onClose={() => setPicking(false)} anchor={pick} label="Chats" className="ek-pop-wide">
        {threads.map((t) => (
          <Item
            key={t.title}
            label={t.title}
            checked={t.title === ui.thread}
            end={<span className="ek-meta">{t.age}</span>}
            onSelect={() => act.set({ thread: t.title })}
          />
        ))}
      </Pop>

      <div ref={log} className="ek-chat-log">
        {ui.msgs.length === 0 && !busy && (
          <div className="ek-chat-empty">
            <b>Ask about this project</b>
            <span>Questions are answered from what the pages actually say.</span>
          </div>
        )}
        {ui.msgs.map((m) =>
          m.from === "you" ? (
            <div key={m.id} className="ek-turn is-you">
              <p>{m.text}</p>
              <button
                type="button"
                className="ek-rewind"
                onClick={(e) => {
                  rewindAt.current = e.currentTarget;
                  setRewind(m.id);
                }}
              >
                <Rewind width={12} height={12} />
                Rewind
              </button>
            </div>
          ) : (
            <div key={m.id} className="ek-turn is-ai">
              {m.steps?.map((s) => (
                <span key={s} className="ek-step">
                  {s}
                </span>
              ))}
              <p>{m.text}</p>
            </div>
          ),
        )}
        {busy && (
          <div className="ek-turn is-ai is-live">
            {ui.streaming === "" ? (
              <span className="ek-step is-running">
                <i className="ek-dot" />
                Reading Rate limiting…
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
      <Pop open={rewind !== null} onClose={() => setRewind(null)} anchor={rewindAt} label="Rewind" className="ek-pop-wide">
        <Group>Rewind to here</Group>
        <Item label="Notes and conversation" hint="Undo the page, drop this exchange" onSelect={() => act.toast("Rewound notes and conversation", "Undo")} />
        <Item label="Conversation only" hint="Drop this exchange, keep the notes" />
        <Item label="Notes only" hint="Undo the page, keep the conversation" />
      </Pop>

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
            }}
          >
            Keep
          </button>
        </div>
      )}

      <div className="ek-composer" data-filled={draft.trim() !== "" || undefined}>
        {files.length > 0 && (
          <div className="ek-chips">
            {files.map((f) => (
              <span key={f} className="ek-chip">
                <FileDoc width={12} height={12} />
                {f}
                <button type="button" aria-label={`Remove ${f}`} onClick={() => setFiles((x) => x.filter((y) => y !== f))}>
                  <X width={10} height={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          rows={1}
          aria-label="Ask Nootles"
          placeholder="Ask, or describe a change…"
          value={draft}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setMention(e.currentTarget.value.endsWith("@"));
            e.currentTarget.style.height = "";
            e.currentTarget.style.height = `${Math.min(200, e.currentTarget.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !mention) {
              e.preventDefault();
              send();
            }
            if (e.key === "Escape") setMention(false);
          }}
        />
        <div className="ek-composer-acts">
          <IconBtn tip="Attach a file" className="is-sm" onClick={() => setFiles((f) => (f.includes("limits.csv") ? f : [...f, "limits.csv"]))}>
            <Paperclip width={14} height={14} />
          </IconBtn>
          <button type="button" className="ek-send" disabled={!busy && !draft.trim()} data-tip={busy ? undefined : "Send"} data-keys="↵" onClick={send}>
            {busy ? "Stop" : "Send"}
          </button>
        </div>
      </div>
      <Pop open={mention} onClose={() => setMention(false)} anchor={box} side="top" focus={false} label="Link to page" className="ek-pop-wide">
        <Group>Link to page</Group>
        {ui.pages.slice(0, 5).map((p) => (
          <Item
            key={p.id}
            icon={<FileDoc width={14} height={14} />}
            label={p.title || "Untitled"}
            onSelect={() => {
              setDraft((d) => `${d}${p.title} `);
              box.current?.focus();
            }}
          />
        ))}
      </Pop>
    </div>
  );
}
