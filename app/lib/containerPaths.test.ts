import { describe, expect, test } from "vitest";
import {
  homePath,
  joinPath,
  projectIdIn,
  projectPath,
  settingsPath,
  withSlug,
} from "./containerPaths";

describe("container addresses", () => {
  test("your own container lives at the root", () => {
    expect(homePath(null)).toBe("/");
    expect(projectPath(null, "abc")).toBe("/p/abc");
  });

  test("a workspace lives under /w/<slug>", () => {
    expect(homePath("acme")).toBe("/w/acme");
    expect(projectPath("acme", "abc")).toBe("/w/acme/p/abc");
  });

  test("general is the settings page itself, other sections sit below it", () => {
    expect(settingsPath("acme")).toBe("/w/acme/settings");
    expect(settingsPath("acme", "general")).toBe("/w/acme/settings");
    expect(settingsPath("acme", "members")).toBe("/w/acme/settings/members");
  });

  test("an invitation sits beside every workspace, never inside one", () => {
    expect(joinPath("tok")).toBe("/w/join/tok");
  });
});

describe("withSlug", () => {
  test("moves the same page to another address of the workspace", () => {
    expect(withSlug("/w/old", "new")).toBe("/w/new");
    expect(withSlug("/w/old/p/abc", "new")).toBe("/w/new/p/abc");
    expect(withSlug("/w/Old/settings/members", "old")).toBe("/w/old/settings/members");
  });

  test("keeps a trailing slash and anything after the slug verbatim", () => {
    expect(withSlug("/w/old/", "new")).toBe("/w/new/");
    expect(withSlug("/w/old/p/a%20b", "new")).toBe("/w/new/p/a%20b");
  });

  test("a path that is not a workspace's goes to the workspace's home", () => {
    expect(withSlug("/p/abc", "new")).toBe("/w/new");
    expect(withSlug("/w", "new")).toBe("/w/new");
    expect(withSlug("", "new")).toBe("/w/new");
  });
});

describe("projectIdIn", () => {
  test("reads the project out of a workspace's project address", () => {
    expect(projectIdIn("/w/acme/p/abc")).toBe("abc");
    expect(projectIdIn("/w/acme/p/abc/")).toBe("abc");
  });

  test("is null for every other address", () => {
    expect(projectIdIn("/p/abc")).toBeNull();
    expect(projectIdIn("/w/acme")).toBeNull();
    expect(projectIdIn("/w/acme/p")).toBeNull();
    expect(projectIdIn("/w/acme/p/")).toBeNull();
    expect(projectIdIn("/w/acme/settings/members")).toBeNull();
    expect(projectIdIn("/w//p/abc")).toBeNull();
  });
});
