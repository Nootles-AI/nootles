import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import type { Id } from "@/convex/_generated/dataModel";
import type { AnyBlock } from "../projection";
import { runClientTool, type ToolContext } from "./clientTools";
import { TOOLS } from "./tools";

/**
 * The page tools' shared default (NT-93): a tool given no pageId acts on the
 * open page, and none of them needs an `open_page` before it. Convex and the
 * editor are stand-ins; the executors are the shipped ones.
 */

beforeAll(() => {
  (globalThis as { DOMParser?: unknown }).DOMParser = class {
    parseFromString(html: string) {
      return parseHTML(html).document;
    }
  };
});

const projectId = "project-1" as Id<"projects">;
const OPEN = "page-open" as Id<"pages">;
const OTHER = "page-other" as Id<"pages">;

const paragraph = (id: string, text: string) =>
  ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] }) as AnyBlock;

function context(open: Id<"pages"> | null = OPEN) {
  const pages: Record<string, { _id: string; projectId: string; docId: string; title: string }> = {
    [OPEN]: { _id: OPEN, projectId, docId: "doc-open", title: "Launch plan" },
    [OTHER]: { _id: OTHER, projectId, docId: "doc-other", title: "Roadmap" },
  };
  // Only the live editor holds these words: the stored copy trails the caret.
  const live = [paragraph("p1", "Typed a moment ago")];
  const stage = vi.fn(async () => ({ added: 1, removed: 0, changed: 0 }));
  const openPage = vi.fn();
  const commentsFor = vi.fn(async () => null);
  const query = vi.fn(async (_fn: unknown, args: { pageId?: string }) =>
    args.pageId ? (pages[args.pageId] ?? null) : null,
  );
  const ctx = {
    convex: { query, mutation: vi.fn(), action: vi.fn() },
    projectId,
    review: { stage },
    openPageId: () => open,
    openPage,
    editorFor: vi.fn(async () => ({ document: live })),
    commentsFor,
    people: () => [],
  } as unknown as ToolContext;
  return { ctx, stage, openPage, commentsFor, query };
}

describe("the tool table", () => {
  it("has one read tool, and the page tools default to the open page", () => {
    expect(Object.keys(TOOLS)).not.toContain("read_open_page");
    expect(TOOLS.read_page.inputSchema.safeParse({}).success).toBe(true);
    expect(TOOLS.edit_page.inputSchema.safeParse({ html: "<p>x</p>" }).success).toBe(true);
    expect(TOOLS.read_comments.inputSchema.safeParse({}).success).toBe(true);
    // Showing a page is all open_page is for, so it still names one.
    expect(TOOLS.open_page.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("read_page", () => {
  it("with no pageId reads the open page from its live editor", async () => {
    const { ctx, openPage } = context();
    const out = String(await runClientTool("read_page", {}, ctx));
    expect(out).toContain("<title>Launch plan</title>");
    expect(out).toContain("Typed a moment ago");
    expect(openPage).not.toHaveBeenCalled();
  });

  it("with no pageId and nothing open asks for an id", async () => {
    const { ctx } = context(null);
    await expect(runClientTool("read_page", {}, ctx)).rejects.toThrow(
      "No page is open. Pass a pageId from list_pages.",
    );
  });
});

describe("edit_page", () => {
  it("with no pageId writes to the open page, with no open_page first", async () => {
    const { ctx, stage, openPage } = context();
    const out = String(await runClientTool("edit_page", { html: "<p>A new line</p>" }, ctx));
    expect(out).toMatch(/^Done: 1 block added\./);
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({ pageId: OPEN }));
    expect(openPage).toHaveBeenCalledWith(OPEN);
  });

  it("with no pageId and nothing open writes nothing", async () => {
    const { ctx, stage } = context(null);
    await expect(runClientTool("edit_page", { html: "<p>A new line</p>" }, ctx)).rejects.toThrow(
      "No page is open. Pass a pageId from list_pages.",
    );
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("read_comments", () => {
  it("on another page opens that page and reads there", async () => {
    const { ctx, openPage, commentsFor } = context();
    // The stand-in has no comments surface, so the read ends there — after
    // navigating, which is the point: no refusal, no open_page round trip.
    await expect(runClientTool("read_comments", { pageId: OTHER }, ctx)).rejects.toThrow(
      "Comments are not available here.",
    );
    expect(openPage).toHaveBeenCalledWith(OTHER);
    expect(commentsFor).toHaveBeenCalledWith(OTHER);
  });

  it("on the open page does not navigate", async () => {
    const { ctx, openPage, commentsFor } = context();
    await expect(runClientTool("read_comments", {}, ctx)).rejects.toThrow("Comments are not available here.");
    expect(openPage).not.toHaveBeenCalled();
    expect(commentsFor).toHaveBeenCalledWith(OPEN);
  });

  it("on a page the project does not have is refused before anything moves", async () => {
    const { ctx, openPage, commentsFor } = context();
    await expect(runClientTool("read_comments", { pageId: "page-nope" }, ctx)).rejects.toThrow(
      'There is no page with id "page-nope" in this project.',
    );
    expect(openPage).not.toHaveBeenCalled();
    expect(commentsFor).not.toHaveBeenCalled();
  });
});
