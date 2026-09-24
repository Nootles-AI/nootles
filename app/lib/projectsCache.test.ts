import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Project } from "@/app/components/projectParts";
import type { WorkspaceContainer } from "@/app/components/workspaces/ContainerContext";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The cache is only ever a first paint, but what it keeps is private: a
 * workspace's project titles once the seat is gone, or one account's
 * projects in another's browser session, must not come back. Each "visit"
 * below is a fresh import over the same storage, the way a reload is.
 */

const KEY = "nt:projectsScreen";

let stored: Map<string, string>;

beforeEach(() => {
  stored = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  });
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The module as a new page load finds it: nothing in memory, storage as left. */
const visit = () => import("./projectsCache");

/** Writes are debounced; this is the moment they land. */
const settle = () => vi.runAllTimers();

const WS = "ws1" as Id<"workspaces">;

const project = (id: string, title: string) =>
  ({ _id: id, title, pageCount: 1, firstPageDocId: null, updatedAt: 1 }) as unknown as Project;

const acme = (slug: string): WorkspaceContainer => ({
  kind: "workspace",
  workspaceId: WS,
  slug,
  name: "Acme",
  role: "member",
});

describe("the projects cache", () => {
  test("a blob from before homes were kept apart is dropped unread", async () => {
    stored.set(
      KEY,
      JSON.stringify({
        v: 1,
        user: "u",
        projects: [project("p1", "Old shape")],
        shared: [],
        previews: {},
      }),
    );
    const cache = await visit();
    expect(cache.seenScreen("u")).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  test("a workspace's list is its own home's, never your own", async () => {
    const first = await visit();
    first.rememberScreen("u", WS, [project("p1", "Roadmap")], []);
    settle();

    vi.resetModules();
    const cache = await visit();
    expect(cache.seenScreen("u")).toBeNull();
    expect(cache.seenScreen("u", cache.ACCOUNT)).toBeNull();
    expect(cache.seenScreen("u", WS)?.projects.map((p) => p.title)).toEqual(["Roadmap"]);
  });

  test("a seat taken away takes its list with it, once no address of it is left", async () => {
    const cache = await visit();
    cache.rememberScreen("u", WS, [project("p1", "Roadmap")], []);
    cache.rememberWorkspace("u", "acme", acme("acme"));
    cache.rememberWorkspace("u", "acme-old", acme("acme"));

    // One address stops resolving; another of the same workspace still did.
    cache.rememberWorkspace("u", "acme", null);
    expect(cache.seenWorkspace("u", "acme")).toBeNull();
    expect(cache.seenScreen("u", WS)).not.toBeNull();

    // The last one goes: nothing of the workspace is drawn again.
    cache.rememberWorkspace("u", "acme-old", null);
    expect(cache.seenScreen("u", WS)).toBeNull();
    settle();

    vi.resetModules();
    const next = await visit();
    expect(next.seenWorkspace("u", "acme-old")).toBeNull();
    expect(next.seenScreen("u", WS)).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  test("a seat with settings to open is remembered; a guest's is not", async () => {
    const first = await visit();
    expect(first.seenSeat("u")).toBe(false);
    first.rememberWorkspace("u", "acme", { ...acme("acme"), role: "guest" });
    expect(first.seenSeat("u")).toBe(false);
    first.rememberWorkspace("u", "acme", acme("acme"));
    settle();

    vi.resetModules();
    const cache = await visit();
    expect(cache.seenSeat("u")).toBe(true);
    expect(cache.seenSeat("someone-else")).toBe(false);
  });

  test("another account's cache is dropped unread", async () => {
    const first = await visit();
    first.rememberScreen("a", first.ACCOUNT, [project("p1", "A’s project")], []);
    first.rememberWorkspace("a", "acme", acme("acme"));
    settle();
    expect(stored.has(KEY)).toBe(true);

    vi.resetModules();
    const cache = await visit();
    expect(cache.seenWorkspace("b", "acme")).toBeNull();
    expect(cache.seenScreen("b")).toBeNull();
    expect(stored.has(KEY)).toBe(false);
  });

  test("only what a card draws is kept, never the rest of the row", async () => {
    const cache = await visit();
    const row = { ...project("p1", "Roadmap"), shareToken: "secret" } as Project;
    cache.rememberScreen("u", cache.ACCOUNT, [row], []);
    settle();
    expect(stored.get(KEY)).not.toContain("secret");
  });

  test("a workspace row keeps what decides its verbs and its lock", async () => {
    const first = await visit();
    const row = { ...project("p1", "Notes"), role: "editor", visibility: "private" } as Project;
    first.rememberScreen("u", WS, [row], []);
    settle();

    vi.resetModules();
    const cache = await visit();
    expect(cache.seenScreen("u", WS)?.projects[0]).toMatchObject({
      role: "editor",
      visibility: "private",
    });
  });
});
