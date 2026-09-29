import { describe, expect, test } from "vitest";
import { grantedScope, hasScope, mintToken, pkceMatches, redirectWith, sha256Hex, validRedirectUri, withoutWrite } from "./tokens";

async function challengeOf(verifier: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("tokens", () => {
  test("minted tokens are prefixed, url-safe and never repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = mintToken("access");
      expect(token).toMatch(/^nta_[A-Za-z0-9_-]{43}$/);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
    expect(mintToken("refresh")).toMatch(/^ntr_/);
    expect(mintToken("code")).toMatch(/^ntc_/);
  });

  test("sha256Hex is the hex digest", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("PKCE S256 matches only its own verifier", async () => {
    const verifier = "a".repeat(43) + "-._~" + "Z9";
    const challenge = await challengeOf(verifier);
    expect(await pkceMatches(verifier, challenge)).toBe(true);
    expect(await pkceMatches(verifier + "x", challenge)).toBe(false);
    // RFC 7636 bounds: 43..128 unreserved characters.
    expect(await pkceMatches("short", await challengeOf("short"))).toBe(false);
    expect(await pkceMatches("a".repeat(129), await challengeOf("a".repeat(129)))).toBe(false);
    expect(await pkceMatches("a".repeat(42) + " ", await challengeOf("a".repeat(42) + " "))).toBe(false);
  });

  test("redirect URIs: https anywhere, http only on loopback, nothing else", () => {
    expect(validRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(validRedirectUri("http://localhost:33418/callback")).toBe(true);
    expect(validRedirectUri("http://127.0.0.1:5173/cb")).toBe(true);
    expect(validRedirectUri("http://[::1]:9000/cb")).toBe(true);
    expect(validRedirectUri("http://evil.example/cb")).toBe(false);
    expect(validRedirectUri("javascript:alert(1)")).toBe(false);
    expect(validRedirectUri("cursor://callback")).toBe(false);
    expect(validRedirectUri("https://claude.ai/cb#frag")).toBe(false);
    expect(validRedirectUri("https://user:pw@claude.ai/cb")).toBe(false);
    expect(validRedirectUri("not a url")).toBe(false);
    expect(validRedirectUri("https://x.example/" + "a".repeat(2100))).toBe(false);
  });

  test("scopes: read, write (which brings read), or nothing", () => {
    expect(grantedScope(undefined)).toBe("docs:read docs:write");
    expect(grantedScope("")).toBe("docs:read docs:write");
    expect(grantedScope("docs:read")).toBe("docs:read");
    expect(grantedScope("docs:read docs:read")).toBe("docs:read");
    expect(grantedScope("docs:write")).toBe("docs:read docs:write");
    expect(grantedScope("docs:write  docs:read")).toBe("docs:read docs:write");
    expect(grantedScope("docs:read docs:admin")).toBeNull();
    expect(grantedScope("openid")).toBeNull();
    expect(withoutWrite("docs:read docs:write")).toBe("docs:read");
    expect(withoutWrite("docs:write")).toBe("docs:read");
    expect([hasScope("docs:read docs:write", "docs:write"), hasScope("docs:read", "docs:write")]).toEqual([true, false]);
  });

  test("redirectWith keeps the client's query and appends state last", () => {
    const url = new URL(redirectWith("https://c.example/cb?x=1", { code: "c1", iss: "https://i" }, "s t"));
    expect(url.searchParams.get("x")).toBe("1");
    expect(url.searchParams.get("code")).toBe("c1");
    expect(url.searchParams.get("state")).toBe("s t");
    expect(url.searchParams.get("iss")).toBe("https://i");
    expect(new URL(redirectWith("https://c.example/cb", { error: "e" }, undefined)).searchParams.has("state")).toBe(false);
  });
});
