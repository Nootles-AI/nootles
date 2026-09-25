import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * PostHog loads after the first paint, off the first-load bundle; everything
 * tracked before then must reach it, in the order it happened. Each test is a
 * fresh import, the way a page load is.
 */

const calls: unknown[][] = [];
const fake = {
  init: (...args: unknown[]) => void calls.push(["init", ...args]),
  capture: (...args: unknown[]) => void calls.push(["capture", ...args]),
  identify: (...args: unknown[]) => void calls.push(["identify", ...args]),
};

vi.mock("posthog-js", () => ({ default: fake }));

async function load(key: string | undefined) {
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", key);
  return import("./telemetry");
}

beforeEach(() => {
  calls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("telemetry queue", () => {
  test("what is tracked before the boot is replayed after init, in order", async () => {
    const t = await load("phc_test");
    t.track("project_created", {});
    t.withAnalytics((posthog) => posthog.identify("user_1"));
    t.track("page_created", { mode: "doc" });
    expect(calls).toEqual([]);

    await t.bootAnalytics((posthog) => posthog.init("phc_test"));
    t.track("folder_created", {});

    expect(calls).toEqual([
      ["init", "phc_test"],
      ["capture", "project_created", {}],
      ["identify", "user_1"],
      ["capture", "page_created", { mode: "doc" }],
      ["capture", "folder_created", {}],
    ]);
    expect(t.loadedAnalytics()).toBe(fake);
  });

  test("booting twice inits once", async () => {
    const t = await load("phc_test");
    const init = vi.fn();
    await Promise.all([t.bootAnalytics(init), t.bootAnalytics(init)]);
    expect(init).toHaveBeenCalledTimes(1);
  });

  test("a throwing call neither breaks the caller nor the replay", async () => {
    const t = await load("phc_test");
    t.withAnalytics(() => {
      throw new Error("boom");
    });
    t.track("project_created", {});
    await t.bootAnalytics(() => {});
    expect(calls).toEqual([["capture", "project_created", {}]]);
    expect(() =>
      t.withAnalytics(() => {
        throw new Error("boom");
      }),
    ).not.toThrow();
  });

  test("without a key nothing is queued", async () => {
    const t = await load(undefined);
    t.track("project_created", {});
    await t.bootAnalytics(() => {});
    expect(calls).toEqual([]);
    t.track("page_created", {});
    expect(calls).toEqual([["capture", "page_created", {}]]);
  });

  test("a failed init drops the queue and leaves analytics off", async () => {
    const t = await load("phc_test");
    t.track("project_created", {});
    await t.bootAnalytics(() => {
      throw new Error("blocked");
    });
    t.track("page_created", {});
    expect(calls).toEqual([]);
    expect(t.loadedAnalytics()).toBeUndefined();
  });
});
