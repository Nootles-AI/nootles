import { parseAlbum } from "@/app/components/editor/album/parse";
import { describeSource } from "@/app/components/editor/media/link";
import { parseLocation } from "@/app/components/editor/location/parse";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { labelText } from "@/app/components/editor/canvas/scene/label";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { isGroup, type SceneNode } from "@/app/components/editor/canvas/scene/types";

/**
 * Projection: a deterministic, id-tagged serialization of the document that an
 * LLM can both READ and ADDRESS. It runs over BlockNote's block JSON
 * (`editor.document`) — the same denormalized tree the applier writes back to —
 * so projection and apply share one mental model, and neither needs a
 * server-side ProseMirror schema.
 *
 * Every element is tagged with its stable id as `⟦id⟧`, so the model can say
 * "update ⟦x⟧" and the op targets exactly that node. The same pass builds a
 * reverse `DocIndex` that the validate/resolve gate uses to reject references to
 * ids that don't exist.
 */

// Structural view of a BlockNote block (kept loose so this module stays pure and
// decoupled from the schema-specific generic Block type).
export type AnyBlock = {
  id: string;
  type: string;
  props: Record<string, unknown>;
  content?: unknown;
  children?: AnyBlock[];
};

type InlineItem =
  | { type: "text"; text: string; styles?: Record<string, unknown> }
  | { type: "link"; href?: string; content?: InlineItem[] }
  | { type: string; props?: Record<string, unknown> };

export type FlatBlock = { id: string; type: string; text: string };

/** Plain text of a run list, links included — their words are the block's words. */
function runsText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .map((i) => {
      if (i.type === 'text') return String(i.text ?? '');
      if (i.type === 'math') {
        return String((i.props as { latex?: string } | undefined)?.latex ?? '');
      }
      if (i.type === 'pageMention') {
        return String((i.props as { title?: string } | undefined)?.title ?? '');
      }
      if (i.type === 'link') return runsText(i.content);
      return '';
    })
    .join('');
}

/** Plain text of a block, whatever kind it is. */
export function blockText(block: AnyBlock): string {
  if (block.type === 'codeBlock') return String(block.props?.code ?? '');
  if (block.type === 'mathBlock') return String(block.props?.source ?? '');
  return runsText(block.content);
}

