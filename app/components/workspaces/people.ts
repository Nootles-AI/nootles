"use client";

import { useUser } from "@clerk/nextjs";
import { useStandIn } from "../StandIn";

/** By code point, so a name that starts with an emoji keeps it whole. */
export const initial = (name: string | null | undefined) =>
  (Array.from(name?.trim() ?? "")[0] ?? "?").toUpperCase();

type Seat = { name: string | null; email: string | null; isMe: boolean };

export type Named = {
  /** What to call them: never empty. */
  name: string;
  /** Whether that is theirs, rather than a stand-in word. */
  known: boolean;
  /** Their address, where the name is something else. */
  mail: string | null;
};

/**
 * What a workspace's screens call each person — the pile, the list, the
 * menus — so that nobody is two people on one page.
 *
 * Your own row takes what Clerk knows of you first, as the account menu does,
 * so you are the same person in the header's circle and in the list even
 * while your profile has not caught up with your sign-in. Not while an
 * operator stands in: Clerk's user is then the operator, not whoever the row
 * is.
 */
export function useNaming(): (seat: Seat) => Named {
  const { user } = useUser();
  const standIn = useStandIn();
  const ownName = (!standIn && user?.fullName?.trim()) || null;
  const ownMail = (!standIn && user?.primaryEmailAddress?.emailAddress) || null;

  return (seat) => {
    const email = seat.email ?? (seat.isMe ? ownMail : null);
    const name = (seat.isMe ? ownName : null) ?? seat.name ?? email;
    return {
      name: name ?? (seat.isMe ? "You" : "Someone"),
      known: name !== null,
      mail: name && email && email !== name ? email : null,
    };
  };
}
