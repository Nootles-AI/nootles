import { beforeEach, expect, test, vi } from "vitest";
import type { NamingOutline } from "@/convex/github/naming";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  refuseIfLimited: vi.fn(),
  refuseIfSpent: vi.fn(),
  mutation: vi.fn(),
  recordAiCall: vi.fn(),
  postChat: vi.fn(),
}));

vi.mock("@/app/lib/session", () => ({ session: mocks.session }));
vi.mock("@/app/lib/requestLimitGate", () => ({
  refuseIfLimited: mocks.refuseIfLimited,
}));
vi.mock("@/app/lib/entitlementGate", () => ({
  refuseIfSpent: mocks.refuseIfSpent,
}));
vi.mock("@/app/lib/convexServer", () => ({
  asSession: () => ({ mutation: mocks.mutation }),
}));
vi.mock("@/app/lib/ai/recordCall", () => ({
  recordAiCall: mocks.recordAiCall,
}));
vi.mock("@/app/lib/ai/providers", () => ({
  chatTarget: () => ({ url: "https://example.invalid", key: "test", body: {} }),
  postChat: mocks.postChat,
  readUsage: () => ({ promptTokens: 10, completionTokens: 20 }),
  reportUpstream: vi.fn(),
}));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({
    token: "tok",
    sessionId: "sess",
    userId: "user_1",
  });
  mocks.refuseIfLimited.mockResolvedValue(null);
  mocks.refuseIfSpent.mockResolvedValue(null);
});

test("a user linking a large repository gets recovered names applied after a cut-off reply", async () => {
  const outline: NamingOutline = {
    fullName: "sample/product",
    description: "Synthetic repository",
    areas: [
      {
        nodeId: "area-1",
        name: "src",
        concerns: Array.from({ length: 36 }, (_, i) => ({
          nodeId: `concern-${i}`,
          name: `feature-${i}`,
          styling: false,
          files: [{ path: `src/feature-${i}.ts`, brief: "Runs this feature." }],
          more: 0,
        })),
      },
    ],
  };
  mocks.mutation.mockResolvedValueOnce(outline);
  let calls = 0;
  mocks.postChat.mockImplementation(async (_target, body) => {
    const prompt = (body.messages as { content: string }[])[1].content;
    const ids = [...prompt.matchAll(/(?:AREA|CONCERN) id=([^\s]+)/g)].map(
      (m) => m[1],
    );
    const content =
      ++calls === 1
        ? `{"names":[{"id":"${ids[0]}","title":"Product area","brief":"Owns the features."},{"id":"${ids[1]}"`
        : JSON.stringify({
            names: ids.map((id) => ({
              id,
              title: `Named ${id}`,
              brief: "Runs this feature.",
            })),
          });
    return Response.json({
      choices: [
        {
          message: { content },
          finish_reason: calls === 1 ? "length" : "stop",
        },
      ],
    });
  });

  const res = await POST(
    new Request("http://test/api/context/name", {
      method: "POST",
      body: JSON.stringify({ repoId: "repo-1", projectId: "project-1" }),
    }),
  );

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ named: 37 });
  expect(mocks.mutation).toHaveBeenCalledTimes(2);
  const saved = mocks.mutation.mock.calls[1][1].names as { nodeId: string }[];
  expect(new Set(saved.map((n) => n.nodeId)).size).toBe(37);
  expect(mocks.recordAiCall).toHaveBeenCalledTimes(calls);
  expect(
    mocks.recordAiCall.mock.calls.some(
      ([, row]) => row.errorCode === "truncated",
    ),
  ).toBe(true);
  expect(mocks.refuseIfSpent).toHaveBeenCalledWith("tok", null, "project-1");
});
