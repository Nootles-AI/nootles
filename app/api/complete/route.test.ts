import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * Completion names its project on the gate and on the ledger row, so a guest
 * on a workspace project is asked their day before a single token streams.
 * The gate's own answer is `entitlementGate.test.ts`'s.
 */

const { streamFim, refuseIfSpent, session, recordAiCall } = vi.hoisted(() => ({
  streamFim: vi.fn(),
  refuseIfSpent: vi.fn(),
  session: vi.fn(),
  recordAiCall: vi.fn(),
}));

vi.mock("@/app/lib/ai/fim", () => ({ streamFim }));
vi.mock("@/app/lib/entitlementGate", () => ({ refuseIfSpent }));
vi.mock("@/app/lib/session", () => ({ session }));
vi.mock("@/app/lib/convexServer", () => ({ asUser: () => ({}) }));
vi.mock("@/app/lib/ai/recordCall", () => ({ recordAiCall }));

import { POST } from "./route";

function post(body: unknown): Request {
  return new Request("http://test/api/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  session.mockResolvedValue({ token: "tok", sessionId: "sess", userId: "user_1" });
  refuseIfSpent.mockResolvedValue(null);
  streamFim.mockReturnValue(new Response("done"));
});

afterEach(() => {
  vi.clearAllMocks();
});

test("a guest past their day is refused before the model, for the project named", async () => {
  refuseIfSpent.mockResolvedValue(
    new Response(JSON.stringify({ code: "quota", meter: "guestAi" }), { status: 402 }),
  );

  const res = await POST(post({ before: "x", projectId: "p1" }));

  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({ code: "quota", meter: "guestAi" });
  expect(refuseIfSpent.mock.calls).toEqual([["tok", "completions", "p1"]]);
  expect(streamFim).not.toHaveBeenCalled();
});

test("a project named as anything but a string is no project", async () => {
  await POST(post({ before: "x", projectId: 7 }));

  expect(refuseIfSpent.mock.calls).toEqual([["tok", "completions", undefined]]);
});

test("an allowed completion streams, and its ledger row names the same project", async () => {
  const res = await POST(post({ before: "x", projectId: "p1" }));

  expect(res.status).toBe(200);
  expect(refuseIfSpent.mock.calls).toEqual([["tok", "completions", "p1"]]);
  expect(streamFim).toHaveBeenCalledOnce();
  const { onDone } = streamFim.mock.calls[0][2] as { onDone: (r: object) => void };
  onDone({ usage: {}, latencyMs: 1, ttfbMs: 1, status: "ok" });
  expect(recordAiCall).toHaveBeenCalledWith(
    {},
    expect.objectContaining({ ownerId: "user_1", feature: "fim", projectId: "p1" }),
  );
});

test("nobody signed in is refused before the gate", async () => {
  session.mockResolvedValue(null);

  const res = await POST(post({ before: "x", projectId: "p1" }));

  expect(res.status).toBe(401);
  expect(refuseIfSpent).not.toHaveBeenCalled();
  expect(streamFim).not.toHaveBeenCalled();
});
