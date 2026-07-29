"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Paperclip, X } from "../Icons";
import { ChatModeToggle } from "./ChatModeToggle";
import { MentionMenu } from "./MentionMenu";
import {
  acceptFile,
  uploadAttachment,
  ATTACHMENT_ACCEPT,
  type PendingAttachment,
} from "@/app/lib/ai/chat/attachments";
import {
  filterMentions,
  insertMention,
  keptMentions,
  mentionItems,
  mentionLabel,
  mentionTrigger,
  type MentionItem,
  type MentionPick,
} from "@/app/lib/ai/chat/mentions";
import type { ChatMode } from "@/app/lib/ai/chat/types";
import type { ChatDraft } from "@/app/lib/ai/chat/useProjectChat";

/**
 * The ask box.
 *
 * Grows with what you type up to a ceiling, the way every chat composer does —
 * a fixed one-line box hides the paragraph you are trying to write, and a
 * fixed-tall one wastes the panel when you are asking a short question.
 *
 * The mode sits on the action row rather than in the panel header: it is part
 * of what you are about to send, and it is the last thing you want to change
 * before sending it.
 *
 * Files are read and checked the moment they are dropped, but uploaded only on
 * Send: a file you thought better of never reaches storage.
 */
export function ChatComposer({
  disabled,
  busy,
  mode,
  projectId,
  pageId,
  onModeChange,
  onSend,
  onStop,
}: {
  disabled: boolean;
  busy: boolean;
  mode: ChatMode;
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
  onModeChange: (mode: ChatMode) => void;
  onSend: (draft: ChatDraft) => Promise<void>;
  onStop: () => void;
}) {
  const convex = useConvex();
  const pages = useQuery(api.pages.listByProject, { projectId });

  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  /**
   * The "@" that is finished with — dropped by Escape, or already picked. Held
   * as what was dismissed rather than only where: the "@" of a picked mention
   * stays at its offset while the label after it is edited, so an offset alone
   * would shut the menu for that "@" for good — and correcting a wrong mention
   * is the commonest reason to touch a label at all.
   */
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null);
  const [dropping, setDropping] = useState(false);
  const [sending, setSending] = useState(false);

  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Where the caret goes once React has written the new text. */
  const restore = useRef<number | null>(null);
  const menuId = useId();

  // Derived during render rather than tracked: the menu IS the "@" being typed.
  const trigger = disabled ? null : mentionTrigger(text, caret);
  const items = trigger
    ? filterMentions(
        mentionItems({
          pages: pages ?? [],
          openPageId: pageId,
          filenames: files.map((file) => file.filename),
        }),
        trigger.query,
      )
    : [];
  // Nothing matching closes it, which is also what stops a query with spaces in
  // it from running to the end of the sentence. A dismissal holds only while the
  // query still grows out of the one that was dismissed: writing on past a
  // mention keeps the menu shut, editing back into its label brings it back.
  const open =
    trigger !== null &&
    items.length > 0 &&
    !(dismissed?.start === trigger.start && trigger.query.startsWith(dismissed.query));
  const activeIndex = Math.min(active, items.length - 1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured, not computed: reset first so the box can shrink again.
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    if (restore.current !== null) {
      el.focus();
      el.setSelectionRange(restore.current, restore.current);
      restore.current = null;
    }
  }, [text]);

  const write = (el: HTMLTextAreaElement) => {
    setText(el.value);
    setCaret(el.selectionStart);
    setActive(0);
    // An offset names a finished "@" only while that "@" is still at it —
    // otherwise a later one landing on the same spot would open closed.
    if (dismissed && el.value[dismissed.start] !== "@") setDismissed(null);
  };

  const take = (item: MentionItem) => {
    if (!trigger) return;
    const label = mentionLabel(item.pick);
    const next = insertMention(text, caret, trigger, label);
    // Taking a label that was already typed out in full leaves the text alone,
    // and there is then no render to put the caret back in — do it here, or the
    // request waits in the ref and fires against the next keystroke.
    if (next.text === text) ref.current?.setSelectionRange(next.caret, next.caret);
    else restore.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setPicks((current) => [...current, item.pick]);
    // The label just written still reads as a query for the same "@", and it
    // matches the row it came from — so without this the menu reopens on the
    // mention that was picked, and Enter picks it again instead of sending.
    // `insertMention` leaves a space after the label, so that is the query.
    setDismissed({ start: trigger.start, query: `${label} ` });
    setActive(0);
  };

  const attach = async (chosen: FileList | File[]) => {
    const accepted: PendingAttachment[] = [];
    const refused: string[] = [];
    for (const file of Array.from(chosen)) {
      try {
        accepted.push(await acceptFile(file));
      } catch (error) {
        refused.push((error as Error).message);
      }
    }
    if (accepted.length) setFiles((current) => [...current, ...accepted]);
    // One refusal at a time: a list of them in a panel this narrow is a wall.
    setNote(refused[0] ?? null);
  };

  const ready = !disabled && !busy && !sending && (text.trim().length > 0 || files.length > 0);

  const submit = async () => {
    if (!ready) return;
    setSending(true);
    try {
      const attachments = await Promise.all(files.map((file) => uploadAttachment(convex, file)));
      await onSend({ text: text.trim(), attachments, mentions: keptMentions(picks, text) });
      setText("");
      setCaret(0);
      setFiles([]);
      setPicks([]);
      setDismissed(null);
      setNote(null);
    } catch (error) {
      // The draft is still here, so this is something to try again, not to mourn.
      setNote((error as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={`ab-composer${dropping ? " is-dropping" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        void attach(e.dataTransfer.files);
      }}
    >
      {open && (
        <MentionMenu
          id={menuId}
          items={items}
          active={activeIndex}
          onPick={take}
          onHover={setActive}
        />
      )}

      {note && (
        <p role="status" className="ab-composer-note">
          {note}
        </p>
      )}

      {files.length > 0 && (
        <div className="ab-composer-files">
          {files.map((file) => (
            <span key={file.id} className="ab-chip">
              <span className="ab-chip-label">{file.filename}</span>
              <button
                className="ab-chip-remove"
                aria-label={`Remove ${file.filename}`}
                onClick={() => setFiles((current) => current.filter((f) => f.id !== file.id))}
              >
                <X width={11} height={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        rows={1}
        value={text}
        disabled={disabled}
        aria-label="Ask auto-board"
        // The box stays a textbox rather than becoming a combobox: it is one for
        // three keystrokes out of a message, and the role would cost it
        // `aria-multiline` for the rest. `aria-activedescendant` is what a
        // textbox has for exactly this, and it is what announces the row.
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
        placeholder="Ask, or describe a change…"
        className="ab-composer-input"
        onChange={(e) => write(e.target)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          if (!e.clipboardData.files.length) return;
          e.preventDefault();
          void attach(e.clipboardData.files);
        }}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : items.length - 1;
              setActive((activeIndex + step) % items.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              take(items[activeIndex]);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setDismissed({ start: trigger.start, query: trigger.query });
              return;
            }
          }
          // Enter sends, Shift-Enter is a newline. Modifier-Enter also sends,
          // because people who use it expect it to.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />

      <div className="ab-composer-actions">
        <div className="flex items-center gap-1">
          <ChatModeToggle mode={mode} onChange={onModeChange} />
          <button
            className="ab-composer-attach"
            onClick={() => fileInput.current?.click()}
            disabled={disabled}
            aria-label="Attach a file"
            title="Attach a file"
          >
            <Paperclip width={14} height={14} />
          </button>
        </div>
        {busy ? (
          <button className="ab-composer-send" onClick={onStop} title="Stop">
            Stop
          </button>
        ) : (
          <button
            className="ab-composer-send"
            onClick={() => void submit()}
            disabled={!ready}
            title="Send (↵)"
          >
            Send
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept={ATTACHMENT_ACCEPT}
        onChange={(e) => {
          void attach(e.target.files ?? []);
          // Cleared so choosing the same file twice in a row still fires.
          e.target.value = "";
        }}
      />
    </div>
  );
}
