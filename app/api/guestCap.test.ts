import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Every route that names a project on its ledger row bills that project's
 * workspace, so every one of them asks the guest's day first. Chat, completion
 * and diagram are pinned where they live; these are the rest. The gate's own
 * answer is `entitlementGate.test.ts`'s; what is pinned here is that each route
 * asks it, of the project the body named, and that a refusal never reaches the
 * model.
 */

const models = vi.hoisted(() => ({
  reformatCandidates: vi.fn(),
  completeFeedback: vi.fn(),
  categorizeFeedback: vi.fn(),
  describeSheet: vi.fn(),
  nameRepository: vi.fn(),
}));
const { refuseIfSpent, refuseIfLimited, session, mutation } = vi.hoisted(() => ({
  refuseIfSpent: vi.fn(),
  refuseIfLimited: vi.fn(),
  session: vi.fn(),
  mutation: vi.fn(),
}));

vi.mock("@/app/lib/ai/reformat", () => ({ reformatCandidates: models.reformatCandidates }));
vi.mock("@/app/lib/ai/feedbackComplete", () => ({ completeFeedback: models.completeFeedback }));
vi.mock("@/app/lib/ai/categorize", () => ({ categorizeFeedback: models.categorizeFeedback }));
vi.mock("@/app/lib/ai/albumIndex", () => ({ describeSheet: models.describeSheet }));
vi.mock("@/app/lib/ai/context/name", () => ({ nameRepository: models.nameRepository }));
vi.mock("@/app/lib/entitlementGate", () => ({ refuseIfSpent }));
vi.mock("@/app/lib/requestLimitGate", () => ({ refuseIfLimited }));
vi.mock("@/app/lib/session", () => ({ session }));
vi.mock("@/app/lib/convexServer", () => ({ asUser: () => ({ mutation }) }));
vi.mock("@/app/lib/ai/recordCall", () => ({ recordAiCall: vi.fn() }));

import { POST as album } from "./album/index/route";
import { POST as categorize } from "./categorize/route";
import { POST as name } from "./context/name/route";
import { POST as feedback } from "./feedback-complete/route";
import { POST as reformat } from "./reformat/route";

const ROUTES = [
  { route: "reformat", post: reformat, model: models.reformatCandidates, body: { block: "<p>x</p>" } },
  { route: "feedback-complete", post: feedback, model: models.completeFeedback, body: { text: "it broke" } },
  { route: "categorize", post: categorize, model: models.categorizeFeedback, body: { text: "it broke" } },
  {
    route: "album/index",
    post: album,
    model: models.describeSheet,
    body: { dataUri: "data:image/webp;base64,AA", handles: ["a"] },
  },
  { route: "context/name", post: name, model: models.nameRepository, body: { repoId: "r1" } },
];

function request(body: unknown): Request {
  return new Request("http://test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  session.mockResolvedValue({ token: "tok", sessionId: "sess", userId: "user_1" });
  refuseIfLimited.mockResolvedValue(null);
  refuseIfSpent.mockResolvedValue(null);
  mutation.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe.each(ROUTES)("$route", ({ post, model, body }) => {
  test("a guest past their day is refused before the model, for the project named", async () => {
    refuseIfSpent.mockResolvedValue(
      new Response(JSON.stringify({ code: "quota", meter: "guestAi" }), { status: 402 }),
    );

    const res = await post(request({ ...body, projectId: "p1" }));

    expect(res.status).toBe(402);
    expect(refuseIfSpent.mock.calls).toEqual([["tok", null, "p1"]]);
    expect(model).not.toHaveBeenCalled();
    // Nothing is claimed on a refusal, so the work is still there to do.
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a project named as anything but a string is no project", async () => {
    await post(request({ ...body, projectId: 7 }));

    expect(refuseIfSpent.mock.calls).toEqual([["tok", null, undefined]]);
  });
});
