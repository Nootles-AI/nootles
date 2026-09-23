import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The install route: only an admin of the named workspace is sent to GitHub,
 * and the state they carry there is the one sealed into their cookie — the
 * setup route refuses anything else as `reason=state`.
 */

const { session, status } = vi.hoisted(() => ({ session: vi.fn(), status: vi.fn() }));

vi.mock("@/app/lib/session", () => ({ session }));
vi.mock("@/app/lib/convexServer", () => ({ asUser: () => ({ query: status }) }));

import { INSTALL_COOKIE, INSTALL_MAX_AGE, openBinding } from "../flow";
import { GET } from "./route";

const ADMIN = { slug: "acme", ready: true, missing: [], appSlug: "nootles", canManage: true };

function install(query: Record<string, string>): Request {
  const url = new URL("http://test/api/github/app/install");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url);
}

function cookieOf(res: Response): string | null {
  const set = res.headers.get("set-cookie");
  if (!set) return null;
  const match = new RegExp(`${INSTALL_COOKIE}=([^;]*)`).exec(set);
  return match ? decodeURIComponent(match[1]) : null;
}

beforeEach(() => {
  session.mockResolvedValue({ userId: "u1", token: "t", sessionId: "sess" });
  status.mockResolvedValue(ADMIN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("who is turned away", () => {
  test("no session is unauthorized", async () => {
    session.mockResolvedValue(null);
    const res = await GET(install({ workspace: "ws_1" }));
    expect(res.status).toBe(401);
    expect(cookieOf(res)).toBeNull();
  });

  test("no workspace named is a bad request", async () => {
    const res = await GET(install({}));
    expect(res.status).toBe(400);
  });

  test.each([
    ["a workspace the caller can't see", () => status.mockResolvedValue(null)],
    ["a malformed id", () => status.mockRejectedValue(new Error("invalid id"))],
  ])("%s is not found", async (_, arrange) => {
    arrange();
    const res = await GET(install({ workspace: "ws_1" }));
    expect(res.status).toBe(404);
    expect(cookieOf(res)).toBeNull();
  });

  test("a member who isn't an admin is forbidden, and never sent to GitHub", async () => {
    status.mockResolvedValue({ ...ADMIN, canManage: false });
    const res = await GET(install({ workspace: "ws_1" }));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("a deployment missing the App's Convex config says what's missing", async () => {
    status.mockResolvedValue({ ...ADMIN, ready: false, missing: ["GITHUB_APP_ID", "GITHUB_APP_SLUG"], appSlug: null });
    const res = await GET(install({ workspace: "ws_1" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/missing GITHUB_APP_ID, GITHUB_APP_SLUG/);
    expect(cookieOf(res)).toBeNull();
  });
});

describe("an admin", () => {
  test("is sent to GitHub with the state their cookie binds to them and the workspace", async () => {
    const res = await GET(install({ workspace: "ws_1" }));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/apps/nootles/installations/new",
    );
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(openBinding(cookieOf(res) ?? undefined)).toEqual({
      state,
      workspaceId: "ws_1",
      userId: "u1",
      returnTo: "/w/acme/settings/integrations",
    });
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).toContain(`Max-Age=${INSTALL_MAX_AGE}`);
    expect(set).toContain("Path=/");
  });

  test("each trip gets its own state", async () => {
    const first = new URL((await GET(install({ workspace: "ws_1" }))).headers.get("location")!);
    const second = new URL((await GET(install({ workspace: "ws_1" }))).headers.get("location")!);
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
  });

  test("a path on this app to return to is kept", async () => {
    const res = await GET(install({ workspace: "ws_1", returnTo: "/w/acme/p/abc?tab=code" }));
    expect(openBinding(cookieOf(res) ?? undefined)?.returnTo).toBe("/w/acme/p/abc?tab=code");
  });

  test.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
  ])("a return of %j that leaves the app is sealed as the integrations page", async (returnTo) => {
    const res = await GET(install({ workspace: "ws_1", returnTo }));
    expect(res.status).toBe(307);
    expect(openBinding(cookieOf(res) ?? undefined)?.returnTo).toBe("/w/acme/settings/integrations");
  });
});
