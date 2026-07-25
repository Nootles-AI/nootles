import type { BlockNoteEditor } from "@blocknote/core";
import type { Action } from "./actions";
import type { Batch, InlineRun, Mark, Operation } from "@/convex/ai/operations";

/**
 * Compiles a curated planner Action into a Phase-2 op `Batch` addressed by real
 * ids. The model never emits ops directly — this deterministic step does, so the
 * ops are always well-formed. The batch then goes through the existing
 * `resolveBatch` (validation) and `applyBatch` (execution).
 *
 * Insertions land right after the cursor's block. `reformat` changes a block's
 * type by inserting a same-content block of the new type and removing the old
 * one (the vocabulary has no "change type" op — remove+insert is the primitive).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

const MARK_KEYS: Mark[] = ["bold", "italic", "underline", "strike", "code"];

function stylesToMarks(styles: unknown): Mark[] {
  if (!styles || typeof styles !== "object") return [];
  const s = styles as Record<string, unknown>;
  return MARK_KEYS.filter((m) => s[m] === true);
}

/** BlockNote inline content → typed InlineRun[] (links flattened to their text). */
function toInlineRuns(content: unknown): InlineRun[] {
  if (!Array.isArray(content)) return [];
  const runs: InlineRun[] = [];
  for (const item of content as Array<Record<string, unknown>>) {
    if (item.type === "text") {
      const marks = stylesToMarks(item.styles);
      runs.push({
        type: "text",
        text: String(item.text ?? ""),
        ...(marks.length ? { marks } : {}),
      });
    } else if (item.type === "math") {
      const latex = (item.props as { latex?: string } | undefined)?.latex ?? "";
      runs.push({ type: "math", latex });
    } else if (item.type === "link") {
      runs.push({ type: "text", text: toPlain((item.content as unknown) ?? []) });
    }
  }
  return runs;
}

function toPlain(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((i) => (i.type === "text" ? String(i.text ?? "") : ""))
    .join("");
}

function reformatProps(
  to: string,
  headingLevel?: number,
): Record<string, string | number | boolean> | undefined {
  if (to === "heading") return { level: headingLevel ?? 2 };
  if (to === "checkListItem") return { checked: false };
  return undefined;
}

/** Compile an action to a Batch, or null if it can't be placed. */
export function compileAction(
  editor: Editor,
  action: Action,
  currentBlockId: string,
): Batch | null {
  if (!currentBlockId) return null;
  const after = { at: "after" as const, ref: currentBlockId };

  switch (action.kind) {
    case "none":
      return null;

    case "insertCode": {
      if (!action.language) return null;
      return {
        ops: [
          {
            kind: "insertBlocks",
            at: after,
            blocks: [
              {
                tempId: "code",
                type: "codeBlock",
                props: { language: action.language, code: action.code ?? "" },
              },
            ],
          },
        ],
      };
    }

    case "insertMathBlock": {
      const rows = action.rows ?? [];
      if (!rows.length) return null;
      return {
        ops: [
          {
            kind: "insertBlocks",
            at: after,
            blocks: [
              {
                tempId: "math",
                type: "mathBlock",
                props: { source: rows.join("\n") },
              },
            ],
          },
        ],
      };
    }

    case "insertInlineMath": {
      if (!action.latex) return null;
      return {
        ops: [
          {
            kind: "insertBlocks",
            at: after,
            blocks: [
              {
                tempId: "im",
                type: "paragraph",
                content: [{ type: "math", latex: action.latex }],
              },
            ],
          },
        ],
      };
    }

    case "insertDiagram": {
      const nodes = action.nodes ?? [];
      const edges = action.edges ?? [];
      if (!nodes.length) return null;
      const ops: Operation[] = [
        {
          kind: "insertBlocks",
          at: after,
          blocks: [{ tempId: "cv", type: "canvas" }],
        },
      ];
      for (const n of nodes) {
        ops.push({
          kind: "addShape",
          blockId: "cv",
          tempId: n.tempId,
          shape: n.shape,
          position: { x: n.x, y: n.y },
          label: n.label,
        });
      }
      edges.forEach((e, i) => {
        ops.push({
          kind: "connectEdge",
          blockId: "cv",
          tempId: `edge${i}`,
          source: { tempId: e.source },
          target: { tempId: e.target },
          ...(e.label ? { label: e.label } : {}),
        });
      });
      return { ops };
    }

    case "reformat": {
      const blockIds = action.blockIds ?? [];
      if (!blockIds.length || !action.to) return null;
      const to = action.to;
      const props = reformatProps(to, action.headingLevel);
      const ops: Operation[] = [];
      blockIds.forEach((id, i) => {
        const block = editor.getBlock(id);
        if (!block) return;
        ops.push({
          kind: "insertBlocks",
          at: { at: "after", ref: id },
          blocks: [
            {
              tempId: `r${i}`,
              type: to,
              ...(props ? { props } : {}),
              content: toInlineRuns(block.content),
            },
          ],
        });
        ops.push({ kind: "removeBlock", blockId: id });
      });
      return ops.length ? { ops } : null;
    }
  }
}
