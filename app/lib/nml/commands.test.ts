import * as Y from "yjs";
import { describe, expect, it, vi } from "vitest";
import {
  createNmlYDoc,
  decodeNmlDocument,
  executeNmlCommands,
  type ExecuteNmlCommandsOptions,
  type NmlBlock,
  type NmlCommand,
  type NmlDocument,
} from ".";

const paragraph = (id: string, text: string): NmlBlock => ({
  id,
  type: "paragraph",
  props: {},
  content: [{ type: "text", text, marks: [] }],
  children: [],
});
const document = (): NmlDocument => ({
  schemaVersion: 1,
  documentId: "doc",
  blocks: [
    paragraph("p1", "hello"),
    {
      id: "list",
      type: "checkListItem",
      props: { checked: false },
      content: [{ type: "text", text: "list", marks: [] }],
      children: [],
    },
    {
      id: "table",
      type: "table",
      props: { headerRows: 0 },
      columns: [{ id: "c1" }],
      rows: [
        {
          id: "r1",
          cells: [
            {
              id: "cell1",
              content: [{ type: "text", text: "old", marks: [] }],
            },
          ],
        },
      ],
      children: [],
    },
    {
      id: "code",
      type: "codeBlock",
      props: { language: "ts" },
      code: "abc",
      children: [],
    },
    {
      id: "math",
      type: "mathBlock",
      props: {},
      rows: [{ id: "mr1", latex: "x" }],
      children: [],
    },
    {
      id: "album",
      type: "album",
      props: {},
      domain: { id: "album", items: [] },
      children: [],
    },
    {
      id: "canvas",
      type: "canvas",
      props: {},
      scene: {
        id: "canvas",
        w: 100,
        h: 100,
        style: {},
        attrs: {},
        nodes: [shape("s1", 0)],
        edges: [],
      },
      children: [],
    },
  ],
});
function shape(
  id: string,
  x: number,
): Extract<
  import("@/app/components/editor/canvas/scene/types").SceneNode,
  { kind: "rect" }
> {
  return {
    id,
    kind: "rect",
    x,
    y: 0,
    w: 10,
    h: 10,
    rot: 0,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  };
}
const origin = (transactionId = "tx") => ({
  version: 1 as const,
  transactionId,
  actor: { userId: "u", kind: "human" as const },
  command: "test",
});
function options(
  doc: Y.Doc,
  commands: NmlCommand[],
  extra: Partial<ExecuteNmlCommandsOptions> = {},
): ExecuteNmlCommandsOptions {
  return {
    doc,
    documentId: "doc",
    commands,
    origin: origin(),
    idempotencyKey: "key",
    authorize: () => true,
    ...extra,
  };
}
function block(doc: Y.Doc, id: string): NmlBlock {
  const stack = [...decodeNmlDocument(doc).blocks];
  while (stack.length) {
    const item = stack.shift()!;
    if (item.id === id) return item;
    stack.push(...item.children);
  }
  throw Error(id);
}

