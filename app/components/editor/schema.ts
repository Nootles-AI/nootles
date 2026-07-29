import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { codeBlockSpec } from "./blocks/CodeBlock";
import { mathBlockSpec } from "./blocks/MathBlock";
import { canvasBlockSpec } from "./blocks/CanvasBlock";
import { mathInlineSpec } from "./inline/MathInline";
import type { BlockType } from "@/convex/ai/operations";

// Swap BlockNote's built-in code block for our CodeMirror-backed `code` block.
const { codeBlock: _builtInCodeBlock, ...rest } = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...rest,
    codeBlock: codeBlockSpec,
    mathBlock: mathBlockSpec,
    canvas: canvasBlockSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    math: mathInlineSpec,
  },
});

export type EditorSchema = typeof schema;

/**
 * Every block the editor can produce must be nameable by the AI operation
 * vocabulary. A block missing from `BLOCK_TYPES` has no tag in the document
 * grammar, so it reaches the model as an opaque placeholder it can neither read
 * nor author — which is how divider, toggle and the media blocks quietly went
 * missing for months.
 *
 * This is a type-level assertion, not a runtime one: adding a block spec above
 * without adding it to the vocabulary fails `tsc`, and the error names the
 * block. Deliberately here rather than in the pure AI modules, because this is
 * the file that decides what the editor can produce.
 */
type Unaddressable = Exclude<keyof EditorSchema["blockSchema"], BlockType>;
const _everyBlockIsAddressable: [Unaddressable] extends [never]
  ? true
  : Unaddressable = true;
void _everyBlockIsAddressable;
