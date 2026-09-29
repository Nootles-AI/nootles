import { describe, expect, test } from "vitest";
import { clearedRefCookie, refFromCookies, refToClaim } from "./affiliateRef";

const REF = "nia.0b7c3d1e-2f4a-4b6c-8d9e-a0b1c2d3e4f5.1780000000000";

describe("refFromCookies", () => {
  test.each([
    [`nt_ref=${REF}`, REF],
    [`theme=dark; nt_ref=${REF}; nt_imp=x`, REF],
    [`theme=dark;nt_ref=${REF}`, REF],
    [`xnt_ref=${REF}`, null],
    [`nt_refs=${REF}`, null],
    ["nt_ref=", null],
    ["", null],
  ])("%j → %j", (cookies, expected) => {
    expect(refFromCookies(cookies)).toBe(expected);
  });

  test("no header at all", () => {
    expect(refFromCookies(null)).toBeNull();
    expect(refFromCookies(undefined)).toBeNull();
  });
});

describe("refToClaim", () => {
  const cookies = `a=1; nt_ref=${REF}`;

  test("a signed-in person with a ref claims it", () => {
    expect(refToClaim(cookies, { authenticated: true, standingIn: false })).toBe(REF);
  });

  test("nobody signed in claims nothing, and keeps the cookie for when they do", () => {
    expect(refToClaim(cookies, { authenticated: false, standingIn: false })).toBeNull();
  });

  test("an operator standing in claims nothing", () => {
    expect(refToClaim(cookies, { authenticated: true, standingIn: true })).toBeNull();
  });

  test("no cookie, nothing to claim", () => {
    expect(refToClaim("a=1", { authenticated: true, standingIn: false })).toBeNull();
  });
});

test("clearing the cookie names it on the path it was set on, expired", () => {
  expect(clearedRefCookie(false)).toBe("nt_ref=; Path=/; Max-Age=0; SameSite=Lax");
  expect(clearedRefCookie(true)).toBe("nt_ref=; Path=/; Max-Age=0; SameSite=Lax; Secure");
});
