"use client";

import { memo, useCallback, useState } from "react";
import type { MentionPick } from "@/app/lib/ai/chat/mentions";
import { authorName, initials, outsiderNote, timeAgo, type Person } from "@/app/lib/comments/compose";
import { commentText, type Comment, type Thread } from "@/app/lib/comments/types";
import { commentsScope } from "@/app/lib/history/undoRoute";
import { Check, MoreHorizontal, RotateCcw } from "../Icons";
import { Menu, MenuItem } from "../Menu";
import { CommentComposer } from "./CommentComposer";
import type { ThreadActions } from "./useThreadActions";

/** Hands a card's element to the margin's layout, for as long as it is mounted. */
export type Register = (id: string, el: HTMLElement) => () => void;

/** What every card on a page shares; one object, so a card re-renders only for its own thread. */
export type CardContext = {
  pageId: string;
  me: string | null;
  /** Everyone who can open the project, the reader included — whom comments are signed by. */
  authors: readonly Person[];
  /** Whom an `@` may name. */
  mentionable: readonly Person[];
  canComment: boolean;
  /**
   * May remove anyone's thread: someone holding the pen (owner or editor).
   * A thread's own author may remove it too; a reply is its author's alone.
   */
  canModerate: boolean;
  now: number;
  actions: ThreadActions;
  /** Choose this thread: the highlight and the card both answer. */
  choose: (threadId: string) => void;
  /** Say something under a thread (who a mention could not reach), or clear it. */
  note: (threadId: string, text: string | null) => void;
};

/**
 * One thread, as a card in the margin or a row of the panel.
 *
 * Unfocused it is a summary — the opening comment and how many replies follow
 * — so a margin of many threads stays short enough to stack. Focused, it
 * opens: every comment, and a reply box for anyone who may comment — on a
 * resolved thread too, where a reply reopens it, as in Docs.
 */
