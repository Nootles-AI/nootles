import { adoptScene } from "@/app/components/editor/canvas/scene/adopt";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type {
  Batch,
  InlineRun,
  NewBlock,
  Operation,
  Position,
} from "@/convex/ai/operations";
import type { DocNode, Run, TextRun } from "./grammar";

/**
 * Compiles parsed document-language nodes into a Phase-2 op batch.
 *
 * The `id` attribute carries the entire insert/update distinction:
 *   - an element WITH an id that exists → update that block (only where it
 *     actually differs from the current document)
 *   - an element WITHOUT an id → insert a new block after the running anchor
 *
 * That one rule is what lets autocomplete (insert at the caret) and cascade
 * (rewrite blocks elsewhere) share a single grammar and a single code path.
 * Diffing is like-for-like: the current document is serialized and parsed into
 * the same `DocNode` shape, so comparison is structural rather than textual.
 */

const PROSE = new Set([
  "paragraph",
  "heading",
  "bulletListItem",
  "numberedListItem",
  "checkListItem",
  "toggleListItem",
  "quote",
]);

const textToInline = (r: TextRun): Extract<InlineRun, { type: "text" }> => ({
  type: "text",
  text: r.text,
  ...(r.marks?.length ? { marks: r.marks } : {}),
});

function runsToInline(runs: Run[]): InlineRun[] {
  return runs.map((r) => {
    if (r.type === "math") return { type: "math", latex: r.latex };
    if (r.type === "pageRef") {
      return { type: "pageRef", pageId: r.pageId, title: r.title };
    }
    if (r.type === "link") {
      return { type: "link", href: r.href, content: r.content.map(textToInline) };
    }
    return textToInline(r);
  });
}

function sameRuns(a: Run[], b: Run[]): boolean {
  return JSON.stringify(runsToInline(a)) === JSON.stringify(runsToInline(b));
}

const MEDIA = new Set(["image", "video", "audio", "file"]);

/**
 * A diagram as the block stores it, canonicalised through the canvas grammar's
 * own parser — so a comparison is between two diagrams rather than between two
 * ways of writing one, and so a model's markup lands normalized. The root id is
 * dropped: it is the block's, and the block already knows its own name.
 *
 * `adoptScene` runs here because this is the seam every AI-authored diagram
 * crosses, from both lanes: the chat's `edit_page` and the completion lane's
 * `compileWith` are the only two callers of `compileDocHtml`. It is also why
 * the diff below is honest — both sides are adopted, so a path the model wrote
 * with a loose box does not read as a change to a path already stored tight.
 */
function canvasData(html: string): string {
  return serializeScene({ ...adoptScene(parseScene(html)), id: undefined });
}

function propsOf(node: DocNode): Record<string, string | number | boolean> | undefined {
  if (node.type === "heading") return { level: node.level ?? 2 };
  if (node.type === "checkListItem") return { checked: node.checked ?? false };
  if (node.type === "numberedListItem" && node.start !== undefined) {
    return { start: node.start };
  }
  if (node.type === "codeBlock") return { language: node.language, code: node.code };
  if (node.type === "mathBlock") return { source: node.rows.join("\n") };
  if (node.type === "canvas") return { data: canvasData(node.html) };
  if (MEDIA.has(node.type) && "url" in node) {
    return {
      ...(node.url !== undefined ? { url: node.url } : {}),
      ...(node.caption !== undefined ? { caption: node.caption } : {}),
      ...(node.name !== undefined ? { name: node.name } : {}),
    };
  }
  return undefined;
}

