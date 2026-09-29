import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `/r/<slug>`: every click lands somewhere safe; only a click the route could
 * sign is counted and moves the `nt_ref` cookie; the visitor is the same
 * browser from one click to the next; and nothing that is not a click — a
 * HEAD, a prefetch — counts or leaves a cookie.
 */

const { mutation, made } = vi.hoisted(() => ({ mutation: vi.fn(), made: vi.fn() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    constructor(url: string) {
      made(url);
    }
    mutation = mutation;
  },
}));

import {
  DEFAULT_DESTINATION,
  REF_COOKIE,
  parseRef,
  signClick,
  verifyClick,
} from "@/convex/affiliateRules";
import { GET, HEAD } from "./route";

const SECRET = "click-secret";
const CONVEX_URL = "https://example-123.convex.cloud";
const VISITOR = "0b7c3d1e-2f4a-4b6c-8d9e-a0b1c2d3e4f5";
const NOW = 1_780_000_000_000;

function request(path: string, init: { cookie?: string; headers?: Record<string, string>; method?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("cookie", init.cookie);
  return new Request(`https://app.nootles.com${path}`, { method: init.method ?? "GET", headers });
}

const context = (slug: string) => ({ params: Promise.resolve({ slug }) });
const click = (slug: string, init?: Parameters<typeof request>[1]) => GET(request(`/r/${slug}`, init), context(slug));

/** The `nt_ref` Set-Cookie line, or null. */
function refCookie(res: Response): string | null {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${REF_COOKIE}=`));
  return line ?? null;
}
const refValue = (res: Response) => refCookie(res)?.split(";")[0].slice(REF_COOKIE.length + 1) ?? null;

/** What `recordClick` was called with, the one time it was. */
const recorded = () => {
  expect(mutation).toHaveBeenCalledTimes(1);
  return mutation.mock.calls[0][1] as { slug: string; visitorId: string; signedAt: number; signature: string };
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("AFFILIATE_CLICK_SECRET", SECRET);
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", CONVEX_URL);
  mutation.mockResolvedValue({ destination: "https://nootles.com/for/teachers", counted: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("a click", () => {
  test("is signed, counted signed-out, and redirects to the affiliate's destination, uncached", async () => {
    const res = await click("nia");
    expect(made).toHaveBeenCalledWith(CONVEX_URL);
    const args = recorded();
    expect(args.slug).toBe("nia");
    expect(args.signedAt).toBe(NOW);
    expect(await verifyClick(SECRET, args, args.signature)).toBe(true);
    expect(args.signature).toBe(await signClick(SECRET, { slug: "nia", visitorId: args.visitorId, signedAt: NOW }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://nootles.com/for/teachers");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("leaves nt_ref naming the slug, the visitor and the click, readable by the page, for 30 days", async () => {
    const res = await click("nia");
    const { visitorId } = recorded();
    expect(parseRef(refValue(res)!)).toEqual({ slug: "nia", visitorId, clickedAt: NOW });
    const line = refCookie(res)!.toLowerCase();
    expect(line).toContain("path=/");
    expect(line).toContain("max-age=2592000");
    expect(line).toContain("samesite=lax");
    expect(line).not.toContain("httponly");
    expect(line).not.toContain("domain=");
    // Secure only in production, where the app is served over https.
    expect(line).not.toContain("secure");
  });

  test("is Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = await click("nia");
    expect(refCookie(res)!.toLowerCase()).toContain("secure");
  });

  test("normalizes the slug as typed before signing it", async () => {
    const res = await click("Nia-");
    expect(recorded().slug).toBe("nia");
    expect(parseRef(refValue(res)!)?.slug).toBe("nia");
  });

  test("mints a fresh visitor id when there is no cookie", async () => {
    await click("nia");
    await click("nia");
    const [a, b] = mutation.mock.calls.map((call) => call[1].visitorId);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b).not.toBe(a);
  });

  test("keeps the visitor of an earlier click, from any affiliate — and the new click wins the cookie", async () => {
    const res = await click("eli", { cookie: `theme=x; ${REF_COOKIE}=nia.${VISITOR}.1779990000000` });
    expect(recorded().visitorId).toBe(VISITOR);
    expect(parseRef(refValue(res)!)).toEqual({ slug: "eli", visitorId: VISITOR, clickedAt: NOW });
  });

  test("mints a new visitor over a cookie it could not have written", async () => {
    await click("nia", { cookie: `${REF_COOKIE}=nia.not-a-uuid.1` });
    expect(recorded().visitorId).not.toBe("not-a-uuid");
  });
});

describe("where it lands when it can't go where it was asked", () => {
  test("a slug that can't be one goes to the default without asking Convex, and leaves no cookie", async () => {
    for (const slug of ["x", "admin", "a".repeat(41)]) {
      const res = await click(slug);
      expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
      expect(refCookie(res)).toBeNull();
    }
    expect(mutation).not.toHaveBeenCalled();
  });

  test("an unknown slug goes wherever Convex says — the default", async () => {
    mutation.mockResolvedValue({ destination: DEFAULT_DESTINATION, counted: false });
    const res = await click("nobody", { cookie: `${REF_COOKIE}=eli.${VISITOR}.1779990000000` });
    expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
    expect(refCookie(res)).toBeNull();
  });

  test("a click Convex did not count — a disabled link, a secret it disagrees with — leaves the earlier cookie alone", async () => {
    mutation.mockResolvedValue({ destination: DEFAULT_DESTINATION, counted: false });
    const res = await click("dee", { cookie: `${REF_COOKIE}=nia.${VISITOR}.1779990000000` });
    expect(recorded().signature).toMatch(/^[0-9a-f]{64}$/);
    expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
    expect(refCookie(res)).toBeNull();
  });

  test("a Convex error goes to the default, and leaves the earlier cookie alone", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mutation.mockRejectedValue(new Error("OptimisticConcurrencyControlFailure"));
    const res = await click("nia", { cookie: `${REF_COOKIE}=eli.${VISITOR}.1779990000000` });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
    expect(refCookie(res)).toBeNull();
    expect(log).toHaveBeenCalled();
  });

  test("no Convex URL is an error like any other", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "");
    const res = await click("nia");
    expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
    expect(refCookie(res)).toBeNull();
  });

  test.each([
    "http://nootles.com/",
    "https://evil.example/",
    "https://nootles.com.evil.example/",
    "https://user@nootles.com/",
    "javascript:alert(1)",
    "//evil.example",
  ])("a destination off our own sites (%s) goes to the default", async (destination) => {
    mutation.mockResolvedValue({ destination, counted: true });
    const res = await click("nia");
    expect(res.headers.get("location")).toBe(DEFAULT_DESTINATION);
  });
});

describe("what doesn't count", () => {
  test("with no secret on this server, the click still lands but is sent unsigned, and moves no cookie", async () => {
    vi.stubEnv("AFFILIATE_CLICK_SECRET", "");
    // Even were Convex to say otherwise, an unsigned click never moves it.
    const res = await click("nia", { cookie: `${REF_COOKIE}=eli.${VISITOR}.1779990000000` });
    expect(recorded().signature).toBe("");
    expect(res.headers.get("location")).toBe("https://nootles.com/for/teachers");
    expect(refCookie(res)).toBeNull();
  });

  test.each([
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
    "facebookexternalhit/1.1 Facebot Twitterbot/1.0",
    "Twitterbot/1.0",
    "TelegramBot (like TwitterBot)",
    "Discordbot/2.0; +https://discordapp.com",
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "WhatsApp/2.23.20.0 A",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "curl/8.4.0",
  ])("a preview or crawler (%s) is told where the link goes, unsigned, with no cookie", async (agent) => {
    const res = await click("nia", { headers: { "user-agent": agent } });
    expect(recorded().signature).toBe("");
    expect(res.headers.get("location")).toBe("https://nootles.com/for/teachers");
    expect(refCookie(res)).toBeNull();
  });

  test.each([
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
    "Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36",
  ])("a person's browser (%s) is counted", async (agent) => {
    const res = await click("nia", { headers: { "user-agent": agent } });
    expect(recorded().signature).toMatch(/^[0-9a-f]{64}$/);
    expect(refCookie(res)).not.toBeNull();
  });

  test("HEAD is told where the link goes, unsigned, with no cookie", async () => {
    const res = await HEAD(request("/r/nia", { method: "HEAD" }), context("nia"));
    expect(recorded().signature).toBe("");
    expect(res.headers.get("location")).toBe("https://nootles.com/for/teachers");
    expect(refCookie(res)).toBeNull();
  });

  test.each<Record<string, string>>([
    { "sec-purpose": "prefetch" },
    { "sec-purpose": "prefetch;prerender" },
    { purpose: "prefetch" },
  ])("a speculative fetch (%o) is turned away, so the real click comes back", async (headers) => {
    const res = await click("nia", { headers });
    expect(mutation).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(refCookie(res)).toBeNull();
  });
});
