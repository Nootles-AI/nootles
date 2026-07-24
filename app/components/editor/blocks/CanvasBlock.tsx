"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { Canvas } from "../canvas/Canvas";

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
      />
    ),
  },
)();
