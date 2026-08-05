import { z } from "zod";

/**
 * The operation vocabulary — the single source of truth for "what can change".
 *
 * Both the human UI and (later) the LLM emit these typed operations against the
 * document surface; the applier maps them to the exact same BlockNote editor
 * calls a human action would make. This module is PURE (no React, no Convex
 * server imports) so it can run on the client (validate + apply) and on the
 * server (shape-validate before writing to the op log).
 *
 * Addressing rules:
 *  - Everything is addressed by STABLE id, never by ordinal index (indices break
 *    the moment a concurrent human edit lands).
 *  - New nodes are never given ids by the caller: the op carries a `tempId` the
 *    applier resolves to a freshly-minted id. Later ops in the same batch may
 *    reference that `tempId`. This removes an entire class of hallucinated-id
 *    bugs.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/**
 * Block types the vocabulary can create/address.
 *
 * This must cover everything the editor can produce. Anything the slash menu
 * offers but this list omits is invisible to the AI: the serializer has no tag
 * for it, so it reaches the model as an empty paragraph — which reads as a gap
 * to fill rather than as content to leave alone.
 */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
  "codeBlock",
  "mathBlock",
  "canvas",
  "table",
  "divider",
  "image",
  "video",
  "audio",
  "file",
] as const;
export const blockType = z.enum(BLOCK_TYPES);
export type BlockType = z.infer<typeof blockType>;

/** Shapes a canvas block can hold (mirrors app/components/editor/canvas/types.ts). */
export const SHAPE_KINDS = ["rectangle", "ellipse", "diamond", "text"] as const;
export const shapeKind = z.enum(SHAPE_KINDS);
export type ShapeKind = z.infer<typeof shapeKind>;

export const MARKS = ["bold", "italic", "underline", "strike", "code"] as const;
export const mark = z.enum(MARKS);
export type Mark = z.infer<typeof mark>;

export const vec2 = z.object({ x: z.number(), y: z.number() });
export type Vec2 = z.infer<typeof vec2>;

/**
 * A run of inline content. The model never emits raw ProseMirror JSON — only
 * these typed runs, which the applier compiles into BlockNote inline content.
 *
 * A link is a run of its own, not a mark: it carries a destination rather than a
 * style, and every mark is a boolean. Without it the write half would be
 * strictly smaller than the read half — the serializer shows the model an
 * `<a href>` it could not say back, so rewriting any sentence holding a link
 * would flatten it to plain text.
 */
const textRun = z.object({
  type: z.literal("text"),
  text: z.string(),
  marks: z.array(mark).optional(),
});

export const inlineRun = z.discriminatedUnion("type", [
  textRun,
  z.object({ type: z.literal("math"), latex: z.string() }),
  // Text only, because that is all the editor's link can hold.
  z.object({
    type: z.literal("link"),
    href: z.string(),
    content: z.array(textRun),
  }),
  // A mention of another page — the editor's "@Page" chip. The title is the
  // fallback text; the chip renders the live title where one is available.
  z.object({
    type: z.literal("pageRef"),
    pageId: z.string(),
    title: z.string(),
  }),
]);
export type InlineRun = z.infer<typeof inlineRun>;

/** Block-level prop values are simple scalars (language, code, heading level…). */
export const blockProps = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean()]),
);
export type BlockProps = z.infer<typeof blockProps>;

/**
 * Where to place inserted / moved blocks. Reference-relative and stable.
 * (Nested insertion — firstChild/lastChild — is intentionally deferred.)
 */
export const position = z.discriminatedUnion("at", [
  z.object({ at: z.literal("after"), ref: z.string() }),
  z.object({ at: z.literal("before"), ref: z.string() }),
  z.object({ at: z.literal("docStart") }),
  z.object({ at: z.literal("docEnd") }),
]);
export type Position = z.infer<typeof position>;

/**
 * A block to be created; `tempId` is resolved to a real id by the applier.
 * `children` carries nesting (an indented list item), so an outline can be
 * inserted in one op rather than being flattened.
 */
export interface NewBlock {
  tempId: string;
  type: BlockType;
  props?: BlockProps;
  content?: InlineRun[];
  /**
   * Table cells, when `type` is "table": rows of cells, each cell its own run
   * list. Kept separate from `content` because a table is two-dimensional and
   * `content` is a flat run list everywhere else.
   */
  rows?: InlineRun[][][];
  /**
   * Leading rows of a table that are headers. Lives here rather than in `props`
   * because BlockNote holds it in the table's *content*, not its props.
   */
  headerRows?: number;
  children?: NewBlock[];
}

