"use client";

import { useEffect, useMemo, useRef } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { flattenBlocks, type AnyBlock } from "@/app/lib/ai/projection";
import { CanvasAiContext } from "../canvas/canvasAi";
import { CanvasSurface, type CanvasApi } from "../canvas/render/CanvasSurface";
import { useCanvasShell } from "../canvas/shell";

/** How many preceding blocks of page text to hand the canvas for context. */
const CONTEXT_BLOCKS = 4;

function CanvasBlockView({
  blockId,
  source,
  onChange,
  getDocContext,
}: {
  blockId: string;
  source: string;
  onChange: (source: string) => void;
  /** Surrounding page text, used to inform shape-label completion. */
  getDocContext: () => string;
}) {
  const shell = useCanvasShell();
  const mine = shell.active?.blockId === blockId;
  const api = useRef<CanvasApi | null>(null);

  // Keep the context value referentially stable. The block spec passes a fresh
  // closure on every render, and a changing context value would re-render every
  // shape on each editor update.
  const context = useRef(getDocContext);
  useEffect(() => {
    context.current = getDocContext;
  });
  const ai = useMemo(() => ({ getDocContext: () => context.current() }), []);

  // Not on mount: a page can hold several diagrams, and none of them should
  // take the screen's panels for being on it. Claimed on the way DOWN, and on
  // pointer rather than focus — the block is a void node, so ProseMirror keeps
  // the selection and the focus the canvas would otherwise be waiting for.
  const claim = () => {
    if (!mine && api.current) shell.set({ blockId, api: api.current });
  };

  return (
    // `w-full` is load-bearing: BlockNote lays a block's content out with flex,
    // so this wrapper is a flex item and would otherwise shrink to nothing —
    // the canvas sizes itself against it, and everything inside the canvas is
    // absolutely positioned, so there is no content to hold it open.
    <div className="w-full" onPointerDownCapture={claim} onFocus={claim}>
      <CanvasAiContext value={ai}>
        <CanvasSurface
          source={source}
          onChange={onChange}
          // Republished on every tool change, and withdrawn on unmount; either
          // way it speaks for this block only while this block holds the shell.
          onApi={(next) => {
            api.current = next;
            if (mine) shell.set(next ? { blockId, api: next } : null);
          }}
        />
      </CanvasAiContext>
    </div>
  );
}

export const canvasBlockSpec = createReactBlockSpec(
  {
    type: "canvas",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <CanvasBlockView
        blockId={block.id}
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
