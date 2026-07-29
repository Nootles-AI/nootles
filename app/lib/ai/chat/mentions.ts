"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { runClientTool, type ToolContext } from "./clientTools";
import type { MentionData } from "./parts";

/**
 * "@" in the composer.
 *
 * A mention is picked, not typed: the menu writes a label into the box for the
 * user to read, and records what was picked beside it. The label is prose and
 * the user may edit or delete it, which is why nothing is ever resolved from it
 * — it only decides whether the mention is still meant (see `keptMentions`).
 */

export type MentionPick =
  | { kind: "page"; pageId: Id<"pages">; title: string }
  | { kind: "file"; filename: string };

export type MentionItem = {
  key: string;
  label: string;
  /** The second line: what this row will actually attach. */
  hint?: string;
  pick: MentionPick;
};

export type MentionTrigger = { start: number; query: string };

/** How a pick reads inside the sentence the user is writing. */
export function mentionLabel(pick: MentionPick): string {
  return pick.kind === "page" ? pick.title.trim() || "Untitled" : pick.filename;
}

/**
 * The "@" being typed, if there is one.
 *
 * Only after whitespace, so an email address is not a menu. The query may hold
 * spaces because page titles do; what stops it running away is the menu itself,
 * which closes as soon as nothing matches.
 */
export function mentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1) return null;
  if (start > 0 && !/[\s(["']/.test(before[start - 1])) return null;
  const query = before.slice(start + 1);
  if (/[\n@]/.test(query)) return null;
  return { start, query };
}

/**
 * Replaces the "@…" being typed with the label, and says where the caret goes.
 *
 * One space after it, whoever supplied it: picking mid-sentence would otherwise
 * leave two, and leaving none puts the next word against the label.
 */
export function insertMention(
  text: string,
  caret: number,
  trigger: MentionTrigger,
  label: string,
): { text: string; caret: number } {
  const head = `${text.slice(0, trigger.start)}@${label} `;
  const tail = text.slice(caret);
  return { text: head + (tail.startsWith(" ") ? tail.slice(1) : tail), caret: head.length };
}

/**
 * The mentions still standing in what was written.
 *
 * Deleting the label is how a mention is taken back — there is nothing else to
 * click — so a pick survives only while its own words are still in the box.
 */
export function keptMentions(picks: MentionPick[], text: string): MentionPick[] {
  const seen = new Set<string>();
  return picks.filter((pick) => {
    const key = pick.kind === "page" ? pick.pageId : pick.filename;
    if (seen.has(key) || !text.includes(`@${mentionLabel(pick)}`)) return false;
    seen.add(key);
    return true;
  });
}

export function mentionItems({
  pages,
  openPageId,
  filenames,
}: {
  pages: { _id: Id<"pages">; title: string }[];
  openPageId: Id<"pages"> | null;
  filenames: string[];
}): MentionItem[] {
  const open = pages.find((p) => p._id === openPageId);
  return [
    ...(open
      ? [
          {
            key: "current",
            label: "Current page",
            hint: open.title.trim() || "Untitled",
            pick: { kind: "page" as const, pageId: open._id, title: open.title },
          },
        ]
      : []),
    ...pages.map((page) => ({
      key: page._id,
      label: page.title.trim() || "Untitled",
      hint: "Page",
      pick: { kind: "page" as const, pageId: page._id, title: page.title },
    })),
    ...filenames.map((filename) => ({
      key: `file:${filename}`,
      label: filename,
      hint: "Attached file",
      pick: { kind: "file" as const, filename },
    })),
  ];
}

export function filterMentions(items: MentionItem[], query: string): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q),
  );
}

/**
 * What each mention was pointing at, read when the message is sent.
 *
 * A page goes through the same two tools the agent reads pages with, and for the
 * same reason: the open one is read from the live editor, down to the keystroke
 * before Send, and any other from the copy on the server. Building a second way
 * to read a page is how the two would come to disagree.
 *
 * A read that fails carries its own sentence instead of the page — the model can
 * act on "there is no page with id …", and it is the same sentence it would have
 * got from the tool.
 */
export async function resolveMentions(
  picks: MentionPick[],
  ctx: ToolContext,
): Promise<MentionData[]> {
  return await Promise.all(
    picks.map(async (pick): Promise<MentionData> => {
      if (pick.kind === "file") return { kind: "file", filename: pick.filename };
      const live = ctx.openPageId() === pick.pageId;
      const content = await runClientTool(
        live ? "read_open_page" : "read_page",
        live ? {} : { pageId: pick.pageId },
        ctx,
      ).catch((error: Error) => error.message);
      return {
        kind: "page",
        pageId: pick.pageId,
        title: pick.title,
        content: typeof content === "string" ? content : "",
      };
    }),
  );
}