describe("NML semantic command executor", () => {
  it("authorizes before reading and rejects without mutation", async () => {
    const empty = new Y.Doc();
    const authorize = vi.fn(() => false);
    await expect(
      executeNmlCommands(options(empty, [], { authorize })),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(authorize).toHaveBeenCalledOnce();
    expect(empty.share.size).toBe(0);
  });

  it("applies structural, property, inline, split, and join commands atomically", async () => {
    const doc = createNmlYDoc(document());
    await executeNmlCommands(
      options(doc, [
        { type: "setNodeProps", nodeId: "list", patch: { checked: true } },
        {
          type: "replaceInline",
          nodeId: "p1",
          range: { from: 0, to: 5 },
          content: [{ type: "text", text: "hello world", marks: [] }],
        },
        {
          type: "setInlineMarks",
          nodeId: "p1",
          range: { from: 6, to: 11 },
          marks: ["bold"],
        },
        { type: "splitTextBlock", nodeId: "p1", offset: 5, newNodeId: "p2" },
        { type: "joinTextBlocks", leftId: "p1", rightId: "p2" },
        {
          type: "insertNodes",
          parentId: "list",
          nodes: [paragraph("child", "nested")],
        },
        {
          type: "moveNodes",
          nodeIds: ["child"],
          destination: { parentId: null, anchor: { afterId: "list" } },
        },
      ]),
    );
    expect(
      (block(doc, "list") as NmlBlock & { props: { checked: boolean } }).props
        .checked,
    ).toBe(true);
    expect(
      (block(doc, "p1") as NmlBlock & { content: unknown }).content,
    ).toEqual([
      { type: "text", text: "hello ", marks: [] },
      { type: "text", text: "world", marks: ["bold"] },
    ]);
    expect(decodeNmlDocument(doc).blocks.map((item) => item.id)).toContain(
      "child",
    );
  });

  it("covers tables, code, math, custom domains, shapes, and edges", async () => {
    const doc = createNmlYDoc(document());
    await executeNmlCommands(
      options(doc, [
        {
          type: "replaceTableRange",
          tableId: "table",
          rowIds: ["r1"],
          columnIds: ["c1"],
          cells: [
            [
              {
                id: "cell1",
                content: [{ type: "text", text: "new", marks: [] }],
              },
            ],
          ],
        },
        {
          type: "setCode",
          nodeId: "code",
          range: { from: 1, to: 2 },
          text: "XYZ",
        },
        { type: "setMathRow", nodeId: "math", rowId: "mr1", latex: "x^2" },
        {
          type: "replaceDomain",
          nodeId: "album",
          domain: {
            id: "album",
            items: [{ kind: "image", src: "/a.png", w: 1, h: 1 }],
          },
        },
        { type: "insertShapes", canvasId: "canvas", shapes: [shape("s2", 20)] },
        {
          type: "updateShapes",
          canvasId: "canvas",
          patches: [{ id: "s2", patch: { x: 25, label: "two" } }],
        },
        {
          type: "moveShapes",
          canvasId: "canvas",
          placements: [
            { id: "s2", parentId: null, anchor: { beforeId: "s1" } },
          ],
        },
        {
          type: "insertEdges",
          canvasId: "canvas",
          edges: [
            {
              id: "e1",
              from: "s1",
              to: "s2",
              label: "edge",
              style: {},
              attrs: {},
            },
          ],
        },
        {
          type: "updateEdges",
          canvasId: "canvas",
          patches: [{ id: "e1", patch: { label: "updated" } }],
        },
      ]),
    );
    expect(
      (block(doc, "table") as Extract<NmlBlock, { type: "table" }>).rows[0]
        .cells[0].content[0],
    ).toMatchObject({ text: "new" });
    expect(
      (block(doc, "code") as Extract<NmlBlock, { type: "codeBlock" }>).code,
    ).toBe("aXYZc");
    expect(
      (block(doc, "math") as Extract<NmlBlock, { type: "mathBlock" }>).rows[0]
        .latex,
    ).toBe("x^2");
    const scene = (
      block(doc, "canvas") as Extract<NmlBlock, { type: "canvas" }>
    ).scene;
    expect(scene.nodes.map((node) => node.id)).toEqual(["s2", "s1"]);
    expect(scene.nodes[0]).toMatchObject({ x: 25, label: "two" });
    expect(scene.edges[0].label).toBe("updated");
    await executeNmlCommands(
      options(
        doc,
        [{ type: "removeShapes", canvasId: "canvas", shapeIds: ["s2"] }],
        { idempotencyKey: "remove" },
      ),
    );
    expect(
      (block(doc, "canvas") as Extract<NmlBlock, { type: "canvas" }>).scene
        .edges,
    ).toEqual([]);
  });

  it("validates the complete batch and never partially applies it", async () => {
    const doc = createNmlYDoc(document());
    const before = Y.encodeStateVector(doc);
    await expect(
      executeNmlCommands(
        options(doc, [
          {
            type: "setCode",
            nodeId: "code",
            range: { from: 0, to: 1 },
            text: "z",
          },
          {
            type: "setCode",
            nodeId: "missing",
            range: { from: 0, to: 0 },
            text: "x",
          },
        ]),
      ),
    ).rejects.toMatchObject({ code: "missing_node", commandIndex: 1 });
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(
      (block(doc, "code") as Extract<NmlBlock, { type: "codeBlock" }>).code,
    ).toBe("abc");
  });

  it("resolves temporary IDs and returns the stored receipt on replay", async () => {
    const doc = createNmlYDoc(document());
    const args = options(
      doc,
      [
        {
          type: "insertNodes",
          parentId: null,
          nodes: [paragraph("$new", "temp")],
        },
      ],
      { temporaryIds: ["$new"], createId: () => "real" },
    );
    const first = await executeNmlCommands(args),
      second = await executeNmlCommands(args);
    expect(first).toEqual(second);
    expect(first.temporaryIds).toEqual({ $new: "real" });
    expect(
      decodeNmlDocument(doc).blocks.filter((item) => item.id === "real"),
    ).toHaveLength(1);
    await expect(
      executeNmlCommands({ ...args, commands: [], idempotencyKey: "key" }),
    ).rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("preserves independent replica edits and converges", async () => {
    const a = createNmlYDoc(document()),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await executeNmlCommands(
      options(
        a,
        [
          {
            type: "setCode",
            nodeId: "code",
            range: { from: 0, to: 0 },
            text: "A",
          },
        ],
        { idempotencyKey: "a", origin: origin("a") },
      ),
    );
    await executeNmlCommands(
      options(
        b,
        [
          {
            type: "setCode",
            nodeId: "code",
            range: { from: 3, to: 3 },
            text: "B",
          },
        ],
        { idempotencyKey: "b", origin: origin("b") },
      ),
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect(
      (block(a, "code") as Extract<NmlBlock, { type: "codeBlock" }>).code,
    ).toBe("AabcB");
  });

  it("converges concurrent stable-ID table row and column insertions", async () => {
    const seed = createNmlYDoc(document());
    const replicas = () => {
      const left = new Y.Doc(); const right = new Y.Doc();
      const update = Y.encodeStateAsUpdate(seed);
      Y.applyUpdate(left, update); Y.applyUpdate(right, update);
      return { left, right };
    };
    const merge = (left: Y.Doc, right: Y.Doc) => {
      Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
      Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
      expect(decodeNmlDocument(left)).toEqual(decodeNmlDocument(right));
    };

    const columns = replicas();
    await executeNmlCommands(options(columns.left, [{
      type: "insertTableColumns",
      tableId: "table",
      anchor: { afterId: "c1" },
      columns: [{ id: "column-left", cells: [{ rowId: "r1", cell: { id: "cell-left", content: [] } }] }],
    }], { idempotencyKey: "column-left", origin: origin("column-left") }));
    await executeNmlCommands(options(columns.right, [{
      type: "insertTableColumns",
      tableId: "table",
      anchor: { afterId: "c1" },
      columns: [{ id: "column-right", cells: [{ rowId: "r1", cell: { id: "cell-right", content: [] } }] }],
    }], { idempotencyKey: "column-right", origin: origin("column-right") }));
    merge(columns.left, columns.right);
    const mergedColumns = block(columns.left, "table") as Extract<NmlBlock, { type: "table" }>;
    expect(mergedColumns.columns).toHaveLength(3);
    expect(mergedColumns.rows[0].cells).toHaveLength(3);
    expect(Object.fromEntries(mergedColumns.columns.map((column, index) => [column.id, mergedColumns.rows[0].cells[index].id]))).toEqual({
      c1: "cell1",
      "column-left": "cell-left",
      "column-right": "cell-right",
    });

    const rows = replicas();
    await executeNmlCommands(options(rows.left, [{
      type: "insertTableRows",
      tableId: "table",
      anchor: { afterId: "r1" },
      rows: [{ id: "row-left", cells: [{ id: "row-cell-left", content: [] }] }],
    }], { idempotencyKey: "row-left", origin: origin("row-left") }));
    await executeNmlCommands(options(rows.right, [{
      type: "insertTableRows",
      tableId: "table",
      anchor: { afterId: "r1" },
      rows: [{ id: "row-right", cells: [{ id: "row-cell-right", content: [] }] }],
    }], { idempotencyKey: "row-right", origin: origin("row-right") }));
    merge(rows.left, rows.right);
    expect((block(rows.left, "table") as Extract<NmlBlock, { type: "table" }>).rows.map((row) => row.id)).toEqual(expect.arrayContaining(["r1", "row-left", "row-right"]));

    const dimensions = replicas();
    await executeNmlCommands(options(dimensions.left, [{
      type: "insertTableColumns",
      tableId: "table",
      anchor: { afterId: "c1" },
      columns: [{ id: "column-cross", cells: [{ rowId: "r1", cell: { id: "cell-cross", content: [] } }] }],
    }], { idempotencyKey: "column-cross", origin: origin("column-cross") }));
    await executeNmlCommands(options(dimensions.right, [{
      type: "insertTableRows",
      tableId: "table",
      anchor: { afterId: "r1" },
      rows: [{ id: "row-cross", cells: [{ id: "row-cell-cross", content: [] }] }],
    }], { idempotencyKey: "row-cross", origin: origin("row-cross") }));
    merge(dimensions.left, dimensions.right);
    const mergedDimensions = block(dimensions.left, "table") as Extract<NmlBlock, { type: "table" }>;
    expect(mergedDimensions.columns).toHaveLength(2);
    expect(mergedDimensions.rows).toHaveLength(2);
    expect(mergedDimensions.rows.every((row) => row.cells.length === 2)).toBe(true);
    const intersection = mergedDimensions.rows.find((row) => row.id === "row-cross")!.cells[1];
    await executeNmlCommands(options(dimensions.left, [{
      type: "replaceTableRange",
      tableId: "table",
      rowIds: ["row-cross"],
      columnIds: ["column-cross"],
      cells: [[{ id: intersection.id, content: [{ type: "text", text: "materialized", marks: [] }] }]],
    }], { idempotencyKey: "materialize-cross", origin: origin("materialize-cross") }));
    merge(dimensions.left, dimensions.right);
    expect((block(dimensions.right, "table") as Extract<NmlBlock, { type: "table" }>).rows[1].cells[1].content)
      .toEqual([{ type: "text", text: "materialized", marks: [] }]);

    const removal = replicas();
    await executeNmlCommands(options(removal.left, [{
      type: "removeTableColumns", tableId: "table", columnIds: ["c1"],
    }], { idempotencyKey: "remove-column-cross", origin: origin("remove-column-cross") }));
    await executeNmlCommands(options(removal.right, [{
      type: "insertTableRows", tableId: "table", anchor: { afterId: "r1" },
      rows: [{ id: "row-after-removal", cells: [{ id: "cell-after-removal", content: [] }] }],
    }], { idempotencyKey: "row-after-removal", origin: origin("row-after-removal") }));
    merge(removal.left, removal.right);
    const removedDimension = block(removal.left, "table") as Extract<NmlBlock, { type: "table" }>;
    expect(removedDimension.columns).toEqual([]);
    expect(removedDimension.rows.every((row) => row.cells.length === 0)).toBe(true);

    columns.left.destroy(); columns.right.destroy(); rows.left.destroy(); rows.right.destroy();
    dimensions.left.destroy(); dimensions.right.destroy(); removal.left.destroy(); removal.right.destroy(); seed.destroy();
  });

  it("preserves concurrent inline insertions at character granularity", async () => {
    const a = createNmlYDoc(document()),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await executeNmlCommands(
      options(
        a,
        [
          {
            type: "replaceInline",
            nodeId: "p1",
            range: { from: 0, to: 0 },
            content: [{ type: "text", text: "A", marks: [] }],
          },
        ],
        { idempotencyKey: "inline-a", origin: origin("inline-a") },
      ),
    );
    await executeNmlCommands(
      options(
        b,
        [
          {
            type: "replaceInline",
            nodeId: "p1",
            range: { from: 5, to: 5 },
            content: [{ type: "text", text: "B", marks: [] }],
          },
        ],
        { idempotencyKey: "inline-b", origin: origin("inline-b") },
      ),
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect(
      (block(a, "p1") as NmlBlock & { content: Array<{ text: string }> })
        .content[0].text,
    ).toBe("AhelloB");
  });

  it("resolves concurrent moves to one parent and makes deletion win", async () => {
    const source = document();
    source.blocks.push(
      {
        id: "left",
        type: "toggleListItem",
        props: {},
        content: [],
        children: [],
      },
      {
        id: "right",
        type: "toggleListItem",
        props: {},
        content: [],
        children: [],
      },
      paragraph("moving", "move"),
    );
    const a = createNmlYDoc(source),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await executeNmlCommands(
      options(
        a,
        [
          {
            type: "moveNodes",
            nodeIds: ["moving"],
            destination: { parentId: "left" },
          },
        ],
        { idempotencyKey: "left", origin: origin("left") },
      ),
    );
    await executeNmlCommands(
      options(
        b,
        [
          {
            type: "moveNodes",
            nodeIds: ["moving"],
            destination: { parentId: "right" },
          },
        ],
        { idempotencyKey: "right", origin: origin("right") },
      ),
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    const positions = (doc: Y.Doc) =>
      decodeNmlDocument(doc)
        .blocks.flatMap((parent) => [parent, ...parent.children])
        .filter((item) => item.id === "moving");
    expect(positions(a)).toHaveLength(1);
    await executeNmlCommands(
      options(a, [{ type: "removeNodes", nodeIds: ["moving"] }], {
        idempotencyKey: "delete",
        origin: origin("delete"),
      }),
    );
    await executeNmlCommands(
      options(
        b,
        [
          {
            type: "moveNodes",
            nodeIds: ["moving"],
            destination: { parentId: null },
          },
        ],
        { idempotencyKey: "move-again", origin: origin("move-again") },
      ),
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(() => block(a, "moving")).toThrow();
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
  });

  it("recovers a concurrent child insertion when its parent is deleted", async () => {
    const source = document();
    source.blocks.push({
      id: "parent",
      type: "toggleListItem",
      props: {},
      content: [],
      children: [],
    });
    const a = createNmlYDoc(source),
      b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    await executeNmlCommands(
      options(a, [{ type: "removeNodes", nodeIds: ["parent"] }], {
        idempotencyKey: "delete-parent",
        origin: origin("delete-parent"),
      }),
    );
    await executeNmlCommands(
      options(
        b,
        [
          {
            type: "insertNodes",
            parentId: "parent",
            nodes: [paragraph("recovered", "safe")],
          },
        ],
        { idempotencyKey: "insert-child", origin: origin("insert-child") },
      ),
    );
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(decodeNmlDocument(a)).toEqual(decodeNmlDocument(b));
    expect(
      decodeNmlDocument(a).blocks.some((item) => item.id === "recovered"),
    ).toBe(true);
  });

  it("enforces state and grapheme preconditions", async () => {
    const doc = createNmlYDoc(document());
    const stale = Y.encodeStateVector(doc);
    await executeNmlCommands(
      options(
        doc,
        [
          {
            type: "setCode",
            nodeId: "code",
            range: { from: 0, to: 0 },
            text: "x",
          },
        ],
        { idempotencyKey: "change" },
      ),
    );
    await expect(
      executeNmlCommands(
        options(doc, [], {
          idempotencyKey: "stale",
          preconditions: { stateVector: stale },
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_state" });
    await executeNmlCommands(
      options(
        doc,
        [
          {
            type: "replaceInline",
            nodeId: "p1",
            range: { from: 0, to: 5 },
            content: [{ type: "text", text: "👨‍👩‍👧‍👦", marks: [] }],
          },
        ],
        { idempotencyKey: "emoji" },
      ),
    );
    await expect(
      executeNmlCommands(
        options(
          doc,
          [
            {
              type: "splitTextBlock",
              nodeId: "p1",
              offset: 2,
              newNodeId: "bad",
            },
          ],
          { idempotencyKey: "bad" },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_range" });
  });

  it("survives a deterministic fuzz sequence while maintaining schema invariants", async () => {
    const doc = createNmlYDoc(document());
    let seed = 41;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    for (let i = 0; i < 100; i++) {
      const code = (
        block(doc, "code") as Extract<NmlBlock, { type: "codeBlock" }>
      ).code;
      const at = Math.floor(random() * (code.length + 1));
      await executeNmlCommands(
        options(
          doc,
          [
            {
              type: "setCode",
              nodeId: "code",
              range: { from: at, to: at },
              text: String(i % 10),
            },
          ],
          { idempotencyKey: `f${i}`, origin: origin(`f${i}`) },
        ),
      );
      expect(() => decodeNmlDocument(doc)).not.toThrow();
    }
  });
});
