import type { BlockNoteEditor, PartialBlock } from "@blocknote/core";
import {
  serializeCanvas,
  parseCanvas,
  type ShapeNode,
  type CanvasEdge,
  type ShapeKind,
} from "@/app/components/editor/canvas/types";
import type {
  Batch,
  InlineRun,
  Mark,
  NewBlock,
  Position,
} from "@/convex/ai/operations";

/**
 * The applier: turns a validated op batch into the EXACT same BlockNote editor
 * calls a human action would make (`insertBlocks`/`updateBlock`/`removeBlocks`),
 * with canvas/math ops handled as a read-modify-write of the block's props. This
 * is the concrete meaning of "the AI edits through the same operations a human
 * uses".
 *
 * The applier — not the caller — mints every new id: blocks get their real ids
 * from `insertBlocks`' return value, shapes/edges from a uuid. `tempId`s in the
 * batch are resolved to those real ids as we go, so later ops can reference
 * nodes created earlier in the same batch.
 *
 * Assumes the batch already passed `resolveBatch` (references are valid). Take a
 * checkpoint before calling this if you need to undo a partially-applied batch.
 */

// The op layer is dynamic by design; bridge to BlockNote's schema-generic editor
// with a loosely-typed handle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPartialBlock = PartialBlock<any, any, any>;

type BNInline =
  | { type: "text"; text: string; styles: Partial<Record<Mark, boolean>> }
  | { type: "math"; props: { latex: string } };

const DEFAULT_SIZE: Record<ShapeKind, { width: number; height: number }> = {
  rectangle: { width: 148, height: 64 },
  ellipse: { width: 140, height: 96 },
  diamond: { width: 128, height: 96 },
  text: { width: 120, height: 40 },
};

const uuid = () => crypto.randomUUID();

function compileInline(runs: InlineRun[]): BNInline[] {
  return runs.map((r) =>
    r.type === "text"
      ? {
          type: "text" as const,
          text: r.text,
          styles: Object.fromEntries((r.marks ?? []).map((m) => [m, true])),
        }
      : { type: "math" as const, props: { latex: r.latex } },
  );
}

export type ApplyResult = {
  blocks: Record<string, string>;
  shapes: Record<string, string>;
  edges: Record<string, string>;
};

