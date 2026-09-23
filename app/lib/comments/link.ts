/**
 * The address of a comment thread: `/p/<projectId>?page=<pageId>&thread=<threadId>`.
 *
 * `page` is consumed by the workspace, which opens that page and drops the
 * param. `thread` is left in place for the comments surface to find — it
 * focuses the thread, whose id is its NML block id in the page's comments
 * document, and drops the param itself.
 */

export const PAGE_PARAM = "page";
export const THREAD_PARAM = "thread";

export function commentHref(target: {
  projectId: string;
  pageId: string;
  threadId: string;
}): string {
  const query = new URLSearchParams({
    [PAGE_PARAM]: target.pageId,
    [THREAD_PARAM]: target.threadId,
  });
  return `/p/${encodeURIComponent(target.projectId)}?${query}`;
}

export type InboxNotice = {
  noticeId: string;
  kind: "mention" | "reply" | "resolved";
  projectId: string;
  projectTitle: string;
  pageId: string;
  pageTitle: string;
  threadId: string;
  actorName: string | null;
  actorImageUrl: string | null;
  createdAt: number;
};

/** One thread's unseen notices, as the inbox draws them: one notice speaks for all. */
export type InboxThread = { lead: InboxNotice; noticeIds: string[] };

/**
 * Notices grouped by thread, newest thread first. A mention outranks a reply
 * or a resolve in the same thread — being named is the reason to look — so
 * the card leads with it even when something later happened there.
 */
export function inboxThreads(notices: InboxNotice[]): InboxThread[] {
  const byThread = new Map<string, InboxThread>();
  const rank = (n: InboxNotice) => (n.kind === "mention" ? 1 : 0);
  for (const notice of [...notices].sort((a, b) => b.createdAt - a.createdAt)) {
    const key = `${notice.pageId}/${notice.threadId}`;
    const group = byThread.get(key);
    if (!group) {
      byThread.set(key, { lead: notice, noticeIds: [notice.noticeId] });
      continue;
    }
    group.noticeIds.push(notice.noticeId);
    if (rank(notice) > rank(group.lead)) group.lead = notice;
  }
  return [...byThread.values()];
}

/** What happened, in the words the card uses after the actor's name. */
export function noticeVerb(kind: InboxNotice["kind"]): string {
  switch (kind) {
    case "mention":
      return "mentioned you on";
    case "reply":
      return "replied on";
    case "resolved":
      return "resolved a thread on";
  }
}
