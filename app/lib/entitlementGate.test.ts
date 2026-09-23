import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Entitlement } from "@/convex/entitlements";
import { entitlementFor, forgetEntitlement, refuseIfSpent } from "./entitlementGate";

/**
 * The completion pre-check answers per session AND per project, because the
 * project decides whose allowance is being asked about. What is pinned here
 * is the cache: one project's answer never stands in for another's, nor for
 * the caller's own account. Who gets the workspace's answer is Convex's to
 * decide (`convex/containers.test.ts`); here the deployment is a stub.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./convexServer", () => ({ asUser: () => ({ query }) }));

const SPENT: Entitlement = {
  plan: "free",
  source: "none",
  left: { projects: 0, completions: 0, chats: 0 },
  used: { projects: 2, completions: 100, chats: 10 },
};
const WORKSPACE: Entitlement = { plan: "pro", source: "workspace", left: null, used: null };

/** A deployment where the caller is spent and project "team" is a workspace's. */
function deployment() {
  query.mockImplementation(
    async (ref: FunctionReference<"query">, args: { projectId?: string }) => {
      const name = getFunctionName(ref);
      if (name === "entitlements:mine") return SPENT;
      if (name === "entitlements:forProject") {
        return args.projectId === "team" ? WORKSPACE : SPENT;
      }
      throw new Error(`unexpected ${name}`);
    },
  );
}

beforeEach(() => {
  forgetEntitlement();
  query.mockReset();
  deployment();
});

describe("the container is part of the answer", () => {
  test("a spent account is refused on its own and let through in a workspace project", async () => {
    expect((await refuseIfSpent("token", "completions"))?.status).toBe(402);
    expect(await refuseIfSpent("token", "completions", "team")).toBeNull();
    expect((await refuseIfSpent("token", "completions", "personal"))?.status).toBe(402);
  });

  test("each project is asked about under its own name", async () => {
    await refuseIfSpent("token", "completions", "team");
    await refuseIfSpent("token", "completions", "personal");
    const asked = query.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);
    expect(asked).toEqual([
      ["entitlements:forProject", { projectId: "team" }],
      ["entitlements:forProject", { projectId: "personal" }],
    ]);
  });
});

describe("the cache", () => {
  test("keeps each project's answer apart from the account's and from each other", async () => {
    await entitlementFor("token");
    await entitlementFor("token", "team");
    await entitlementFor("token", "personal");
    expect(query).toHaveBeenCalledTimes(3);

    expect(await entitlementFor("token")).toEqual(SPENT);
    expect(await entitlementFor("token", "team")).toEqual(WORKSPACE);
    expect(await entitlementFor("token", "personal")).toEqual(SPENT);
    expect(query).toHaveBeenCalledTimes(3);
  });

  test("forgetting a session forgets every project's answer for it, and only its", async () => {
    await entitlementFor("token", "team");
    await entitlementFor("token");
    await entitlementFor("other", "team");
    forgetEntitlement("token");
    query.mockClear();

    await entitlementFor("token", "team");
    await entitlementFor("token");
    await entitlementFor("other", "team");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("a failed lookup proceeds, as before", async () => {
    query.mockRejectedValue(new Error("timeout"));
    expect(await refuseIfSpent("token", "completions", "team")).toBeNull();
  });
});
