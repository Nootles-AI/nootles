import { describe, expect, test, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * What `proxy.ts` admits without a session. The real route matcher, with
 * Clerk's middleware wrapper peeled off so the handler can be called with a
 * stand-in `auth` whose `protect` says whether it was asked.
 */

vi.mock("@clerk/nextjs/server", async (original) => ({
  ...(await original<typeof import("@clerk/nextjs/server")>()),
  clerkMiddleware: (handler: unknown) => handler,
}));

const { default: proxy } = (await import("../proxy")) as unknown as {
  default: (auth: { protect: () => Promise<void> }, request: NextRequest) => Promise<Response | void>;
};

async function visit(path: string, cookie?: string) {
  const protect = vi.fn(async () => {});
  const headers = cookie ? { cookie } : undefined;
  const response = await proxy({ protect }, new NextRequest(`https://app.nootles.com${path}`, { headers }));
  return { protected: protect.mock.calls.length > 0, status: response?.status ?? null };
}

describe("affiliate links", () => {
  test.each(["/r/nia", "/r/Nia-Smith", "/r/unknown-slug"])("%s needs no session", async (path) => {
    expect(await visit(path)).toEqual({ protected: false, status: null });
  });

  test("…nor does an operator's stand-in cookie shut it, as it shuts the API", async () => {
    expect(await visit("/r/nia", "nt_imp=token")).toEqual({ protected: false, status: null });
    expect((await visit("/api/chat", "nt_imp=token")).status).toBe(403);
  });

  test("the app around it is still private", async () => {
    for (const path of ["/", "/r", "/rr/nia", "/p/abc", "/api/chat"]) {
      expect((await visit(path)).protected, path).toBe(true);
    }
  });
});