export function applyBatch(editor: Editor, batch: Batch): ApplyResult {
  const blockIds = new Map<string, string>();
  const shapeIds = new Map<string, string>();
  const edgeIds = new Map<string, string>();

  const rBlock = (id: string) => blockIds.get(id) ?? id;
  const rShape = (id: string) => shapeIds.get(id) ?? id;

  const firstId = () => editor.document[0].id as string;
  const lastId = () => {
    const d = editor.document;
    return d[d.length - 1].id as string;
  };

  const resolvePosition = (
    pos: Position,
  ): { ref: string; placement: "before" | "after" } => {
    switch (pos.at) {
      case "after":
        return { ref: rBlock(pos.ref), placement: "after" };
      case "before":
        return { ref: rBlock(pos.ref), placement: "before" };
      case "docStart":
        return { ref: firstId(), placement: "before" };
      case "docEnd":
        return { ref: lastId(), placement: "after" };
    }
  };

  const readCanvas = (realBlockId: string) => {
    const block = editor.getBlock(realBlockId);
    const data = String(
      (block?.props as { data?: string } | undefined)?.data ?? "",
    );
    return parseCanvas(data);
  };
  const writeCanvas = (
    realBlockId: string,
    nodes: ShapeNode[],
    edges: CanvasEdge[],
  ) => {
    editor.updateBlock(realBlockId, {
      props: { data: serializeCanvas(nodes, edges) },
    } as AnyPartialBlock);
  };

  for (const op of batch.ops) {
    switch (op.kind) {
      case "insertBlocks": {
        const { ref, placement } = resolvePosition(op.at);
        // BlockNote's PartialBlock takes `children` directly, so nesting round-
        // trips natively. Only top-level tempIds get resolved to real ids.
        const toPartial = (nb: NewBlock): AnyPartialBlock => ({
          type: nb.type,
          ...(nb.props ? { props: nb.props } : {}),
          ...(nb.content ? { content: compileInline(nb.content) } : {}),
          ...(nb.children?.length
            ? { children: nb.children.map(toPartial) }
            : {}),
        });
        const partials: AnyPartialBlock[] = op.blocks.map(toPartial);
        const inserted = editor.insertBlocks(partials, ref, placement);
        op.blocks.forEach((nb, i) => {
          const real = inserted[i]?.id;
          if (real) blockIds.set(nb.tempId, real);
        });
        break;
      }
      case "updateBlockProps":
        editor.updateBlock(rBlock(op.blockId), {
          props: op.props,
        } as AnyPartialBlock);
        break;
      case "setBlockContent":
        editor.updateBlock(rBlock(op.blockId), {
          content: compileInline(op.content),
        } as AnyPartialBlock);
        break;
      case "moveBlock": {
        const real = rBlock(op.blockId);
        const { ref, placement } = resolvePosition(op.to);
        if (ref === real) break;
        const block = editor.getBlock(real);
        if (!block) break;
        editor.removeBlocks([real]);
        editor.insertBlocks([block as AnyPartialBlock], ref, placement);
        break;
      }
      case "removeBlock":
        editor.removeBlocks([rBlock(op.blockId)]);
        break;
      case "setMathRows":
        editor.updateBlock(rBlock(op.blockId), {
          props: { source: op.rows.join("\n") },
        } as AnyPartialBlock);
        break;
      case "updateMathRow": {
        const real = rBlock(op.blockId);
        const block = editor.getBlock(real);
        const source = String(
          (block?.props as { source?: string } | undefined)?.source ?? "",
        );
        const rows = source.length ? source.split("\n") : [""];
        if (op.rowIndex < rows.length) {
          rows[op.rowIndex] = op.latex;
          editor.updateBlock(real, {
            props: { source: rows.join("\n") },
          } as AnyPartialBlock);
        }
        break;
      }
      case "addShape": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        const id = uuid();
        shapeIds.set(op.tempId, id);
        const size = DEFAULT_SIZE[op.shape];
        const node: ShapeNode = {
          id,
          type: "shape",
          position: op.position,
          width: op.width ?? size.width,
          height: op.height ?? size.height,
          data: { label: op.label ?? "", shape: op.shape },
        };
        writeCanvas(real, [...nodes, node], edges);
        break;
      }
      case "updateShape": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        const sid = rShape(op.shapeId);
        const next = nodes.map((n) => {
          if (n.id !== sid) return n;
          const p = op.patch;
          return {
            ...n,
            ...(p.position ? { position: p.position } : {}),
            ...(p.width !== undefined ? { width: p.width } : {}),
            ...(p.height !== undefined ? { height: p.height } : {}),
            data: {
              ...n.data,
              ...(p.label !== undefined ? { label: p.label } : {}),
            },
          };
        });
        writeCanvas(real, next, edges);
        break;
      }
      case "removeShape": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        const sid = rShape(op.shapeId);
        writeCanvas(
          real,
          nodes.filter((n) => n.id !== sid),
          edges.filter((e) => e.source !== sid && e.target !== sid),
        );
        break;
      }
      case "connectEdge": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        const id = uuid();
        edgeIds.set(op.tempId, id);
        const src = rShape("shapeId" in op.source ? op.source.shapeId : op.source.tempId);
        const tgt = rShape("shapeId" in op.target ? op.target.shapeId : op.target.tempId);
        const edge: CanvasEdge = {
          id,
          source: src,
          target: tgt,
          sourceHandle: op.sourceHandle ?? null,
          targetHandle: op.targetHandle ?? null,
          ...(op.label ? { label: op.label } : {}),
        };
        writeCanvas(real, nodes, [...edges, edge]);
        break;
      }
      case "disconnectEdge": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        writeCanvas(
          real,
          nodes,
          edges.filter((e) => e.id !== op.edgeId),
        );
        break;
      }
      case "setEdgeLabel": {
        const real = rBlock(op.blockId);
        const { nodes, edges } = readCanvas(real);
        const next = edges.map((e) =>
          e.id === op.edgeId ? { ...e, label: op.label } : e,
        );
        writeCanvas(real, nodes, next);
        break;
      }
    }
  }

  return {
    blocks: Object.fromEntries(blockIds),
    shapes: Object.fromEntries(shapeIds),
    edges: Object.fromEntries(edgeIds),
  };
}