/** Document-order flat view of the block tree. */
export function flattenBlocks(blocks: AnyBlock[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  const walk = (bs: AnyBlock[]) => {
    for (const b of bs) {
      out.push({ id: b.id, type: b.type, text: blockText(b) });
      if (b.children?.length) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

export type BlockIndexEntry = {
  type: string;
  /** Whether the block holds inline content (rejects setBlockContent otherwise). */
  hasContent: boolean;
  parentId?: string;
};

export type DocIndex = {
  blocks: Map<string, BlockIndexEntry>;
  /** shapeId → its canvas block. */
  shapes: Map<string, { canvasBlockId: string }>;
  /** edgeId → its canvas block. */
  edges: Map<string, { canvasBlockId: string }>;
  /** mathBlock id → number of rows (bounds-checks updateMathRow). */
  mathRows: Map<string, number>;
};

function emptyIndex(): DocIndex {
  return {
    blocks: new Map(),
    shapes: new Map(),
    edges: new Map(),
    mathRows: new Map(),
  };
}

/** Render inline content to markdown-ish text (marks preserved, math as $…$). */
function inlineToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as InlineItem[])
    .map((item) => {
      if (item.type === "text") {
        const t = item as { text: string; styles?: Record<string, unknown> };
        return applyMarks(t.text, t.styles);
      }
      if (item.type === "link") {
        const l = item as { content?: InlineItem[] };
        return inlineToText(l.content);
      }
      if (item.type === "math") {
        const latex = (item as { props?: { latex?: string } }).props?.latex ?? "";
        return `$${latex}$`;
      }
      if (item.type === "pageMention") {
        const title = (item as { props?: { title?: string } }).props?.title ?? "";
        return `@${title}`;
      }
      return "";
    })
    .join("");
}

/** Plain text with no marks — for shape labels and other attribute-like text. */
function inlinePlain(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as InlineItem[])
    .map((item) =>
      item.type === "text" ? (item as { text: string }).text : "",
    )
    .join("");
}

function applyMarks(text: string, styles?: Record<string, unknown>): string {
  if (!styles) return text;
  let out = text;
  if (styles.code) out = `\`${out}\``;
  if (styles.bold) out = `**${out}**`;
  if (styles.italic) out = `*${out}*`;
  if (styles.strike) out = `~~${out}~~`;
  if (styles.underline) out = `<u>${out}</u>`;
  return out;
}

function tag(id: string): string {
  return `⟦${id}⟧`;
}

/**
 * A diagram, one shape per line, nested as the scene nests. Read through the
 * canvas grammar's own parser, so every shape is indexed and id validation
 * still covers the whole document even when the prompt is windowed.
 */
function projectCanvas(
  block: AnyBlock,
  index: DocIndex,
  lines: string[],
  emit: boolean,
) {
  const scene = migrateLegacyCanvas(String(block.props.data ?? ""));
  if (emit) lines.push(`canvas ${tag(block.id)}`);

  const project = (nodes: readonly SceneNode[], depth: number) => {
    for (const node of nodes) {
      index.shapes.set(node.id, { canvasBlockId: block.id });
      if (emit) {
        const label = labelText(node.label).replace(/\n/g, " ");
        const box = `@(${Math.round(node.x)},${Math.round(node.y)}) ${Math.round(node.w)}x${Math.round(node.h)}`;
        lines.push(`${"  ".repeat(depth)}${tag(node.id)} ${node.kind} "${label}" ${box}`);
      }
      if (isGroup(node)) project(node.children, depth + 1);
    }
  };
  project(scene.nodes, 1);
}

type EmitCtx = {
  /** Ids whose TEXT should be emitted; null means emit everything. */
  emit: Set<string> | null;
  cursorBlockId?: string;
  recentIds?: Set<string>;
};

function projectBlock(
  block: AnyBlock,
  index: DocIndex,
  lines: string[],
  parentId: string | undefined,
  ctx: EmitCtx,
) {
  const hasContent = Array.isArray(block.content);
  index.blocks.set(block.id, { type: block.type, hasContent, parentId });

  // Blocks outside the window are still indexed (so id validation covers the
  // whole document) but contribute no text to the prompt.
  const doEmit = !ctx.emit || ctx.emit.has(block.id);
  const startLine = lines.length;
  const push = (s: string) => {
    if (doEmit) lines.push(s);
  };

  const id = tag(block.id);
  switch (block.type) {
    case "heading": {
      const level = Number(block.props.level ?? 1);
      push(`${id} ${"#".repeat(level)} ${inlineToText(block.content)}`);
      break;
    }
    case "bulletListItem":
      push(`${id} - ${inlineToText(block.content)}`);
      break;
    case "numberedListItem":
      push(`${id} 1. ${inlineToText(block.content)}`);
      break;
    case "checkListItem": {
      const box = block.props.checked ? "[x]" : "[ ]";
      push(`${id} - ${box} ${inlineToText(block.content)}`);
      break;
    }
    case "quote":
      push(`${id} > ${inlineToText(block.content)}`);
      break;
    case "codeBlock": {
      const lang = String(block.props.language ?? "");
      const code = String(block.props.code ?? "");
      push(`${id} \`\`\`${lang}`);
      for (const l of code.split("\n")) push(`  ${l}`);
      push("  ```");
      break;
    }
    case "mathBlock": {
      const source = String(block.props.source ?? "");
      const rows = source.length ? source.split("\n") : [""];
      index.mathRows.set(block.id, rows.length);
      push(`${id} math`);
      rows.forEach((r, i) => push(`  [${i}] ${r}`));
      break;
    }
    case "canvas":
      projectCanvas(block, index, lines, doEmit);
      break;
    case "album": {
      // Counted rather than listed. A picture's line would be its storage URL,
      // which tells the model nothing it can act on and costs it a line each;
      // what it needs to know is that this block is pictures, and how many.
      const { items, cols } = parseAlbum(String(block.props.data ?? ""));
      const photos = items.filter((i) => i.kind === "image").length;
      const videos = items.length - photos;
      const parts = [
        ...(photos ? [`${photos} photo${photos === 1 ? "" : "s"}`] : []),
        ...(videos ? [`${videos} video${videos === 1 ? "" : "s"}`] : []),
        ...(cols ? [`${cols} columns`] : []),
      ];
      push(`${id} album (${parts.join(", ") || "empty"})`);
      break;
    }
    case "storyboard": {
      // Shot by shot, because that is the unit the model works in — what each
      // one says, and whether anything has been drawn in it yet. The drawings
      // themselves are not listed: a board is six diagrams, and spelling them
      // all out would cost more of the window than the whole rest of the page.
      const board = parseStoryboard(String(block.props.data ?? ""));
      push(`${id} storyboard ${board.ratio}, ${board.shots.length} shots`);
      board.shots.forEach((shot, i) => {
        const drawn = shot.scene ? "drawn" : "empty";
        const note = shot.note.replace(/\n/g, " / ");
        push(`  shot ${i + 1} (${drawn}) ${note ? `"${note}"` : "no note"}`);
      });
      break;
    }
    case "location": {
      // The place, and what the card is actually showing of it — the pictures
      // are counted rather than listed, because their URLs say nothing the
      // model can act on.
      const place = parseLocation(String(block.props.data ?? ""));
      const shown = place.images.filter((image) => !image.off).length;
      const parts = [
        place.address,
        place.rating !== undefined ? `${place.rating}★` : "",
        shown ? `${shown} photo${shown === 1 ? "" : "s"}` : "",
      ].filter(Boolean);
      push(`${id} location ${place.name || "(unnamed)"}${parts.length ? ` — ${parts.join(", ")}` : ""}`);
      break;
    }
    case "audio":
    case "video": {
      // One line: where it plays from, and what it is if the block knows.
      const url = String(block.props.url ?? "");
      const title =
        String(block.props.caption ?? "").trim() ||
        String(block.props.name ?? "").trim();
      const from = url ? (describeSource(url) ?? "link") : "empty";
      push(`${id} ${block.type} (${from})${title ? ` ${title}` : ""}`);
      break;
    }
    default:
      // paragraph and any other text block.
      push(`${id} ${inlineToText(block.content)}`);
  }

  // Anchor the model's attention: say plainly where the caret is, and which
  // blocks the user has touched this session.
  if (doEmit && lines.length > startLine) {
    const mark =
      block.id === ctx.cursorBlockId
        ? "   ◀ CURSOR IS HERE"
        : ctx.recentIds?.has(block.id)
          ? "   (just edited)"
          : "";
    if (mark) lines[startLine] += mark;
  }

  for (const child of block.children ?? []) {
    projectBlock(child, index, lines, block.id, ctx);
  }
}

function collectIds(block: AnyBlock, out: Set<string>) {
  out.add(block.id);
  for (const c of block.children ?? []) collectIds(c, out);
}

export type ProjectOptions = {
  cursorBlockId?: string;
  /** Top-level blocks to include either side of the cursor. Omit for the whole doc. */
  window?: number;
  /** Blocks edited this session, marked so the model prefers fresh content. */
  recentIds?: Set<string>;
};

/**
 * `text` is what the model reads; `index` always covers the WHOLE document so
 * `resolveBatch` can validate any id the model returns even when the prompt was
 * windowed.
 */
export function project(
  blocks: AnyBlock[],
  opts: ProjectOptions = {},
): { text: string; index: DocIndex } {
  const index = emptyIndex();
  const lines: string[] = [];

  let emit: Set<string> | null = null;
  let elidedBefore = false;
  let elidedAfter = false;
  if (opts.cursorBlockId && opts.window !== undefined) {
    const center = blocks.findIndex((b) => {
      const ids = new Set<string>();
      collectIds(b, ids);
      return ids.has(opts.cursorBlockId!);
    });
    if (center !== -1) {
      const lo = Math.max(0, center - opts.window);
      const hi = Math.min(blocks.length - 1, center + opts.window);
      elidedBefore = lo > 0;
      elidedAfter = hi < blocks.length - 1;
      emit = new Set<string>();
      for (let i = lo; i <= hi; i++) collectIds(blocks[i], emit);
    }
  }

  const ctx: EmitCtx = {
    emit,
    cursorBlockId: opts.cursorBlockId,
    recentIds: opts.recentIds,
  };
  for (const block of blocks) projectBlock(block, index, lines, undefined, ctx);

  const text = [
    ...(elidedBefore ? ["… (earlier blocks omitted)"] : []),
    ...lines,
    ...(elidedAfter ? ["… (later blocks omitted)"] : []),
  ].join("\n");
  return { text, index };
}

export { inlinePlain };
