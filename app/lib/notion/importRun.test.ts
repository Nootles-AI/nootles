import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import type { Id } from "@/convex/_generated/dataModel";
import { importReferencedPage, runImport } from "./importRun";
import type { NotionBlock } from "./types";

// The document seed needs a live BlockNote editor, which this environment has
// none of. What these tests watch is whether a page is written at all.
vi.mock("@/app/lib/onboarding/seed", () => ({ seedUpdate: () => new ArrayBuffer(2) }));

/**
 * Stopping while Notion is being read.
 *
 * Reading a large page is minutes of `fetchBlocks`, and a stop — closing the
 * link menu, or the wizard's Stop — lands in the middle of it far more often
 * than anywhere else. The walk on the server cannot be called back; what the
 * stop can still decide is that nothing it was stopped from importing is
 * written. Each test holds Notion's answer until the stop has happened.
 */

const PARAGRAPH = {
  id: "notion-block-1",
  type: "paragraph",
  paragraph: {
    rich_text: [
      {
        type: "text",
        plain_text: "Hello",
        text: { content: "Hello" },
        annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
      },
    ],
  },
} as NotionBlock;

/** A backend that records every call and answers `fetchBlocks` when told to. */
function backend() {
  const calls: string[] = [];
  const created: unknown[] = [];
  let answer!: (blocks: NotionBlock[]) => void;
  const read = new Promise<NotionBlock[]>((resolve) => (answer = resolve));
  const record = (reference: Parameters<typeof getFunctionName>[0]) => {
    const name = getFunctionName(reference);
    calls.push(name);
    return name;
  };
  const client = {
    mutation: async (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
      switch (record(reference)) {
        case "projects:create":
          created.push(args);
          return "project_1";
        case "pages:create":
          return `page_${calls.length}`;
        default:
          return null;
      }
    },
    query: async (reference: Parameters<typeof getFunctionName>[0], args: { pageId?: string }) => {
      switch (record(reference)) {
        case "pages:get":
          return { _id: args.pageId, docId: "doc_1", title: "" };
        case "pages:listByProject":
          return [{ _id: "page_seed" }];
        default:
          return null;
      }
    },
    action: async (reference: Parameters<typeof getFunctionName>[0]) =>
      record(reference) === "notion/pages:fetchBlocks" ? read : null,
  };
  return {
    client: client as unknown as ConvexReactClient,
    calls,
    created,
    answer,
    reading: () => calls.includes("notion/pages:fetchBlocks"),
  };
}

describe("a followed link", () => {
  it("closed while Notion is being read writes nothing and takes its page back out", async () => {
    const b = backend();
    const menu = new AbortController();
    const run = importReferencedPage(b.client, {
      projectId: "project_1" as Id<"projects">,
      notionPageId: "notion-page-1",
      title: "Alpha",
      signal: menu.signal,
    });
    await vi.waitFor(() => expect(b.reading()).toBe(true));
    menu.abort();
    b.answer([PARAGRAPH]);
    const { progress } = await run;

    expect(b.calls).not.toContain("ydoc:init");
    expect(b.calls).toContain("pages:remove");
    expect(progress).toMatchObject({ state: "failed", error: "Import stopped." });
  });

  it("left open lands as it always did", async () => {
    const b = backend();
    const run = importReferencedPage(b.client, {
      projectId: "project_1" as Id<"projects">,
      notionPageId: "notion-page-1",
      title: "Alpha",
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(b.reading()).toBe(true));
    b.answer([PARAGRAPH]);
    const { progress } = await run;

    expect(b.calls).toContain("ydoc:init");
    expect(b.calls).not.toContain("pages:remove");
    expect(progress.state).toBe("done");
  });
});

describe("the wizard", () => {
  it("stopped during its only page's read reports the stop and keeps nothing it made", async () => {
    const b = backend();
    const stop = new AbortController();
    const run = runImport({
      client: b.client,
      roots: [{ id: "notion-page-1", title: "Whiskey", children: [] }],
      selection: new Set(["notion-page-1"]),
      newProjectTitle: "Whiskey",
      onProgress: () => {},
      signal: stop.signal,
    });
    await vi.waitFor(() => expect(b.reading()).toBe(true));
    stop.abort();
    b.answer([PARAGRAPH]);
    const progress = await run;

    expect(b.calls).not.toContain("ydoc:init");
    expect(b.calls).toContain("projects:remove");
    expect(progress).toMatchObject({ phase: "failed", error: "Import stopped." });
  });

  it("started in a workspace makes the project there, and takes it back by discarding it", async () => {
    const b = backend();
    const stop = new AbortController();
    const workspace = { workspaceId: "workspace_1" as Id<"workspaces">, visibility: "private" as const };
    const run = runImport({
      client: b.client,
      roots: [{ id: "notion-page-1", title: "Whiskey", children: [] }],
      selection: new Set(["notion-page-1"]),
      newProjectTitle: "Whiskey",
      workspace,
      onProgress: () => {},
      signal: stop.signal,
    });
    await vi.waitFor(() => expect(b.reading()).toBe(true));
    stop.abort();
    b.answer([PARAGRAPH]);
    const progress = await run;

    expect(b.created).toEqual([{ title: "Whiskey", ...workspace }]);
    // Its maker only edits a workspace project; removing one is its managers'.
    expect(b.calls).toContain("projects:discardFresh");
    expect(b.calls).not.toContain("projects:remove");
    expect(progress.projectId).toBeUndefined();
  });
});
