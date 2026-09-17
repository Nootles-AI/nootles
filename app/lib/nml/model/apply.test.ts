import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { runCanvasTool } from "@/app/lib/ai/canvas/execute";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { Scene } from "@/app/components/editor/canvas/scene/types";
import type { Batch } from "@/convex/ai/operations";
import type { NmlBlock, NmlDocument } from "../schema";
import { createNmlYDoc, decodeNmlDocument } from "../yjs";
import { applyNmlBatch } from "./apply";
import { createNmlCanvasHost } from "./canvasHost";

const parseHtml = (html: string) => parseHTML(html).document as unknown as Document;

function paragraph(id: string, text: string): NmlBlock {
  return { id, type: "paragraph", props: {}, content: [{ type: "text", text, marks: [] }], children: [] };
}

function scene(): Scene {
  return {
    id: "canvas",
    w: 960,
    h: 540,
    style: {},
    attrs: {},
    nodes: [{
      id: "shape",
      kind: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 60,
      rot: 0,
      style: {},
      label: "Start",
      locked: false,
      hidden: false,
      attrs: {},
    }],
    edges: [],
  };
}

function document(): NmlDocument {
  return {
    schemaVersion: 1,
    documentId: "served-doc",
    blocks: [
      paragraph("p1", "One"),
      paragraph("p2", "Two"),
      {
        id: "table",
        type: "table",
        props: { headerRows: 0 },
        columns: [{ id: "column-1" }],
        rows: [{ id: "row-1", cells: [{ id: "cell-1", content: [{ type: "text", text: "old", marks: [] }] }] }],
        children: [],
      },
      { id: "math", type: "mathBlock", props: {}, rows: [{ id: "math-1", latex: "x" }], children: [] },
      { id: "image", type: "image", props: { source: { kind: "url", url: "/old.png" } }, children: [] },
      { id: "canvas", type: "canvas", props: {}, scene: scene(), children: [] },
    ],
  };
}

function options(doc: Y.Doc) {
  let minted = 0;
  return {
    doc,
    origin: {
      version: 1 as const,
      transactionId: "model-transaction",
      batchId: "model-batch",
      actor: { kind: "model" as const, userId: "owner" },
      command: "model-batch",
    },
    idempotencyKey: "model-batch",
    authorize: () => true,
    createId: () => `minted-${++minted}`,
    parseHtml,
  };
}

