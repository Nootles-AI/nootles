import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { codeBlockSpec } from "./blocks/CodeBlock";
import { mathBlockSpec } from "./blocks/MathBlock";
import { canvasBlockSpec } from "./blocks/CanvasBlock";
import { mathInlineSpec } from "./inline/MathInline";

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