export const ThreadCard = memo(function ThreadCard({
  thread,
  focused,
  variant,
  notice,
  ctx,
  register,
}: {
  thread: Thread;
  focused: boolean;
  variant: "margin" | "panel";
  notice: string | null;
  ctx: CardContext;
  register?: Register;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const { id } = thread;
  const cardRef = useCallback(
    (el: HTMLElement | null) => (el && register ? register(id, el) : undefined),
    [register, id],
  );
  const [first, ...replies] = thread.comments;
  const resolved = thread.status === "resolved";
  const threadAuthor = first?.authorId === ctx.me;
  const mayDeleteThread = ctx.canComment && (ctx.canModerate || threadAuthor);
  const names = [...ctx.authors, ...ctx.mentionable].flatMap((p) => (p.name?.trim() ? [p.name.trim()] : []));

  const row = (comment: Comment, lead: boolean) => {
    const mine = ctx.me !== null && comment.authorId === ctx.me;
    const name = authorName(comment.authorId, ctx.me, ctx.authors);
    const face = ctx.authors.find((p) => p.userId === comment.authorId)?.imageUrl;
    if (editing === comment.id) {
      return (
        <li key={comment.id} className="nt-comment">
          <CommentComposer
            people={[]}
            initial={commentText(comment.content)}
            label="Edit comment"
            placeholder="Edit comment"
            submitLabel="Save"
            autoFocus
            onCancel={() => setEditing(null)}
            onSubmit={async (body) => {
              await ctx.actions.edit(comment.id, body);
              setEditing(null);
            }}
          />
        </li>
      );
    }
    const mayEdit = ctx.canComment && mine;
    const mayDelete = ctx.canComment && (mine || (lead && mayDeleteThread));
    return (
      <li key={comment.id} className="nt-comment">
        <div className="nt-comment-head">
          {face ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={face} alt="" className="nt-comment-face" />
          ) : (
            <span aria-hidden className="nt-monogram nt-comment-face">
              {initials(name === "You" ? (ctx.authors.find((p) => p.userId === ctx.me)?.name ?? "You") : name)}
            </span>
          )}
          <span className="nt-comment-who">
            <span className="nt-comment-name">{name}</span>
            <span className="nt-comment-meta">
              {comment.via === "assistant" && <span>via assistant</span>}
              <time dateTime={new Date(comment.createdAt).toISOString()}>{timeAgo(comment.createdAt, ctx.now)}</time>
              {comment.editedAt !== undefined && <span>edited</span>}
            </span>
          </span>
          <span className="nt-comment-tools">
            {lead && ctx.canComment && !resolved && (
              <button
                type="button"
                className="nt-icon-btn is-sm"
                aria-label="Resolve"
                title="Resolve"
                onClick={(e) => {
                  e.stopPropagation();
                  void ctx.actions.resolve(thread);
                }}
              >
                <Check width={14} height={14} />
              </button>
            )}
            {lead && ctx.canComment && resolved && (
              <button
                type="button"
                className="nt-icon-btn is-sm"
                aria-label="Reopen"
                title="Reopen"
                onClick={(e) => {
                  e.stopPropagation();
                  void ctx.actions.reopen(thread);
                }}
              >
                <RotateCcw width={13} height={13} />
              </button>
            )}
            {(mayEdit || mayDelete) && (
              <Menu
                label="Comment actions"
                side="bottom"
                align="end"
                trigger={(props) => (
                  <button
                    {...props}
                    type="button"
                    className="nt-icon-btn is-sm"
                    aria-label="More actions"
                    title="More actions"
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onClick();
                    }}
                  >
                    <MoreHorizontal width={14} height={14} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {mayEdit && (
                      <MenuItem
                        onClick={() => {
                          close({ restoreFocus: false });
                          ctx.choose(thread.id);
                          setEditing(comment.id);
                        }}
                      >
                        Edit
                      </MenuItem>
                    )}
                    {mayDelete && (
                      <MenuItem
                        danger
                        onClick={() => {
                          close({ restoreFocus: false });
                          void (lead ? ctx.actions.deleteThread(thread) : ctx.actions.deleteComment(thread, comment.id));
                        }}
                      >
                        {lead ? "Delete thread" : "Delete"}
                      </MenuItem>
                    )}
                  </>
                )}
              </Menu>
            )}
          </span>
        </div>
        <p className="nt-comment-body">{withMentions(commentText(comment.content), names)}</p>
      </li>
    );
  };

  return (
    <article
      ref={cardRef}
      className={`nt-comment-card is-${variant}`}
      data-thread-card={thread.id}
      data-focused={focused || undefined}
      data-resolved={resolved || undefined}
      tabIndex={-1}
      aria-label={`Comment thread on “${thread.anchor.exact}”`}
      {...commentsScope(ctx.pageId)}
      onClick={() => {
        if (!focused) ctx.choose(thread.id);
      }}
    >
      {variant === "panel" && <blockquote className="nt-comment-quote">{thread.anchor.exact}</blockquote>}
      {thread.ambiguous && <p className="nt-comment-aside">This text appears more than once</p>}
      {resolved && thread.resolvedBy && (
        <p className="nt-comment-aside">
          Resolved by {authorName(thread.resolvedBy, ctx.me, ctx.authors)}
          {thread.resolvedAt !== undefined && ` · ${timeAgo(thread.resolvedAt, ctx.now)}`}
        </p>
      )}
      <ol className="nt-comment-list">
        {first && row(first, true)}
        {focused ? (
          replies.map((reply) => row(reply, false))
        ) : replies.length ? (
          <li className="nt-comment-more">
            {replies.length} {replies.length === 1 ? "reply" : "replies"}
          </li>
        ) : null}
      </ol>
      {focused && ctx.canComment && (
        <CommentComposer
          people={ctx.mentionable}
          label="Reply"
          placeholder={resolved ? "Reply to reopen…" : "Reply…"}
          submitLabel="Reply"
          onSubmit={async (body: string, mentions: string[], picks: MentionPick[]) => {
            const { outsiders } = await ctx.actions.reply(thread, body, mentions);
            ctx.note(thread.id, outsiders.length ? outsiderNote(outsiders, picks, true) : null);
          }}
        />
      )}
      {notice && (
        <p role="status" className="nt-comment-note">
          {notice}
        </p>
      )}
    </article>
  );
});

/** `@Name` for the people this page knows, set apart from the words around it. */
function withMentions(text: string, names: readonly string[]) {
  const unique = [...new Set(names)].sort((a, b) => b.length - a.length);
  if (!unique.length || !text.includes("@")) return text;
  const escaped = unique.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = text.split(new RegExp(`(@(?:${escaped.join("|")}))`, "g"));
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="nt-comment-mention">
        {part}
      </span>
    ) : (
      part
    ),
  );
}
