import { describe, expect, it } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import type { PageComments } from "./PageComments";
import { PageCommentsRegistry } from "./registry";

const value = (status: PageComments["status"]): PageComments => ({
  pageId: "p1" as Id<"pages">,
  access: { canRead: true, canComment: true },
  userId: "user_ada",
  status,
  doc: null,
  threads: [],
  store: null,
  history: null,
  ensureStore: async () => {
    throw new Error("unused");
  },
});

describe("PageCommentsRegistry", () => {
  it("answers with a page's latest value, and forgets it only on its own withdrawal", () => {
    const registry = new PageCommentsRegistry();
    expect(registry.current("p1")).toBeNull();
    let current = value("absent");
    const first = registry.publish("p1", () => current);
    expect(registry.current("p1")).toBe(current);
    current = value("ready");
    expect(registry.current("p1")?.status).toBe("ready");

    // The same page in a second pane, then the first pane closing.
    const second = value("ready");
    const withdraw = registry.publish("p1", () => second);
    first();
    expect(registry.current("p1")).toBe(second);
    withdraw();
    expect(registry.current("p1")).toBeNull();
  });

  it("keeps a page while any pane still holds it, whichever closes first", () => {
    const registry = new PageCommentsRegistry();
    const main = value("ready");
    const aside = value("absent");
    const closeMain = registry.publish("p1", () => main);
    const closeAside = registry.publish("p1", () => aside);
    expect(registry.current("p1")).toBe(aside);
    closeAside();
    expect(registry.current("p1")).toBe(main);
    closeMain();
    expect(registry.current("p1")).toBeNull();
  });

  it("waits for a page to be published and to finish loading", async () => {
    const registry = new PageCommentsRegistry();
    let current = value("loading");
    let settled: PageComments | null = null;
    const waiting = registry.settled("p1", 1_000).then((v) => (settled = v));

    registry.publish("p1", () => current);
    await Promise.resolve();
    expect(settled).toBeNull();

    current = value("absent");
    registry.changed();
    await waiting;
    expect(settled).toBe(current);
  });

  it("gives up on a page whose comments never load", async () => {
    const registry = new PageCommentsRegistry();
    registry.publish("p1", () => value("loading"));
    await expect(registry.settled("p1", 10)).rejects.toThrow("did not finish loading");
  });
});