describe("NML model operation applier", () => {
  it("lands the complete legacy operation vocabulary as one canonical transaction", async () => {
    const doc = createNmlYDoc(document());
    const changedScene = scene();
    changedScene.nodes[0] = { ...changedScene.nodes[0], x: 44, label: "Moved" };
    const batch: Batch = {
      ops: [
        {
          kind: "insertBlocks",
          at: { at: "after", ref: "p1" },
          blocks: [{
            tempId: "$new",
            type: "paragraph",
            content: [
              { type: "text", text: "New ", marks: ["bold"] },
              { type: "math", latex: "a+b" },
              { type: "pageRef", pageId: "page-2", title: "Other" },
            ],
          }],
        },
        { kind: "updateBlockProps", blockId: "image", props: { url: "/new.png", caption: "Caption" } },
        { kind: "updateBlockProps", blockId: "canvas", props: { data: serializeScene(changedScene) } },
        { kind: "setBlockContent", blockId: "p1", content: [{ type: "text", text: "Rewritten", marks: ["italic"] }] },
        {
          kind: "setTableRows",
          blockId: "table",
          headerRows: 1,
          rows: [
            [[{ type: "text", text: "A", marks: [] }], [{ type: "text", text: "B", marks: [] }]],
            [[{ type: "text", text: "C", marks: [] }], [{ type: "math", latex: "d" }]],
          ],
        },
        { kind: "setMathRows", blockId: "math", rows: ["x^2", "y^2"] },
        { kind: "updateMathRow", blockId: "math", rowIndex: 1, latex: "z^2" },
        { kind: "moveBlock", blockId: "$new", to: { at: "docEnd" } },
        { kind: "removeBlock", blockId: "p2" },
      ],
    };

    const applied = await applyNmlBatch({ ...options(doc), batch });
    const after = decodeNmlDocument(doc);
    expect(applied.receipt.commandCount).toBe(applied.commands.length);
    expect(applied.receipt.temporaryIds.$new).toMatch(/^minted-/);
    expect(after.blocks.map((block) => block.id)).toEqual([
      "p1",
      "table",
      "math",
      "image",
      "canvas",
      applied.receipt.temporaryIds.$new,
    ]);
    expect(after.blocks[0]).toMatchObject({ content: [{ text: "Rewritten", marks: ["italic"] }] });
    const table = after.blocks.find((block) => block.id === "table");
    expect(table).toMatchObject({
      type: "table",
      props: { headerRows: 1 },
      rows: [
        { cells: [{ content: [{ text: "A" }] }, { content: [{ text: "B" }] }] },
        { cells: [{ content: [{ text: "C" }] }, { content: [{ type: "math", latex: "d" }] }] },
      ],
    });
    expect(after.blocks.find((block) => block.id === "math")).toMatchObject({
      rows: [{ latex: "x^2" }, { latex: "z^2" }],
    });
    expect(after.blocks.find((block) => block.id === "image")).toMatchObject({
      props: { source: { kind: "url", url: "/new.png" }, caption: "Caption" },
    });
    expect(after.blocks.find((block) => block.id === "canvas")).toMatchObject({
      scene: { nodes: [{ x: 44, label: "Moved" }] },
    });
    const inserted = after.blocks.at(-1);
    expect(inserted).toMatchObject({
      type: "paragraph",
      content: [
        { type: "text", text: "New ", marks: ["bold"] },
        { type: "math", latex: "a+b" },
        { type: "pageRef", pageId: "page-2", fallbackTitle: "Other" },
      ],
    });
  });

  it("preserves existing stable table identities while resizing", async () => {
    const doc = createNmlYDoc(document());
    await applyNmlBatch({
      ...options(doc),
      batch: {
        ops: [{
          kind: "setTableRows",
          blockId: "table",
          rows: [
            [[{ type: "text", text: "A", marks: [] }], [{ type: "text", text: "B", marks: [] }]],
            [[{ type: "text", text: "C", marks: [] }], [{ type: "text", text: "D", marks: [] }]],
          ],
        }],
      },
    });
    const table = decodeNmlDocument(doc).blocks.find((block) => block.id === "table");
    expect(table).toMatchObject({
      type: "table",
      columns: [{ id: "column-1" }, { id: expect.stringMatching(/^minted-/) }],
      rows: [
        { id: "row-1", cells: [{ id: "cell-1" }, { id: expect.stringMatching(/^minted-/) }] },
        { id: expect.stringMatching(/^minted-/), cells: [{ id: expect.stringMatching(/^minted-/) }, { id: expect.stringMatching(/^minted-/) }] },
      ],
    });
  });

  it("carries opaque Notion import stubs through the operation vocabulary", async () => {
    const doc = createNmlYDoc(document());
    await applyNmlBatch({
      ...options(doc),
      batch: {
        ops: [{
          kind: "insertBlocks",
          at: { at: "docEnd" },
          blocks: [{
            tempId: "$stub",
            type: "notionStub",
            props: {
              notionType: "database",
              notionId: "notion-db",
              href: "https://notion.so/notion-db",
              raw: "opaque",
            },
          }],
        }],
      },
    });
    expect(decodeNmlDocument(doc).blocks.at(-1)).toMatchObject({
      type: "notionStub",
      props: {
        notionType: "database",
        notionId: "notion-db",
        href: "https://notion.so/notion-db",
        raw: "opaque",
      },
    });
  });
});

describe("canonical NML CanvasHost", () => {
  it("runs an unchanged canvas planner against the served scene", async () => {
    const doc = createNmlYDoc(document());
    let sequence = 0;
    const host = createNmlCanvasHost({
      resolveDocument: () => ({ pageId: "page-1", doc }),
      actor: { kind: "model", userId: "owner" },
      authorize: () => true,
      createRequestId: () => `canvas-request-${++sequence}`,
      prepareParse: async () => {},
      parseHtml,
    });

    const result = await runCanvasTool(
      "move",
      { pageId: "page-1", blockId: "canvas", ids: ["shape"], dx: 25, dy: -5 },
      host,
    );
    expect(String(result)).toContain("moved 1 shape");
    const canvas = decodeNmlDocument(doc).blocks.find((block) => block.id === "canvas");
    expect(canvas).toMatchObject({ scene: { nodes: [{ id: "shape", x: 35, y: 15 }] } });
  });
});
