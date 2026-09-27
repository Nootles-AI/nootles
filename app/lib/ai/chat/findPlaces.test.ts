import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ConvexHttpClient } from "convex/browser";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * `find_places` against a scripted Places search and an in-memory holding pen:
 * the model is handed short photo names, and the pen holds what they stand for
 * before it is (NT-98). Nothing leaves the process.
 */

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("@/app/lib/places", () => ({ configured: () => true, search }));
vi.mock("./provider", () => ({ writerModel: vi.fn(), searchModel: vi.fn() }));
vi.mock("../recordCall", () => ({ recordAiCall: vi.fn() }));
vi.mock("server-only", () => ({}));

import { chatTools } from "./serverTools";
import { redeemPhotos } from "./placePhotos";

const photo = (n: number) =>
  `/api/places/photo?ref=${encodeURIComponent(`places/ChIJ${"a".repeat(20)}/photos/AUc7t${"Q".repeat(200)}${n}`)}`;
const HITS = [
  { place: "ChIJ1", name: "Tartine", rating: 4.5, votes: 900, photos: [photo(0), photo(1)] },
  { place: "ChIJ2", name: "Sightglass", photos: [photo(2)] },
];

function convexStandIn(refuse = false) {
  const pen = new Map<string, string>();
  const mutation = vi.fn(async (_fn: unknown, args: { ref: string; data: string }) => {
    if (refuse) throw new Error("Convex is down");
    pen.set(args.ref, args.data);
    return null;
  });
  return { pen, mutation, convex: { query: vi.fn(), mutation, action: vi.fn() } as unknown as ConvexHttpClient };
}

const find = async (convex: ConvexHttpClient) => {
  const tools = chatTools("project" as Id<"projects">, convex, "user_ada");
  const run = tools.find_places.execute as (input: unknown, options: unknown) => Promise<unknown>;
  return (await run({ query: "cafes in the Mission" }, { toolCallId: "c1", messages: [] })) as {
    name: string;
    photos: string[];
  }[];
};

describe("find_places photographs (NT-98)", () => {
  beforeEach(() => search.mockResolvedValue({ places: HITS }));

  test("come back as short names the pen can redeem, and nothing else changes", async () => {
    const { pen, convex } = convexStandIn();
    const places = await find(convex);
    const [ref] = [...pen.keys()];
    expect(ref).toMatch(/^p[0-9a-f]{10}$/);
    expect(places.map((p) => p.photos)).toEqual([[`${ref}.0`, `${ref}.1`], [`${ref}.2`]]);
    expect(places[0]).toMatchObject({ place: "ChIJ1", name: "Tartine", rating: 4.5, votes: 900 });
    expect(JSON.stringify(places).length * 4).toBeLessThan(JSON.stringify(HITS).length);
    expect(redeemPhotos(`<img src="${ref}.2">`, Object.fromEntries(pen))).toEqual({
      html: `<img src="${photo(2)}">`,
    });
  });

  test("the same search names the same photographs, so a retry places the same card", async () => {
    const { pen, convex } = convexStandIn();
    expect(await find(convex)).toEqual(await find(convex));
    expect(pen.size).toBe(1);
  });

  test("a search with no photographs writes nothing", async () => {
    search.mockResolvedValue({ places: [{ place: "ChIJ3", name: "Ritual", photos: [] }] });
    const { mutation, convex } = convexStandIn();
    expect(await find(convex)).toEqual([{ place: "ChIJ3", name: "Ritual", photos: [] }]);
    expect(mutation).not.toHaveBeenCalled();
  });

  test("a pen that will not take them costs the names, not the search", async () => {
    const { convex } = convexStandIn(true);
    expect(await find(convex)).toEqual(HITS);
  });
});
