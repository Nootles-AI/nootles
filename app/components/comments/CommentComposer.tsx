"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  insertMention,
  mentionLabel,
  mentionTrigger,
  personMentionItems,
  type MentionItem,
  type MentionPick,
} from "@/app/lib/ai/chat/mentions";
import { canPost, commentBody, draftMentions, outsiderNote, type Person } from "@/app/lib/comments/compose";
import { MentionMenu } from "../MentionMenu";

/**
 * The box a comment is written in — a new thread's, a reply's, an edit's.
 *
 * A comment is one paragraph (see `compose.ts`), so the box has no line
 * breaks: Enter posts, ⌘Enter posts, Shift+Enter does nothing rather than
 * write a break the document would read back as a space. Escape closes the
 * `@` menu first and cancels second.
 *
 * `@` offers the project's people (`mentionable`), as the chat composer offers
 * pages: picked, not typed, and a mention survives only while its `@Name` is
 * still in the words. The people still named go to `onSubmit`, which writes
 * the comment and sends the notice; someone the project can no longer reach
 * stops the post here, before anything is written.
 */
export function CommentComposer({
  people,
  initial = "",
  placeholder,
  submitLabel,
  label,
  autoFocus = false,
  onSubmit,
  onCancel,
  onFocus,
}: {
  /** Who an `@` may name. */
  people: readonly Person[];
  initial?: string;
  placeholder: string;
  submitLabel: string;
  label: string;
  autoFocus?: boolean;
  /** Write it; rejecting keeps the draft and shows why. */
  onSubmit: (body: string, mentions: string[], picks: MentionPick[]) => Promise<void>;
  /** Present when the box can be put away (a new thread, an edit); a reply box stays. */
  onCancel?: () => void;
  onFocus?: () => void;
}) {
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [picks, setPicks] = useState<MentionPick[]>([]);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<{ start: number; query: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const restore = useRef<number | null>(null);
  const menuId = useId();

  // As in the chat composer: the menu IS the "@" being typed, derived here.
  const trigger = mentionTrigger(text, caret);
  const items = trigger ? personMentionItems([...people], trigger.query) : [];
  const open =
    trigger !== null &&
    items.length > 0 &&
    !(dismissed?.start === trigger.start && trigger.query.startsWith(dismissed.query));
  const activeIndex = Math.min(active, items.length - 1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    if (restore.current !== null) {
      el.focus();
      el.setSelectionRange(restore.current, restore.current);
      restore.current = null;
    }
  }, [text]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // The menu is portalled — a card clips what overflows it — so it is placed
  // from the box's measured rect: below it, or above when the window ends.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const box = ref.current;
    if (!open || !anchor || !box) return;
    const r = box.getBoundingClientRect();
    const h = anchor.offsetHeight;
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    anchor.style.top = `${top}px`;
    anchor.style.left = `${Math.min(r.left, window.innerWidth - anchor.offsetWidth - 8)}px`;
  });

  const write = (el: HTMLTextAreaElement) => {
    setText(el.value);
    setCaret(el.selectionStart);
    setActive(0);
    setNote(null);
    if (dismissed && el.value[dismissed.start] !== "@") setDismissed(null);
  };

  const take = (item: MentionItem) => {
    if (!trigger) return;
    const label = mentionLabel(item.pick);
    const next = insertMention(text, caret, trigger, label);
    if (next.text === text) ref.current?.setSelectionRange(next.caret, next.caret);
    else restore.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setPicks((current) => [...current, item.pick]);
    setDismissed({ start: trigger.start, query: `${label} ` });
    setActive(0);
  };

  const ready = !sending && canPost(text);

  const submit = async () => {
    if (!ready) return;
    const { reachable, unreachable } = draftMentions(picks, text, people);
    if (unreachable.length) return setNote(outsiderNote(unreachable, picks, false));
    setSending(true);
    try {
      await onSubmit(commentBody(text), reachable, picks);
      setText("");
      setCaret(0);
      setPicks([]);
      setDismissed(null);
      setNote(null);
    } catch (error) {
      setNote((error as Error).message || "That didn't post. Try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="nt-comment-composer">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        aria-label={label}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open ? `${menuId}-${activeIndex}` : undefined}
        placeholder={placeholder}
        className="nt-comment-input"
        onChange={(e) => write(e.target)}
        onClick={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={onFocus}
        onKeyDown={(e) => {
          // Enter confirms an input method's candidate; it is not ours until composing ends.
          if (e.nativeEvent.isComposing) return;
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
              e.stopPropagation();
              setDismissed({ start: trigger.start, query: trigger.query });
              return;
            }
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (!e.shiftKey) void submit();
            return;
          }
          if (e.key === "Escape" && onCancel) {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {note && (
        <p role="alert" className="nt-comment-note">
          {note}
        </p>
      )}
      {(onCancel || text.length > 0) && (
        <div className="nt-comment-actions">
          {onCancel && (
            <button type="button" className="nt-comment-btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            type="button"
            className="nt-comment-btn is-primary"
            disabled={!ready}
            onClick={() => void submit()}
          >
            {submitLabel}
          </button>
        </div>
      )}
      {open &&
        createPortal(
          <div ref={anchorRef} className="nt-mention-anchor">
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
    </div>
  );
}
