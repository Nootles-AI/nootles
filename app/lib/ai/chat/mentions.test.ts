import { describe, expect, test } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import {
  filterMentions,
  keptMentions,
  mentionedPeople,
  mentionItems,
  mentionLabel,
  personMentionItems,
  resolveMentions,
  type MentionPick,
} from "./mentions";
import type { ToolContext } from "./clientTools";

const PEOPLE = [
  { userId: "user_bram", name: "Bram Editor" },
  { userId: "user_cleo", name: "Cleo Viewer" },
  { userId: "user_anon", name: null },
];

describe("people as mentions", () => {
  test("each person is a row labelled with their name, filtered by what was typed", () => {
    expect(personMentionItems(PEOPLE, "").map((i) => [i.key, i.label, i.hint])).toEqual([
      ["person:user_bram", "Bram Editor", undefined],
      ["person:user_cleo", "Cleo Viewer", undefined],
      ["person:user_anon", "Unnamed person", undefined],
    ]);
    expect(personMentionItems(PEOPLE, "cl").map((i) => i.pick)).toEqual([
      { kind: "person", userId: "user_cleo", name: "Cleo Viewer" },
    ]);
    expect(personMentionItems(PEOPLE, "  EDIT ").map((i) => i.label)).toEqual(["Bram Editor"]);
    expect(personMentionItems(PEOPLE, "zz")).toEqual([]);
  });

  test("a kept person mention survives only while its label is in the text, once", () => {
    const bram: MentionPick = { kind: "person", userId: "user_bram", name: "Bram Editor" };
    const cleo: MentionPick = { kind: "person", userId: "user_cleo", name: "Cleo Viewer" };
    expect(mentionLabel(bram)).toBe("Bram Editor");
    expect(keptMentions([bram, cleo, bram], "@Bram Editor can you check?")).toEqual([bram]);
    expect(mentionedPeople(keptMentions([bram, cleo, bram], "@Bram Editor and @Cleo Viewer"))).toEqual([
      "user_bram",
      "user_cleo",
    ]);
  });

  test("a person and a page with the same label are different mentions", () => {
    const page: MentionPick = { kind: "page", pageId: "p1" as Id<"pages">, title: "Bram" };
    const person: MentionPick = { kind: "person", userId: "user_bram", name: "Bram" };
    expect(keptMentions([page, person], "@Bram")).toEqual([page, person]);
    expect(mentionedPeople([page, person])).toEqual(["user_bram"]);
  });

  test("a person is never read into a chat message as context", async () => {
    const person: MentionPick = { kind: "person", userId: "user_bram", name: "Bram" };
    const file: MentionPick = { kind: "file", filename: "notes.md" };
    const ctx = { openPageId: () => null } as unknown as ToolContext;
    expect(await resolveMentions([person, file], ctx)).toEqual([{ kind: "file", filename: "notes.md" }]);
  });
});

describe("the chat composer's pages and files are unchanged", () => {
  test("current page first, then pages, then files", () => {
    const items = mentionItems({
      pages: [
        { _id: "p1" as Id<"pages">, title: "Plan" },
        { _id: "p2" as Id<"pages">, title: "" },
      ],
      openPageId: "p1" as Id<"pages">,
      filenames: ["a.txt"],
    });
    expect(items.map((i) => [i.key, i.label, i.hint])).toEqual([
      ["current", "Current page", "Plan"],
      ["p1", "Plan", "Page"],
      ["p2", "Untitled", "Page"],
      ["file:a.txt", "a.txt", "Attached file"],
    ]);
    expect(filterMentions(items, "file").map((i) => i.key)).toEqual(["file:a.txt"]);
  });

  test("a file and a page keep deduplicating by what they name", () => {
    const file: MentionPick = { kind: "file", filename: "a.txt" };
    const page: MentionPick = { kind: "page", pageId: "p1" as Id<"pages">, title: "Plan" };
    expect(keptMentions([file, file, page, page], "@a.txt and @Plan")).toEqual([file, page]);
  });
});
