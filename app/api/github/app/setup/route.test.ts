import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The setup route's binding: the state cookie is the only thing tying
 * GitHub's round trip to the user and workspace that started it, so every way
 * it can fail to match must end in `reason=state` before the install action
 * — the one thing here that reaches GitHub — is ever called.
 */

const { session, install } = vi.hoisted(() => ({ session: vi.fn(), install: vi.fn() }));

vi.mock("@/app/lib/session", () => ({ session }));
vi.mock("@/app/lib/convexServer", () => ({ asUser: () => ({ action: install }) }));

import { INSTALL_COOKIE, sealBinding, type Binding } from "../flow";
import { GET } from "./route";

const BINDING: Binding = {
  state: "s-123",
  workspaceId: "ws_1",
  userId: "u1",
  returnTo: "/w/acme/settings/integrations",
};

function setup(query: Record<string, string>, cookie?: string): Request {
  const url = new URL("http://test/api/github/app/setup");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers: cookie === undefined ? {} : { cookie: `${INSTALL_COOKIE}=${cookie}` } });
}

const good = { state: BINDING.state, installation_id: "42", code: "c0de", setup_action: "install" };

function landed(res: Response) {
  const location = new URL(res.headers.get("location")!);
  return {
    path: location.pathname,
    github: location.searchParams.get("github"),
    reason: location.searchParams.get("reason"),
  };
}

/** The response clears the cookie, whatever happened. */
function clearsCookie(res: Response) {
  const set = res.headers.get("set-cookie") ?? "";
  return set.includes(`${INSTALL_COOKIE}=`) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(set);
}

beforeEach(() => {
  session.mockResolvedValue({ userId: "u1", token: "t", sessionId: "sess" });
  install.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("a round trip this user didn't start here", () => {
  test.each([
    ["no cookie", undefined, good],
    ["a cookie that isn't a binding", "not-base64-json", good],
    ["a binding with a field missing", Buffer.from(JSON.stringify({ state: "s-123" })).toString("base64url"), good],
    ["another user's binding", sealBinding({ ...BINDING, userId: "u2" }), good],
    ["a state that doesn't match", sealBinding(BINDING), { ...good, state: "s-other" }],
    ["no state at all", sealBinding(BINDING), { installation_id: "42", code: "c0de" }],
  ])("%s is refused as state, and records nothing", async (_, cookie, query) => {
    const res = await GET(setup(query, cookie));
    expect(landed(res)).toMatchObject({ github: "error", reason: "state" });
    expect(clearsCookie(res)).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });

  test("a session with no user is refused too", async () => {
    session.mockResolvedValue({ userId: null, token: "t", sessionId: "sess" });
    const res = await GET(setup(good, sealBinding(BINDING)));
    expect(landed(res)).toMatchObject({ github: "error", reason: "state" });
    expect(install).not.toHaveBeenCalled();
  });

  test("no session at all is unauthorized", async () => {
    session.mockResolvedValue(null);
    const res = await GET(setup(good, sealBinding(BINDING)));
    expect(res.status).toBe(401);
    expect(install).not.toHaveBeenCalled();
  });
});

describe("a round trip that matches", () => {
  const cookie = sealBinding(BINDING);

  test("records the installation for the bound workspace and goes back", async () => {
    const res = await GET(setup(good, cookie));
    expect(install).toHaveBeenCalledTimes(1);
    expect(install).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "ws_1",
      installationId: 42,
      code: "c0de",
    });
    expect(landed(res)).toEqual({ path: BINDING.returnTo, github: "installed", reason: null });
    expect(clearsCookie(res)).toBe(true);
  });

  test("an install only requested of the organisation's owners records nothing", async () => {
    const res = await GET(setup({ state: BINDING.state, setup_action: "request" }, cookie));
    expect(landed(res)).toMatchObject({ github: "requested" });
    expect(install).not.toHaveBeenCalled();
  });

  test.each([
    ["missing", { state: BINDING.state, code: "c0de" }],
    ["zero", { ...good, installation_id: "0" }],
    ["not a number", { ...good, installation_id: "abc" }],
  ])("an installation id %s is refused", async (_, query) => {
    const res = await GET(setup(query, cookie));
    expect(landed(res)).toMatchObject({ github: "error", reason: "no_installation" });
    expect(install).not.toHaveBeenCalled();
  });

  test("no code is refused", async () => {
    const res = await GET(setup({ state: BINDING.state, installation_id: "42" }, cookie));
    expect(landed(res)).toMatchObject({ github: "error", reason: "no_code" });
    expect(install).not.toHaveBeenCalled();
  });

  test("GitHub not confirming the installation is said as verify", async () => {
    install.mockRejectedValue(new Error("not reachable"));
    const res = await GET(setup(good, cookie));
    expect(landed(res)).toMatchObject({ github: "error", reason: "verify" });
    expect(clearsCookie(res)).toBe(true);
  });
});
