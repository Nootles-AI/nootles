import { describe, expect, test } from "vitest";
import { channelAdmits, type ProjectRole } from "@/convex/roles";
import { commentAccessFor, NO_COMMENT_ACCESS } from "./access";

describe("commentAccessFor", () => {
  test.each([
    ["owner", true, true],
    ["editor", true, true],
    ["commenter", true, true],
    ["viewer", true, false],
    [null, false, false],
    [undefined, false, false],
  ] as const)("%s → read %s, comment %s", (role, canRead, canComment) => {
    expect(commentAccessFor(role)).toEqual({ canRead, canComment });
  });

  test("agrees with the server's comments channel for every signed-in role", () => {
    // The client copy is a courtesy; it must never offer what the gate refuses,
    // nor hide what it admits. `linkLive` is irrelevant on this channel.
    const roles: Array<ProjectRole | null> = ["owner", "editor", "commenter", "viewer", null];
    for (const role of roles) {
      for (const linkLive of [false, true]) {
        const access = commentAccessFor(role);
        expect(access.canRead).toBe(channelAdmits({ channel: "comments", access: "read", role, linkLive }));
        expect(access.canComment).toBe(channelAdmits({ channel: "comments", access: "write", role, linkLive }));
      }
    }
  });

  test("the default is closed", () => {
    expect(NO_COMMENT_ACCESS).toEqual({ canRead: false, canComment: false });
  });
});
