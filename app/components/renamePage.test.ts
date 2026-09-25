import { describe, expect, test } from "vitest";
import type { OptimisticLocalStore } from "convex/browser";
import { getFunctionName, type FunctionReference } from "convex/server";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { renameLocally } from "./renamePage";

/** Just enough of Convex's local query store: results keyed by name and args. */
function storeOf(entries: [string, Record<string, unknown>, unknown][]) {
  const rows = entries.map(([name, args, value]) => ({ name, args, value }));
  const key = (args: unknown) => JSON.stringify(args);
  const store = {
    getQuery: (query: FunctionReference<"query">, args: Record<string, unknown>) =>
      rows.find((r) => r.name === getFunctionName(query) && key(r.args) === key(args))?.value,
    getAllQueries: (query: FunctionReference<"query">) =>
      rows.filter((r) => r.name === getFunctionName(query)),
    setQuery: (query: FunctionReference<"query">, args: Record<string, unknown>, value: unknown) => {
      const row = rows.find((r) => r.name === getFunctionName(query) && key(r.args) === key(args));
      if (row) row.value = value;
      else rows.push({ name: getFunctionName(query), args, value });
    },
  };
  return { store: store as unknown as OptimisticLocalStore, rows };
}

const page = (id: string, title: string) =>
  ({ _id: id as Id<"pages">, title }) as Doc<"pages">;
const pageId = "p1" as Id<"pages">;

describe("a rename, applied locally", () => {
  test("retitles the page and its row in every loaded list that holds it", () => {
    const other = [page("p9", "Elsewhere")];
    const { store, rows } = storeOf([
      ["pages:get", { pageId }, page("p1", "Old")],
      ["pages:listByProject", { projectId: "a" }, [page("p0", "Kept"), page("p1", "Old")]],
      ["pages:listByProject", { projectId: "b" }, other],
    ]);
    renameLocally(store, { pageId, title: "New" });
    expect(rows[0].value).toMatchObject({ title: "New" });
    expect((rows[1].value as Doc<"pages">[]).map((p) => p.title)).toEqual(["Kept", "New"]);
    expect(rows[2].value).toBe(other);
  });

  test("invents nothing for results this client never loaded", () => {
    const { store, rows } = storeOf([["pages:listByProject", { projectId: "a" }, undefined]]);
    renameLocally(store, { pageId, title: "New" });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBeUndefined();
  });
});