/** Ops that bring an existing block in line with the model's version. */
function updateOps(next: DocNode, current: DocNode): Operation[] {
  const id = next.id!;
  const ops: Operation[] = [];

  // A changed block TYPE can't be patched in place; the caller handles that by
  // treating it as a replacement.
  if (next.type !== current.type) return ops;

  if (PROSE.has(next.type) && "content" in next && "content" in current) {
    if (!sameRuns(next.content, current.content)) {
      ops.push({ kind: "setBlockContent", blockId: id, content: runsToInline(next.content) });
    }
    const p = propsOf(next);
    const cp = propsOf(current);
    if (p && JSON.stringify(p) !== JSON.stringify(cp)) {
      ops.push({ kind: "updateBlockProps", blockId: id, props: p });
    }
    return ops;
  }

  if (next.type === "codeBlock" && current.type === "codeBlock") {
    if (next.code !== current.code || next.language !== current.language) {
      ops.push({
        kind: "updateBlockProps",
        blockId: id,
        props: { language: next.language, code: next.code },
      });
    }
    return ops;
  }

  if (next.type === "table" && current.type === "table") {
    const rows = next.rows.map((row) => row.map(runsToInline));
    const same =
      JSON.stringify(rows) ===
        JSON.stringify(current.rows.map((row) => row.map(runsToInline))) &&
      !!next.header === !!current.header;
    if (!same) {
      ops.push({
        kind: "setTableRows",
        blockId: id,
        rows,
        ...(next.header ? { headerRows: 1 } : {}),
      });
    }
    return ops;
  }

  if (next.type === "mathBlock" && current.type === "mathBlock") {
    if (next.rows.join("\n") !== current.rows.join("\n")) {
      ops.push({ kind: "setMathRows", blockId: id, rows: next.rows });
    }
    return ops;
  }

  // Media holds no inline content, so everything about it lives in props — a
  // re-captioned image is a props update, not a content one. What the model did
  // not state it did not mean to change, so the patch carries only the fields it
  // gave, and only where they differ; `updateBlockProps` merges the rest.
  if (MEDIA.has(next.type)) {
    const cp = propsOf(current) ?? {};
    const patch = Object.entries(propsOf(next) ?? {}).filter(([k, v]) => cp[k] !== v);
    if (patch.length) {
      ops.push({ kind: "updateBlockProps", blockId: id, props: Object.fromEntries(patch) });
    }
    return ops;
  }

  if (next.type === "canvas" && current.type === "canvas") {
    // Whole-diagram, deliberately. The shape-level ops still exist and stay
    // dormant: review answers a hunk at a time, and until it can answer for one
    // shape there is nothing for that granularity to buy.
    const data = canvasData(next.html);
    if (data !== canvasData(current.html)) {
      ops.push({ kind: "updateBlockProps", blockId: id, props: { data } });
    }
    return ops;
  }

  return ops;
}

function newBlockFor(node: DocNode, tempId: string): NewBlock {
  const props = propsOf(node);
  const children =
    "children" in node && node.children?.length
      ? node.children.map((c, i) => newBlockFor(c, `${tempId}c${i}`))
      : undefined;
  return {
    tempId,
    type: node.type,
    ...(props ? { props } : {}),
    ...("content" in node ? { content: runsToInline(node.content) } : {}),
    // A table is two-dimensional, so it travels in `rows` rather than `content`.
    ...(node.type === "table"
      ? {
          rows: node.rows.map((row) => row.map(runsToInline)),
          ...(node.header ? { headerRows: 1 } : {}),
        }
      : {}),
    ...(children ? { children } : {}),
  };
}

/** Nested items are ordinary blocks with their own ids — flatten for diffing. */
function flatten(nodes: DocNode[]): DocNode[] {
  return nodes.flatMap((n) =>
    "children" in n && n.children?.length ? [n, ...flatten(n.children)] : [n],
  );
}

/** Each block's ancestors, outermost first. */
function ancestry(
  nodes: DocNode[],
  above: string[] = [],
  out = new Map<string, string[]>(),
): Map<string, string[]> {
  for (const n of nodes) {
    if (n.id) out.set(n.id, above);
    if ("children" in n && n.children?.length) {
      ancestry(n.children, n.id ? [...above, n.id] : above, out);
    }
  }
  return out;
}

export type CompileContext = {
  /**
   * Fallback insertion point for new blocks, used only when their position
   * can't be inferred from surrounding tagged blocks. Normally the cursor block.
   */
  anchorBlockId?: string;
  /** Current document in the same normalized shape, for like-for-like diffing. */
  current: DocNode[];
  /**
   * Block ids this rewrite is allowed to consume. Any of them the rewrite does
   * not keep is removed.
   *
   * Absent (the default) nothing is removed for being missing, which is what
   * makes it safe to hand the compiler a fragment of the document. But folding
   * several paragraphs into one code block or table is exactly a case where the
   * others must go, and the caller is the only one who knows which blocks were
   * on the table.
   */
  replacing?: string[];
};

