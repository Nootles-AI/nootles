import { describe, expect, test } from "vitest";
import {
  expiresIn,
  heirOf,
  invitationProblem,
  inviteProblem,
  leaveProblem,
  removeProblem,
  roleChoices,
  sayOnce,
} from "./seats";

const refused = (choices: { role: string; why: string | null }[]) =>
  Object.fromEntries(choices.map((c) => [c.role, c.why]));

describe("the role menu reads the server’s seat rules", () => {
  test("an owner may move anyone, and the tick needs no permission", () => {
    expect(refused(roleChoices("owner", { role: "admin", isMe: false }, 1))).toEqual({
      owner: null,
      admin: null,
      member: null,
    });
  });

  test("an admin runs members, and says why admins and owners are not theirs", () => {
    expect(refused(roleChoices("admin", { role: "member", isMe: false }, 1))).toEqual({
      owner: "Only an owner can make someone an owner.",
      admin: "Only an owner can make someone an admin.",
      member: null,
    });
    expect(refused(roleChoices("admin", { role: "admin", isMe: false }, 1))).toEqual({
      owner: "Only an owner can change an admin’s role.",
      admin: null,
      member: "Only an owner can change an admin’s role.",
    });
  });

  test("nobody but an owner changes their own role", () => {
    const own = refused(roleChoices("admin", { role: "admin", isMe: true }, 1));
    expect(own.member).toBe("You can’t change your own role.");
    expect(own.owner).toBe("You can’t change your own role.");
  });

  test("the last owner stays one, and a second owner may step down", () => {
    expect(refused(roleChoices("owner", { role: "owner", isMe: true }, 1)).admin).toBe(
      "You’re the only owner. Make someone else an owner first.",
    );
    expect(refused(roleChoices("owner", { role: "owner", isMe: true }, 2)).admin).toBeNull();
  });

  test("a guest keeps a row of their own to be ticked", () => {
    expect(roleChoices("owner", { role: "guest", isMe: false }, 1).map((c) => c.role)).toEqual([
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
    expect(leaveProblem("owner", 1)).toMatch(/only owner/);
    expect(leaveProblem("owner", 2)).toBeNull();
    expect(leaveProblem("member", 1)).toBeNull();
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
  test("the one owner’s own row: one caption, and leaving keeps only the other door", () => {
    const me = { role: "owner" as const, isMe: true };
    expect(sayOnce(roleChoices("owner", me, 1), leaveProblem("owner", 1))).toEqual({
      caption: "You’re the only owner. Make someone else an owner first.",
      out: "Or delete the workspace.",
    });
  });

  test("an admin’s own row: one caption, and leaving is theirs", () => {
    const me = { role: "admin" as const, isMe: true };
    expect(sayOnce(roleChoices("admin", me, 1), leaveProblem("admin", 1))).toEqual({
      caption: "You can’t change your own role.",
      out: null,
    });
  });

  test("a different refusal for the way out is said in full", () => {
    const peer = { role: "admin" as const, isMe: false };
    expect(sayOnce(roleChoices("admin", peer, 1), removeProblem("admin", "admin"))).toEqual({
      caption: "Only an owner can change an admin’s role.",
      out: "Only an owner can remove an admin.",
    });
  });

  test("reasons that differ stay with their seats", () => {
    const member = { role: "member" as const, isMe: false };
    expect(sayOnce(roleChoices("admin", member, 1), null)).toEqual({ caption: null, out: null });
    expect(sayOnce(roleChoices("owner", member, 1), null)).toEqual({ caption: null, out: null });
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
