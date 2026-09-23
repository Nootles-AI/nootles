import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { Entitlement, Standing } from "@/convex/entitlements";
import { PLANS, utcDay } from "@/convex/plans";
import { forgetStanding, refuseIfSpent, standingFor } from "./entitlementGate";

/**
 * The completion pre-check answers per session AND per project, because the
 * project decides whose allowance is being asked about. What is pinned here
 * is the cache: one project's answer never stands in for another's, nor for
 * the caller's own account. Who gets the workspace's answer is Convex's to
 * decide (`convex/containers.test.ts`); here the deployment is a stub.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("./convexServer", () => ({ asUser: () => ({ query }) }));

const SPENT_METERS: Entitlement = {
  plan: "free",
  source: "none",
  left: { projects: 0, completions: 0, chats: 0 },
  used: { projects: 2, completions: 100, chats: 10 },
};
const SPENT: Standing = {
  container: { kind: "account" },
  plan: "free",
  features: PLANS.free,
  entitlement: SPENT_METERS,
  guestAi: null,
};
const WORKSPACE: Standing = {
  container: { kind: "workspace", workspaceId: "w1" as never, name: "Acme" },
  plan: "team",
  features: PLANS.team,
  entitlement: { plan: "pro", source: "workspace", left: null, used: null },
  guestAi: null,
};

/** A deployment where the caller is spent and project "team" is a workspace's. */
function deployment(team: Standing = WORKSPACE) {
  query.mockImplementation(
    async (ref: FunctionReference<"query">, args: { projectId?: string }) => {
      const name = getFunctionName(ref);
      if (name !== "entitlements:forContainer") throw new Error(`unexpected ${name}`);
      return args.projectId === "team" ? team : SPENT;
    },
  );
}

beforeEach(() => {
  forgetStanding();
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
    await refuseIfSpent("token", "completions");
    const asked = query.mock.calls.map(([ref, args]) => [getFunctionName(ref), args]);
    expect(asked).toEqual([
      ["entitlements:forContainer", { projectId: "team" }],
      ["entitlements:forContainer", { projectId: "personal" }],
      ["entitlements:forContainer", {}],
    ]);
  });

  test("work that spends no meter is refused only by a guest's day", async () => {
    expect(await refuseIfSpent("token", null)).toBeNull();
    expect(await refuseIfSpent("token", null, "personal")).toBeNull();
  });
});

describe("a guest's day", () => {
  const guest = (spentUsd: number, day = utcDay(Date.now())): Standing => ({
    ...WORKSPACE,
    guestAi: { day, capUsd: 1, spentUsd },
  });

  test("a guest with the day spent is refused, whatever the work", async () => {
    deployment(guest(1));
    for (const meter of ["completions", null] as const) {
      const res = await refuseIfSpent("token", meter, "team");
      expect(res?.status).toBe(402);
      expect(await res?.json()).toEqual({ code: "quota", meter: "guestAi" });
    }
  });

  test("a guest with some of the day left goes through", async () => {
    deployment(guest(0.5));
    expect(await refuseIfSpent("token", "completions", "team")).toBeNull();
  });

  test("an answer counted on another day refuses nobody today", async () => {
    deployment(guest(5, "2000-01-01"));
    expect(await refuseIfSpent("token", "completions", "team")).toBeNull();
  });
});

describe("the cache", () => {
  test("keeps each project's answer apart from the account's and from each other", async () => {
    await standingFor("token");
    await standingFor("token", "team");
    await standingFor("token", "personal");
    expect(query).toHaveBeenCalledTimes(3);

    expect(await standingFor("token")).toEqual(SPENT);
    expect(await standingFor("token", "team")).toEqual(WORKSPACE);
    expect(await standingFor("token", "personal")).toEqual(SPENT);
    expect(query).toHaveBeenCalledTimes(3);
  });

  test("forgetting a session forgets every project's answer for it, and only its", async () => {
    await standingFor("token", "team");
    await standingFor("token");
    await standingFor("other", "team");
    forgetStanding("token");
    query.mockClear();

    await standingFor("token", "team");
    await standingFor("token");
    await standingFor("other", "team");
    expect(query).toHaveBeenCalledTimes(2);
  });

  test("a failed lookup proceeds, as before", async () => {
    query.mockRejectedValue(new Error("timeout"));
    expect(await refuseIfSpent("token", "completions", "team")).toBeNull();
  });
});
