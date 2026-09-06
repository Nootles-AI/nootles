import { describe, expect, it } from "vitest";
import { pageIdResolver, planImport, type NotionPageNode } from "./plan";

const node = (id: string, title: string, children: NotionPageNode[] = [], extra: Partial<NotionPageNode> = {}): NotionPageNode =>
  ({ id, title, children, ...extra });

const all = (...ids: string[]) => new Set(ids);

describe("planImport", () => {
  it("makes a plain page of a leaf", () => {
    const plan = planImport([node("a", "Notes")], all("a"));
    expect(plan.folders).toEqual([]);
    expect(plan.pages).toMatchObject([{ notionId: "a", title: "Notes", order: 0 }]);
    expect(plan.pages[0].folderKey).toBeUndefined();
  });

  it("makes a folder of the same name for a page that has selected children", () => {
    const plan = planImport(
      [node("a", "Handbook", [node("b", "Onboarding"), node("c", "Benefits")])],
      all("a", "b", "c"),
    );
    expect(plan.folders).toMatchObject([{ title: "Handbook", order: 0 }]);
    const folderKey = plan.folders[0].key;
    // The container's own writing survives as a page inside its folder, first.
    expect(plan.pages).toMatchObject([
      { notionId: "a", title: "Handbook", folderKey, order: 0 },
      { notionId: "b", title: "Onboarding", folderKey, order: 1 },
      { notionId: "c", title: "Benefits", folderKey, order: 2 },
    ]);
  });

  it("keeps a page flat when its children were not selected", () => {
    const plan = planImport([node("a", "Handbook", [node("b", "Onboarding")])], all("a"));
    expect(plan.folders).toEqual([]);
    expect(plan.pages).toMatchObject([{ notionId: "a" }]);
  });

  it("carries a selected child up when its parent was not selected", () => {
    const plan = planImport([node("a", "Handbook", [node("b", "Onboarding")])], all("b"));
    expect(plan.folders).toMatchObject([{ title: "Handbook" }]);
    expect(plan.pages).toMatchObject([{ notionId: "b", order: 0 }]);
    expect(plan.diagnostics.map((d) => d.code)).toContain("container_not_selected");
  });

  it("nests folders as deep as the selection goes", () => {
    const plan = planImport(
      [node("a", "A", [node("b", "B", [node("c", "C")])])],
      all("a", "b", "c"),
    );
    expect(plan.folders.map((f) => f.title)).toEqual(["A", "B"]);
    const [outer, inner] = plan.folders;
    expect(inner.parentKey).toBe(outer.key);
    expect(plan.pages.map((p) => p.title)).toEqual(["A", "B", "C"]);
    expect(plan.pages[2].folderKey).toBe(inner.key);
  });

  it("orders folders and pages on one line per level", () => {
    const plan = planImport(
      [node("a", "Alpha"), node("b", "Beta", [node("c", "Gamma")]), node("d", "Delta")],
      all("a", "b", "c", "d"),
    );
    const top = [
      ...plan.folders.filter((f) => !f.parentKey).map((f) => ({ title: f.title, order: f.order })),
      ...plan.pages.filter((p) => !p.folderKey).map((p) => ({ title: p.title, order: p.order })),
    ].sort((x, y) => x.order - y.order);
    expect(top).toEqual([
      { title: "Alpha", order: 0 },
      { title: "Beta", order: 1 },
      { title: "Delta", order: 2 },
    ]);
  });

  it("ignores branches with nothing selected", () => {
    const plan = planImport([node("a", "A"), node("b", "B", [node("c", "C")])], all("a"));
    expect(plan.pages).toHaveLength(1);
    expect(plan.folders).toEqual([]);
  });

  it("falls back to Untitled and reports an icon it cannot carry", () => {
    const plan = planImport([node("a", "  ", [], { hasFileIcon: true })], all("a"));
    expect(plan.pages[0].title).toBe("Untitled");
    expect(plan.diagnostics.map((d) => d.code)).toContain("file_icon_dropped");
  });

  it("carries an emoji icon onto both the folder and its page", () => {
    const plan = planImport([node("a", "Trips", [node("b", "Japan")], { emoji: "✈️" })], all("a", "b"));
    expect(plan.folders[0].emoji).toBe("✈️");
    expect(plan.pages[0].emoji).toBe("✈️");
  });
});

describe("pageIdResolver", () => {
  it("resolves ids however Notion happens to hyphenate them", () => {
    const dashed = "1a2b3c4d-5e6f-7081-9203-a4b5c6d7e8f9";
    const resolve = pageIdResolver(new Map([[dashed, "page-1"]]));
    expect(resolve(dashed)).toBe("page-1");
    expect(resolve(dashed.replace(/-/g, ""))).toBe("page-1");
    expect(resolve("something-else")).toBeUndefined();
  });
});
