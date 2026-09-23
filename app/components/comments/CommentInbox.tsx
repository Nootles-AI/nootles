"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { commentHref, inboxThreads, noticeVerb, type InboxThread } from "@/app/lib/comments/link";
import { X } from "../Icons";
import "../share/access.css";
import "./inbox.css";

/** By code point, not char: a name starting with an emoji keeps it whole. */
function initial(name: string | null) {
  return (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();
}

/** As many as one corner can hold; reading one uncovers the next. */
const AT_ONCE = 3;

/**
 * Comments that concern the caller — a mention, a reply in a thread they are
 * in, a thread of theirs resolved — in the corner access requests already use,
 * because it is the same kind of news: one person telling another something.
 *
 * Keyed on the caller, not a project, so it reaches them wherever they are
 * standing. A card is one thread: opening it goes to the thread and marks
 * everything it stood for as seen; the × marks it seen where it is.
 */
export function CommentInbox({ projectId }: { projectId?: Id<"projects"> }) {
  const notices = useQuery(api.commentNotices.inbox) ?? [];
  const markSeen = useMutation(api.commentNotices.markSeen);
  const router = useRouter();

  // Held rather than read live, as in `AccessRequests`: the rows go server-side
  // a moment after the click, and the card should not wait to leave with them.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const threads = inboxThreads(notices.filter((n) => !seen.has(n.noticeId)));

  const settle = (thread: InboxThread) => {
    setSeen((held) => new Set([...held, ...thread.noticeIds]));
    void markSeen({ ids: thread.noticeIds as Id<"commentNotices">[] }).catch(() => {});
  };

  const settleAll = () => {
    const ids = threads.flatMap((t) => t.noticeIds);
    setSeen((held) => new Set([...held, ...ids]));
    void markSeen({ ids: ids as Id<"commentNotices">[] }).catch(() => {});
  };

  if (!threads.length) return null;
  const rest = threads.length - AT_ONCE;

  return (
    <>
      {threads.slice(0, AT_ONCE).map((thread) => {
        const { lead } = thread;
        const elsewhere = lead.projectId !== projectId;
        return (
          <div key={`${lead.pageId}/${lead.threadId}`} className="nt-ask nt-notice" role="status">
            <button
              className="nt-notice-open"
              onClick={() => {
                settle(thread);
                router.push(commentHref(lead));
              }}
            >
              {lead.actorImageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={lead.actorImageUrl} alt="" className="nt-ask-face" />
              ) : (
                <span aria-hidden className="nt-monogram nt-ask-face">
                  {initial(lead.actorName)}
                </span>
              )}
              <span className="nt-ask-said">
                <strong className="font-medium">{lead.actorName ?? "Someone"}</strong>{" "}
                {noticeVerb(lead.kind)}{" "}
                <strong className="font-medium">{lead.pageTitle.trim() || "Untitled"}</strong>
                {elsewhere && (
                  <span className="nt-notice-where">
                    {" "}in {lead.projectTitle.trim() || "Untitled project"}
                  </span>
                )}
                {thread.noticeIds.length > 1 && (
                  <span className="nt-notice-where"> · {thread.noticeIds.length} new</span>
                )}
              </span>
            </button>
            <button className="nt-ask-x" aria-label="Mark as read" onClick={() => settle(thread)}>
              <X width={12} height={12} />
            </button>
          </div>
        );
      })}
      {rest > 0 && (
        <div className="nt-ask nt-notice-more" role="status">
          <span className="nt-ask-said">
            {rest} more {rest === 1 ? "thread" : "threads"} with news
          </span>
          <button className="nt-ask-no" onClick={settleAll}>
            Mark all read
          </button>
        </div>
      )}
    </>
  );
}
