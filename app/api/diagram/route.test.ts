import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The diagram route's wiring, as a stand-in for all three `agentGeneration`
 * routes: the gate's own mapping is covered in `requestLimitGate.test.ts`, and
 * what matters here is the ORDER — that a refusal is returned before the model
 * is ever reached, and that auth and validation still come before the gate so a
 * request that was going to be turned away never spends a token being checked.
 *
 * Everything with a key or a network behind it is replaced: `streamDiagram` is
 * the provider call this commit exists to guard, so the load-bearing assertion
 * throughout is simply whether it was invoked.
 */

// Hoisted so the mock factories below — which vitest lifts to the top of the
// file — can close over them without reaching a not-yet-initialised `const`.
const { streamDiagram, refuseIfLimited, refuseIfSpent, sessionToken } = vi.hoisted(() => ({
  streamDiagram: vi.fn(),
  refuseIfLimited: vi.fn(),
  refuseIfSpent: vi.fn(),
  sessionToken: vi.fn(),
}));

vi.mock("@/app/lib/ai/diagram", () => ({ streamDiagram }));
vi.mock("@/app/lib/requestLimitGate", () => ({ refuseIfLimited }));
vi.mock("@/app/lib/entitlementGate", () => ({ refuseIfSpent }));
vi.mock("@/app/lib/session", () => ({ sessionToken }));
// Touched only inside the record/stream callbacks, never on the refusal path;
// stubbed so importing the route needs no Convex URL.
vi.mock("@/app/lib/convexServer", () => ({ asUser: () => ({}) }));
vi.mock("@/app/lib/ai/recordCall", () => ({ recordAiCall: vi.fn() }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://test/api/diagram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  sessionToken.mockResolvedValue("tok");
  refuseIfLimited.mockResolvedValue(null);
  refuseIfSpent.mockResolvedValue(null);
  streamDiagram.mockReturnValue(new Response("<nt-diagram/>"));
});

afterEach(() => {
  vi.clearAllMocks();
});

test("a rate refusal is returned and the model is never reached", async () => {
  const wall = new Response(JSON.stringify({ code: "rate_limit" }), { status: 429 });
  refuseIfLimited.mockResolvedValue(wall);

  const res = await POST(post({ brief: "a flowchart of the login flow" }));

  expect(res.status).toBe(429);
  expect(streamDiagram).not.toHaveBeenCalled();
});

test("an admitted request reaches the model exactly once", async () => {
  const res = await POST(post({ brief: "a flowchart of the login flow" }));

  expect(res.status).toBe(200);
  expect(refuseIfLimited).toHaveBeenCalledTimes(1);
  expect(refuseIfLimited.mock.calls[0][1]).toBe("agentGeneration");
  expect(streamDiagram).toHaveBeenCalledTimes(1);
});

test("auth comes before the gate: no token is 401 and never consults the limiter", async () => {
  sessionToken.mockResolvedValue(null);

  const res = await POST(post({ brief: "anything" }));

  expect(res.status).toBe(401);
  expect(refuseIfLimited).not.toHaveBeenCalled();
  expect(streamDiagram).not.toHaveBeenCalled();
});

test("validation comes before the gate: a bad body is 400 and consumes nothing", async () => {
  const res = await POST(post({ brief: "   " }));

  expect(res.status).toBe(400);
  expect(refuseIfLimited).not.toHaveBeenCalled();
  expect(streamDiagram).not.toHaveBeenCalled();
});

test("malformed JSON is 400 before the gate", async () => {
  const bad = new Request("http://test/api/diagram", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });

  const res = await POST(bad);

  expect(res.status).toBe(400);
  expect(refuseIfLimited).not.toHaveBeenCalled();
  expect(streamDiagram).not.toHaveBeenCalled();
});

test("a guest past their day is refused after the limiter and before the model", async () => {
  const wall = new Response(JSON.stringify({ code: "quota", meter: "guestAi" }), { status: 402 });
  refuseIfSpent.mockResolvedValue(wall);

  const res = await POST(post({ brief: "a flowchart", projectId: "p1" }));

  expect(res.status).toBe(402);
  expect(refuseIfLimited).toHaveBeenCalledTimes(1);
  // No meter of its own: only the guest's day is asked, of the named project.
  expect(refuseIfSpent.mock.calls[0]).toEqual(["tok", null, "p1"]);
  expect(streamDiagram).not.toHaveBeenCalled();
});