export function compileDocHtml(next: DocNode[], ctx: CompileContext): Batch {
  const currentOrder = flatten(ctx.current).filter((n) => n.id);
  const currentById = new Map(currentOrder.map((n) => [n.id!, n]));
  // A rewrite that consumes blocks belongs where those blocks are. Without this
  // the two headline cases — a type change, and folding a run into one table —
  // have no tagged neighbour to place against and land at the end of the page.
  const consumed = new Set(ctx.replacing ?? []);
  const firstConsumed = currentOrder.find((n) => consumed.has(n.id!))?.id;
  const ops: Operation[] = [];
  // Position of the last thing we placed; new blocks follow it.
  let anchor: Position | null = null;
  let temp = 0;

  // Existing nested items are addressable by id, so diff over the flattened
  // tree; only genuinely new blocks keep their nesting (carried via `children`).
  // A newly inserted block brings its descendants with it, so they're skipped
  // here rather than inserted twice.
  const all = flatten(next);
  const insertedWithParent = new Set<DocNode>();

  // Everything this rewrite takes away: blocks whose type changed — the
  // vocabulary has no op for that, so they are replaced — and whatever the
  // caller offered up that the rewrite did not keep.
  const kept = new Set(all.flatMap((n) => (n.id ? [n.id] : [])));
  const doomed = new Set<string>([
    ...all.flatMap((n) => {
      const c = n.id ? currentById.get(n.id) : undefined;
      return c && c.type !== n.type ? [n.id!] : [];
    }),
    ...[...consumed].filter((id) => currentById.has(id) && !kept.has(id)),
  ]);
  const above = ancestry(ctx.current);
  /**
   * The outermost block on its way out that this one is inside. A block leaves
   * with its parent, so that is where a removal has to be named — and where
   * anything written beside it has to go, since inserting next to a block inside
   * the doomed one puts it inside too, and the removal then takes it along.
   */
  const doomedAncestor = (id: string) => (above.get(id) ?? []).find((a) => doomed.has(a));
  const relocate = (at: Position): Position => {
    if (at.at !== "before" && at.at !== "after") return at;
    const outer = doomedAncestor(at.ref);
    return outer ? { at: "before", ref: outer } : at;
  };

  all.forEach((node, i) => {
    if (insertedWithParent.has(node)) return;
    const existing = node.id ? currentById.get(node.id) : undefined;

    if (existing && existing.type === node.type) {
      ops.push(...updateOps(node, existing));
      anchor = { at: "after", ref: node.id! };
      return;
    }

    // Placement: where the block it replaces stands, else after whatever
    // preceded it, else BEFORE the next known block (so a new block written at
    // the top of the document lands at the top), else where the rewrite is
    // consuming from, else the caller's fallback.
    let at: Position;
    if (existing) {
      at = { at: "before", ref: existing.id! };
    } else if (anchor) {
      at = anchor;
    } else {
      const following = all
        .slice(i + 1)
        .find((n) => n.id && currentById.has(n.id));
      if (following) at = { at: "before", ref: following.id! };
      else if (firstConsumed) at = { at: "before", ref: firstConsumed };
      else if (ctx.anchorBlockId) at = { at: "after", ref: ctx.anchorBlockId };
      else at = { at: "docEnd" };
    }

    // Either brand new, or the same id with a different type — the vocabulary
    // has no "change type" op, so insert the replacement and drop the original.
    const tempId = `t${temp++}`;
    ops.push({
      kind: "insertBlocks",
      at: relocate(at),
      blocks: [newBlockFor(node, tempId)],
    });
    if ("children" in node && node.children?.length) {
      for (const d of flatten(node.children)) insertedWithParent.add(d);
    }
    // The replacement is a different block, so the original's children have to
    // be carried across by hand — `removeBlock` takes a whole subtree, and the
    // rewrite said nothing about what was nested under the block it retyped.
    if (existing && "children" in existing) {
      let to: Position = { at: "after", ref: tempId };
      for (const child of existing.children ?? []) {
        if (!child.id || doomed.has(child.id)) continue;
        ops.push({ kind: "moveBlock", blockId: child.id, to });
        to = { at: "after", ref: child.id };
      }
    }
    anchor = { at: "after", ref: tempId };
  });

  // Removals last, so every replacement is in place — and every child lifted out
  // — before the originals go. In document order, outermost only.
  for (const node of currentOrder) {
    if (doomed.has(node.id!) && !doomedAncestor(node.id!)) {
      ops.push({ kind: "removeBlock", blockId: node.id! });
    }
  }

  return { ops };
}
