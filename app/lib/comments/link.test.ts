import { describe, expect, test } from "vitest";
import { commentHref, inboxThreads, noticeVerb, PAGE_PARAM, THREAD_PARAM, type InboxNotice } from "./link";

const notice = (over: Partial<InboxNotice>): InboxNotice => ({
  noticeId: "n",
  kind: "reply",
  projectId: "proj",
  projectTitle: "Launch",
  pageId: "page1",
  pageTitle: "Plan",
  threadId: "t_1",
  actorName: "Ada",
  actorImageUrl: null,
  createdAt: 0,
  ...over,
});

describe("a thread's address", () => {
  test("names the project in the path, the page and thread in the query", () => {
    const href = commentHref({ projectId: "proj", pageId: "page1", threadId: "t_1" });
    expect(href).toBe("/p/proj?page=page1&thread=t_1");
    const url = new URL(href, "https://nootles.test");
    expect(url.searchParams.get(PAGE_PARAM)).toBe("page1");
    expect(url.searchParams.get(THREAD_PARAM)).toBe("t_1");
  });

  test("escapes what it is handed", () => {
    expect(commentHref({ projectId: "a/b", pageId: "p&q", threadId: "t 1" })).toBe(
      "/p/a%2Fb?page=p%26q&thread=t+1",
    );
  });
});

describe("the inbox groups notices by thread", () => {
  test("newest thread first, every notice id kept for marking seen", () => {
    const threads = inboxThreads([
      notice({ noticeId: "a", threadId: "t_1", createdAt: 1 }),
      notice({ noticeId: "b", threadId: "t_2", createdAt: 3 }),
      notice({ noticeId: "c", threadId: "t_1", createdAt: 2 }),
    ]);
    expect(threads.map((t) => [t.lead.noticeId, t.noticeIds])).toEqual([
      ["b", ["b"]],
      ["c", ["c", "a"]],
    ]);
  });

  test("a mention leads its thread's card even when a reply came later", () => {
    const [thread] = inboxThreads([
      notice({ noticeId: "m", kind: "mention", actorName: "Bram", createdAt: 1 }),
      notice({ noticeId: "r", kind: "reply", actorName: "Cleo", createdAt: 5 }),
    ]);
    expect(thread.lead.noticeId).toBe("m");
    expect(thread.noticeIds.sort()).toEqual(["m", "r"]);
  });

  test("one thread id on two pages is two threads", () => {
    expect(inboxThreads([notice({ pageId: "a" }), notice({ pageId: "b" })])).toHaveLength(2);
  });

  test("each kind reads as a sentence", () => {
    expect(["mention", "reply", "resolved"].map((k) => noticeVerb(k as InboxNotice["kind"]))).toEqual([
      "mentioned you on",
      "replied on",
      "resolved a thread on",
    ]);
  });
});
