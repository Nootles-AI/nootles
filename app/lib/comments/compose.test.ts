import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { insertMention, mentionTrigger, personMentionItems, type MentionPick } from "@/app/lib/ai/chat/mentions";
import {
  authorName,
  canPost,
  commentBody,
  draftMentions,
  initials,
  listNames,
  outsiderNote,
  refusedOutsiders,
  timeAgo,
} from "./compose";

const CAM: MentionPick = { kind: "person", userId: "user_cam", name: "Cam Commenter" };
const DEE: MentionPick = { kind: "person", userId: "user_dee", name: "Dee" };
const people = [
  { userId: "user_ada", name: "Ada Editor" },
  { userId: "user_cam", name: "Cam Commenter" },
];

describe("a draft's body", () => {
  it("is one paragraph: whitespace collapses and the ends are trimmed", () => {
    expect(commentBody("  Is this\n\nright?\t ")).toBe("Is this right?");
  });

  it("cannot be posted empty or all whitespace", () => {
    expect(canPost("")).toBe(false);
    expect(canPost(" \n\t ")).toBe(false);
    expect(canPost(" x ")).toBe(true);
  });
});

describe("mentions in a draft", () => {
  it("typing @ offers the project's people and picking writes @Name with a space", () => {
    const text = "Ask @ca";
    const trigger = mentionTrigger(text, text.length)!;
    expect(trigger).toEqual({ start: 4, query: "ca" });
    const [row] = personMentionItems(people, trigger.query);
    expect(row.pick).toEqual({ kind: "person", userId: "user_cam", name: "Cam Commenter" });
    expect(insertMention(text, text.length, trigger, row.label)).toEqual({ text: "Ask @Cam Commenter ", caret: 19 });
  });

  it("names only the people whose @Name is still in the words", () => {
    expect(draftMentions([CAM], "Ask @Cam Commenter now", people)).toEqual({ reachable: ["user_cam"], unreachable: [] });
    expect(draftMentions([CAM], "Ask Cam now", people)).toEqual({ reachable: [], unreachable: [] });
    expect(draftMentions([CAM, CAM], "@Cam Commenter @Cam Commenter", people).reachable).toEqual(["user_cam"]);
  });

  it("splits out someone the project can no longer reach", () => {
    expect(draftMentions([CAM, DEE], "@Cam Commenter and @Dee", people)).toEqual({
      reachable: ["user_cam"],
      unreachable: ["user_dee"],
    });
  });
});

describe("an outsider refusal", () => {
  it("is recognised by its code and yields the ids", () => {
    const refusal = new ConvexError({ code: "outsider", userIds: ["user_dee"], message: "no" });
    expect(refusedOutsiders(refusal)).toEqual(["user_dee"]);
    expect(refusedOutsiders(new ConvexError("Comments are turned off"))).toBeNull();
    expect(refusedOutsiders(new ConvexError({ code: "other" }))).toBeNull();
    expect(refusedOutsiders(new Error("outsider"))).toBeNull();
  });

  it("is told with the names the writer picked, before and after writing", () => {
    expect(outsiderNote(["user_dee"], [CAM, DEE], false)).toBe("Dee can't open this project. Remove the mention to post.");
    expect(outsiderNote(["user_dee", "user_cam"], [CAM, DEE], true)).toBe(
      "Posted, but Dee and Cam Commenter can't open this project, so they weren't told.",
    );
    expect(outsiderNote(["user_x"], [], true)).toBe(
      "Posted, but Someone you mentioned can't open this project, so they weren't told.",
    );
  });

  it("lists names the way a sentence does", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["A"])).toBe("A");
    expect(listNames(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("who and when", () => {
  it("signs the reader's own comments You, others by name, never by id", () => {
    expect(authorName("user_ada", "user_ada", people)).toBe("You");
    expect(authorName("user_cam", "user_ada", people)).toBe("Cam Commenter");
    expect(authorName("user_gone", "user_ada", people)).toBe("Someone");
    expect(authorName("user_cam", null, [{ userId: "user_cam", name: "  " }])).toBe("Someone");
  });

  it("makes initials", () => {
    expect(initials("Cam Commenter")).toBe("CC");
    expect(initials("ada")).toBe("A");
    expect(initials("Mary Ann Evans")).toBe("ME");
    expect(initials(" ")).toBe("?");
  });

  it("writes ages as Docs does", () => {
    const now = new Date(2026, 8, 23, 15, 0).getTime();
    expect(timeAgo(now - 20_000, now)).toBe("Just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h");
    expect(timeAgo(new Date(2026, 8, 22, 23, 0).getTime(), now)).toBe("Yesterday");
    expect(timeAgo(new Date(2026, 8, 12, 9, 0).getTime(), now)).toMatch(/Sep|12/);
    expect(timeAgo(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});
