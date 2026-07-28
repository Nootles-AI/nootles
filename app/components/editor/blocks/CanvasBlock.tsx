"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { flattenBlocks, type AnyBlock } from "@/app/lib/ai/projection";
import { Canvas } from "../canvas/Canvas";

/** How many preceding blocks of page text to hand the canvas for context. */
const CONTEXT_BLOCKS = 4;

export const canvasBlockSpec = createReactBlockSpec(
  {
    type: "canvas",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <Canvas
        source={block.props.data}
        onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
        // Text just above the diagram, so completing a shape label can draw on
        // what the page is actually about.
        getDocContext={() => {
          const flat = flattenBlocks(editor.document as unknown as AnyBlock[]);
          const idx = flat.findIndex((b) => b.id === block.id);
          if (idx <= 0) return "";
          return flat
            .slice(Math.max(0, idx - CONTEXT_BLOCKS), idx)
            .map((b) => b.text.trim())
            .filter(Boolean)
            .join("\n");
        }}
      />
    ),
  },
)();
