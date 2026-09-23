import { ConvexError } from "convex/values";
import type { OutsiderRefusal } from "@/convex/commentNotices";
import { keptMentions, mentionedPeople, type MentionPick } from "@/app/lib/ai/chat/mentions";

/**
 * What the comment UI decides about a draft before and after it is written,
 * kept out of the components so it can be tested without a DOM.
 *
 * A comment is one NML paragraph, whose whitespace collapses: a line break
 * would be read back as a space. So the composer has no line breaks at all —
 * Enter posts, as it does in the chat, and what is posted is exactly what
 * `commentBody` shows.
 */

/** A draft as the comments document will hold it. */
export function commentBody(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function canPost(text: string): boolean {
  return commentBody(text).length > 0;
}

export type Person = { userId: string; name: string | null; imageUrl?: string | null };

/**
 * The people a draft still names, split by whether the project can still
 * reach them. A pick was offered from the mentionable list, but that list is
 * live: someone whose link was revoked while the draft was open is no longer
 * on it, and a notice to them would be refused after the comment was written.
 */
export function draftMentions(
  picks: MentionPick[],
  text: string,
  mentionable: readonly Person[],
): { reachable: string[]; unreachable: string[] } {
  const known = new Set(mentionable.map((person) => person.userId));
  const named = mentionedPeople(keptMentions(picks, text));
  return {
    reachable: named.filter((id) => known.has(id)),
    unreachable: named.filter((id) => !known.has(id)),
  };
}

/** The account ids a notice was refused for because they cannot open the project, else null. */
export function refusedOutsiders(error: unknown): string[] | null {
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as Partial<OutsiderRefusal> | null;
  return data && typeof data === "object" && data.code === "outsider" && Array.isArray(data.userIds)
    ? data.userIds
    : null;
}

/** "Ada", "Ada and Cam", "Ada, Cam and Dee". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the composer says when people it named cannot be told. The names are
 * the ones the writer picked from the menu — the server returns only ids, and
 * never reads a stranger's profile back.
 */
export function outsiderNote(userIds: readonly string[], picks: readonly MentionPick[], written: boolean): string {
  const names = userIds.map((id) => {
    const pick = picks.find((p) => p.kind === "person" && p.userId === id);
    return pick?.kind === "person" && pick.name.trim() ? pick.name.trim() : "Someone you mentioned";
  });
  const who = listNames([...new Set(names)]);
  return written
    ? `Posted, but ${who} can't open this project, so they weren't told.`
    : `${who} can't open this project. Remove the mention to post.`;
}

/** The name a comment is signed with: "You" for the reader's own. */
export function authorName(authorId: string, me: string | null, people: readonly Person[]): string {
  if (me !== null && authorId === me) return "You";
  const name = people.find((person) => person.userId === authorId)?.name?.trim();
  return name || "Someone";
}

/** Initials for an avatar with no picture. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0].slice(0, 1) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A comment's age the way Docs writes it: "Just now", "5m", "3h", then
 * "Yesterday", then the date — with the year only once it is not this one.
 */
export function timeAgo(at: number, now: number): string {
  const age = now - at;
  if (age < MINUTE) return "Just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  const then = new Date(at);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= midnight && age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (at >= midnight - DAY) return "Yesterday";
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}),
  });
}
