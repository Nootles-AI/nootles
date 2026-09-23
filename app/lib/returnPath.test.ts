import { describe, expect, test } from "vitest";
import { returnPath } from "./returnPath";

const ORIGIN = "https://app.nootles.com";

describe("returnPath from Clerk’s redirect_url", () => {
  test("a URL on this origin comes back as its path, query and fragment", () => {
    expect(returnPath(`${ORIGIN}/w/acme/p/abc`, ORIGIN)).toBe("/w/acme/p/abc");
    expect(returnPath(`${ORIGIN}/w/join/tok?x=1#y`, ORIGIN)).toBe("/w/join/tok?x=1#y");
    expect(returnPath(`${ORIGIN}/share/tok`, ORIGIN)).toBe("/share/tok");
  });

  test("another origin is not followed", () => {
    expect(returnPath("https://evil.example/w/acme", ORIGIN)).toBe("/");
    expect(returnPath("http://app.nootles.com/w/acme", ORIGIN)).toBe("/");
    expect(returnPath("https://app.nootles.com:8443/w/acme", ORIGIN)).toBe("/");
    expect(returnPath("//evil.example/w/acme", ORIGIN)).toBe("/");
    expect(returnPath("/\\evil.example/w/acme", ORIGIN)).toBe("/");
    expect(returnPath("javascript:alert(1)", ORIGIN)).toBe("/");
  });

  test("nothing, or the sign-in round trip itself, is home", () => {
    expect(returnPath(null, ORIGIN)).toBe("/");
    expect(returnPath("", ORIGIN)).toBe("/");
    expect(returnPath(`${ORIGIN}/sign-in?redirect_url=x`, ORIGIN)).toBe("/");
    expect(returnPath(`${ORIGIN}/sso-callback`, ORIGIN)).toBe("/");
    expect(returnPath(`${ORIGIN}/`, ORIGIN)).toBe("/");
  });
});

describe("returnPath from the callback’s ?return=", () => {
  test("a path is followed", () => {
    expect(returnPath("/share/tok")).toBe("/share/tok");
    expect(returnPath("/w/join/tok")).toBe("/w/join/tok");
    expect(returnPath("/share/tok?request=1")).toBe("/share/tok?request=1");
  });

  test("anything that is not a bare path on this origin is refused", () => {
    expect(returnPath("https://evil.example/share/tok")).toBe("/");
    expect(returnPath(`${ORIGIN}/share/tok`)).toBe("/");
    expect(returnPath("//evil.example/share/tok")).toBe("/");
    expect(returnPath("/\\evil.example")).toBe("/");
    expect(returnPath("/sign-in")).toBe("/");
  });

  test("a relative path resolves from the root", () => {
    expect(returnPath("w/acme")).toBe("/w/acme");
  });
});
