import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const { getToken } = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({ sessions: { getToken } }),
}));

import { asSession } from "./convexServer";

/** A token whose only claim that matters here is when it dies. */
function jwt(expSeconds: number): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ exp: expSeconds })}.sig`;
}

const now = () => Math.floor(Date.now() / 1000);

describe("asSession", () => {
  let sent: string[];

  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://example-123.convex.cloud");
    sent = [];
    vi.spyOn(ConvexHttpClient.prototype, "setAuth").mockImplementation(function (
      this: ConvexHttpClient,
      token: string,
    ) {
      sent.push(token);
    });
    vi.spyOn(ConvexHttpClient.prototype, "query").mockResolvedValue(null);
    getToken.mockReset().mockResolvedValue({ jwt: jwt(now() + 60) });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps a token with most of its minute left", async () => {
    const convex = asSession({ token: jwt(now() + 55), sessionId: "sess" });
    await convex.query(anyApi.x.y, {});
    expect(getToken).not.toHaveBeenCalled();
  });

  it("re-mints a token the browser had already spent most of, on the first call", async () => {
    // The request arrived on a token with ten seconds left: timed from when the
    // client was made, it was trusted for forty.
    const aged = jwt(now() + 10);
    const convex = asSession({ token: aged, sessionId: "sess" });
    await convex.query(anyApi.x.y, {});
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(sent.at(-1)).not.toBe(aged);
  });

  it("mints once for calls that were waiting together", async () => {
    const convex = asSession({ token: jwt(now() + 5), sessionId: "sess" });
    await Promise.all([1, 2, 3, 4].map(() => convex.query(anyApi.x.y, {})));
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it("re-mints a token it cannot read", async () => {
    const convex = asSession({ token: "not-a-jwt", sessionId: "sess" });
    await convex.query(anyApi.x.y, {});
    expect(getToken).toHaveBeenCalledTimes(1);
  });
});
