import { describe, expect, test } from "vitest";
import { safeReturn } from "./oauth";

/** Judged by where each value resolves against a real origin, as the routes redirect. */
const ORIGIN = "https://app.nootles.com";

describe("safeReturn", () => {
  test("a path on this app is kept, query and fragment too", () => {
    expect(safeReturn("/w/acme/settings/integrations")).toBe("/w/acme/settings/integrations");
    expect(safeReturn("/w/acme/p/abc?tab=code#top")).toBe("/w/acme/p/abc?tab=code#top");
  });

  test.each([
    undefined,
    "",
    "w/acme",
    "//evil.example",
    "/\\evil.example",
    "/\\evil.example/x",
    "\\/evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    " //evil.example",
    "/.//evil.example",
    "https://evil.example/",
    "javascript:alert(1)",
  ])("%j goes home", (value) => {
    expect(safeReturn(value)).toBe("/");
  });

  test.each(["/\\evil.example", "/\t/evil.example", "/w/acme", "//x", "https://x"])(
    "whatever %j becomes stays on this origin",
    (value) => {
      expect(new URL(safeReturn(value), ORIGIN).origin).toBe(ORIGIN);
    },
  );
});
