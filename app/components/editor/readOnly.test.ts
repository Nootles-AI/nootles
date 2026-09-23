import { describe, expect, test } from "vitest";
import { channelAdmits, type ProjectRole } from "@/convex/roles";
import { commentAccessFor } from "../comments/access";
import { readsOnly } from "./readOnly";

/**
 * docs/commenting-plan.md §5's table, as the workspace draws it from the role
 * `projects.myRole` answers — an operator standing in is answered "viewer".
 */
describe("the workspace surface for each role", () => {
  test.each([
    // role,        edits page, reads comments, comments
    ["owner", true, true, true],
    ["editor", true, true, true],
    ["commenter", false, true, true],
    ["viewer", false, true, false],
  ] as const)("%s", (role, edits, reads, comments) => {
    expect(readsOnly(role)).toBe(!edits);
    expect(commentAccessFor(role)).toEqual({ canRead: reads, canComment: comments });
  });

  test("the page is writable exactly where the document channel admits a write", () => {
    const roles: ProjectRole[] = ["owner", "editor", "commenter", "viewer"];
    for (const role of roles) {
      expect(readsOnly(role)).toBe(!channelAdmits({ channel: "document", access: "write", role, linkLive: true }));
    }
  });

  test("a role still loading shows no read-only chrome and no comments", () => {
    expect(readsOnly(undefined)).toBe(false);
    expect(readsOnly(null)).toBe(false);
    expect(commentAccessFor(undefined)).toEqual({ canRead: false, canComment: false });
  });
});
