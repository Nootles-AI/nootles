import { describe, expect, test } from "vitest";
import {
  expiresIn,
  heirOf,
  invitationProblem,
  inviteProblem,
  LEAVE_INSTEAD,
  leaveProblem,
  offersInvite,
  removeProblem,
  roleChoices,
  sayOnce,
} from "./seats";

const refused = (choices: { role: string; why: string | null }[]) =>
  Object.fromEntries(choices.map((c) => [c.role, c.why]));

/** One owner among three people; two owners among three; one person alone. */
const TEAM = { owners: 1, people: 3 };
const TWO_OWNERS = { owners: 2, people: 3 };
const ALONE = { owners: 1, people: 1 };

describe("the role menu reads the server’s seat rules", () => {
  test("an owner may move anyone, and the tick needs no permission", () => {
    expect(refused(roleChoices("owner", { role: "admin", isMe: false }, TEAM))).toEqual({
      owner: null,
      admin: null,
      member: null,
    });
  });

  test("an admin runs members, and says why admins and owners are not theirs", () => {
    expect(refused(roleChoices("admin", { role: "member", isMe: false }, TEAM))).toEqual({
      owner: "Only an owner can make someone an owner.",
      admin: "Only an owner can make someone an admin.",
      member: null,
    });
    expect(refused(roleChoices("admin", { role: "admin", isMe: false }, TEAM))).toEqual({
      owner: "Only an owner can change an admin’s role.",
      admin: null,
      member: "Only an owner can change an admin’s role.",
    });
  });

  test("nobody but an owner changes their own role", () => {
    const own = refused(roleChoices("admin", { role: "admin", isMe: true }, TEAM));
    expect(own.member).toBe("You can’t change your own role.");
    expect(own.owner).toBe("You can’t change your own role.");
  });

  test("the last owner stays one, and a second owner may step down", () => {
    expect(refused(roleChoices("owner", { role: "owner", isMe: true }, TEAM)).admin).toBe(
      "You’re the only owner. Make someone else an owner first.",
    );
    expect(
      refused(roleChoices("owner", { role: "owner", isMe: true }, TWO_OWNERS)).admin,
    ).toBeNull();
  });

  test("a guest keeps a row of their own to be ticked", () => {
    expect(roleChoices("owner", { role: "guest", isMe: false }, TEAM).map((c) => c.role)).toEqual([
      "owner",
      "admin",
      "member",
      "guest",
    ]);
  });
});

describe("removing, leaving and inviting", () => {
  test("admins remove members and guests, never a peer or an owner", () => {
    expect(removeProblem("admin", "member")).toBeNull();
    expect(removeProblem("admin", "guest")).toBeNull();
    expect(removeProblem("admin", "admin")).toBe("Only an owner can remove an admin.");
    expect(removeProblem("admin", "owner")).toBe("Only an owner can remove an owner.");
    expect(removeProblem("owner", "owner")).toBeNull();
  });

  test("the only owner cannot leave", () => {
    expect(leaveProblem("owner", TEAM)).toMatch(/only owner/);
    expect(leaveProblem("owner", TWO_OWNERS)).toBeNull();
    expect(leaveProblem("member", TEAM)).toBeNull();
  });

  test("only an owner asks an admin in, or withdraws that invitation", () => {
    expect(inviteProblem("owner", "admin")).toBeNull();
    expect(inviteProblem("admin", "member")).toBeNull();
    expect(inviteProblem("admin", "admin")).toBe("Only an owner can invite an admin.");
    expect(invitationProblem("admin", "member")).toBeNull();
    expect(invitationProblem("admin", "admin")).toBe(
      "Only an owner can change an admin’s invitation.",
    );
  });
});

describe("a menu says each refusal once", () => {
  test("the one owner’s own row: one caption, and leaving says the other door whole", () => {
    const me = { role: "owner" as const, isMe: true };
    expect(
      sayOnce(roleChoices("owner", me, TEAM), leaveProblem("owner", TEAM), LEAVE_INSTEAD),
    ).toEqual({
      caption: "You’re the only owner. Make someone else an owner first.",
      out: "You can delete the workspace instead, under General.",
    });
  });

  test("alone in it, the one owner is told to invite someone, not to promote nobody", () => {
    const me = { role: "owner" as const, isMe: true };
    expect(
      sayOnce(roleChoices("owner", me, ALONE), leaveProblem("owner", ALONE), LEAVE_INSTEAD),
    ).toEqual({
      caption:
        "You’re the only one in this workspace. Invite someone and make them an owner first.",
      out: "You can delete the workspace instead, under General.",
    });
    expect(leaveProblem("owner", ALONE)).toBe(
      "You’re the only one in this workspace. Invite someone and make them an owner first, or delete the workspace.",
    );
  });

  test("an admin’s own row: one caption, and leaving is theirs", () => {
    const me = { role: "admin" as const, isMe: true };
    expect(sayOnce(roleChoices("admin", me, TEAM), leaveProblem("admin", TEAM))).toEqual({
      caption: "You can’t change your own role.",
      out: null,
    });
  });

  test("a different refusal for the way out is said in full", () => {
    const peer = { role: "admin" as const, isMe: false };
    expect(sayOnce(roleChoices("admin", peer, TEAM), removeProblem("admin", "admin"))).toEqual({
      caption: "Only an owner can change an admin’s role.",
      out: "Only an owner can remove an admin.",
    });
  });

  test("reasons that differ stay with their seats", () => {
    const member = { role: "member" as const, isMe: false };
    expect(sayOnce(roleChoices("admin", member, TEAM), null)).toEqual({ caption: null, out: null });
    expect(sayOnce(roleChoices("owner", member, TEAM), null)).toEqual({ caption: null, out: null });
  });
});

describe("who inherits a leaver’s projects", () => {
  test("the longest-standing other owner, as members.leave picks", () => {
    const people = [
      { name: "me", role: "owner" as const, isMe: true, joinedAt: 1 },
      { name: "late", role: "owner" as const, isMe: false, joinedAt: 30 },
      { name: "early", role: "owner" as const, isMe: false, joinedAt: 20 },
      { name: "admin", role: "admin" as const, isMe: false, joinedAt: 5 },
    ];
    expect(heirOf(people)?.name).toBe("early");
    expect(heirOf(people.slice(0, 1))).toBeNull();
  });
});

describe("how long an invitation has left", () => {
  const DAY = 86_400_000;
  test("in days, then today, then expired", () => {
    expect(expiresIn(14 * DAY, 0)).toBe("In 14 days");
    expect(expiresIn(1.2 * DAY, 0)).toBe("In 1 day");
    expect(expiresIn(0.5 * DAY, 0)).toBe("Today");
    expect(expiresIn(0, 0)).toBe("Expired");
    expect(expiresIn(-DAY, 0)).toBe("Expired");
  });
});

describe("who is offered the ways to invite", () => {
  test("owners and admins are; members and guests are not", () => {
    expect(offersInvite("owner", false)).toBe(true);
    expect(offersInvite("admin", false)).toBe(true);
    expect(offersInvite("member", false)).toBe(false);
    expect(offersInvite("guest", false)).toBe(false);
  });

  test("an operator standing in is never offered it, and no seat is none", () => {
    expect(offersInvite("owner", true)).toBe(false);
    expect(offersInvite("admin", true)).toBe(false);
    expect(offersInvite(null, false)).toBe(false);
    expect(offersInvite(undefined, false)).toBe(false);
  });
});