export const newBlock: z.ZodType<NewBlock> = z.lazy(() =>
  z.object({
    tempId: z.string(),
    type: blockType,
    props: blockProps.optional(),
    content: z.array(inlineRun).optional(),
    rows: z.array(z.array(z.array(inlineRun))).optional(),
    headerRows: z.number().int().min(0).optional(),
    children: z.array(newBlock).optional(),
  }),
);

/** Reference to a shape: an existing id, or a `tempId` minted earlier in the batch. */
export const shapeRef = z.union([
  z.object({ shapeId: z.string() }),
  z.object({ tempId: z.string() }),
]);
export type ShapeRef = z.infer<typeof shapeRef>;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const insertBlocks = z.object({
  kind: z.literal("insertBlocks"),
  at: position,
  blocks: z.array(newBlock).min(1),
});

const updateBlockProps = z.object({
  kind: z.literal("updateBlockProps"),
  blockId: z.string(),
  props: blockProps,
});

const setBlockContent = z.object({
  kind: z.literal("setBlockContent"),
  blockId: z.string(),
  content: z.array(inlineRun),
});

/**
 * Every cell of a table at once. Its own op because `content` is a flat run list
 * everywhere else: without it an existing table could only be rewritten by
 * replacing it, which loses the id the rewrite addressed it by.
 */
const setTableRows = z.object({
  kind: z.literal("setTableRows"),
  blockId: z.string(),
  rows: z.array(z.array(z.array(inlineRun))),
  headerRows: z.number().int().min(0).optional(),
});

const moveBlock = z.object({
  kind: z.literal("moveBlock"),
  blockId: z.string(),
  to: position,
});

const removeBlock = z.object({
  kind: z.literal("removeBlock"),
  blockId: z.string(),
});

const setMathRows = z.object({
  kind: z.literal("setMathRows"),
  blockId: z.string(),
  rows: z.array(z.string()),
});

const updateMathRow = z.object({
  kind: z.literal("updateMathRow"),
  blockId: z.string(),
  rowIndex: z.number().int().nonnegative(),
  latex: z.string(),
});

const addShape = z.object({
  kind: z.literal("addShape"),
  blockId: z.string(),
  tempId: z.string(),
  shape: shapeKind,
  position: vec2,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  label: z.string().optional(),
});

const updateShape = z.object({
  kind: z.literal("updateShape"),
  blockId: z.string(),
  shapeId: z.string(),
  patch: z
    .object({
      position: vec2.optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      label: z.string().optional(),
    })
    .refine((p) => Object.keys(p).length > 0, "patch must change something"),
});

const removeShape = z.object({
  kind: z.literal("removeShape"),
  blockId: z.string(),
  shapeId: z.string(),
});

const connectEdge = z.object({
  kind: z.literal("connectEdge"),
  blockId: z.string(),
  tempId: z.string(),
  source: shapeRef,
  target: shapeRef,
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
  label: z.string().optional(),
});

const disconnectEdge = z.object({
  kind: z.literal("disconnectEdge"),
  blockId: z.string(),
  edgeId: z.string(),
});

const setEdgeLabel = z.object({
  kind: z.literal("setEdgeLabel"),
  blockId: z.string(),
  edgeId: z.string(),
  label: z.string(),
});

export const operation = z.discriminatedUnion("kind", [
  insertBlocks,
  updateBlockProps,
  setBlockContent,
  setTableRows,
  moveBlock,
  removeBlock,
  setMathRows,
  updateMathRow,
  addShape,
  updateShape,
  removeShape,
  connectEdge,
  disconnectEdge,
  setEdgeLabel,
]);
export type Operation = z.infer<typeof operation>;
export type OpKind = Operation["kind"];

/**
 * An atomic unit of change. Ops are validated and applied all-or-nothing.
 * `pageId` scopes the op log; `chatPromptId` ties a batch to an AI turn (and to
 * the checkpoint taken just before it).
 */
export const batch = z.object({
  pageId: z.string().optional(),
  chatPromptId: z.string().optional(),
  ops: z.array(operation).min(1),
});
export type Batch = z.infer<typeof batch>;

/** Shape-validate an unknown payload as a Batch (used server-side on write). */
export function parseBatch(input: unknown) {
  return batch.safeParse(input);
}
