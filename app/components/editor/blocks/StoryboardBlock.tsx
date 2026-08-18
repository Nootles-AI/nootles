"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { useReadOnly } from "../readOnly";
import { StoryboardSurface } from "../storyboard/StoryboardSurface";

/**
 * The storyboard block: a container of shots, each of which owns a canvas.
 *
 * Thin for the same reason the album and the canvas are — it holds its whole
 * state as markup in one prop, so the AI reads and writes a board through the
 * same grammar it reads and writes everything else through, and the surface
 * below is left to be nothing but the editor for it.
 *
 * It is its own block type rather than a canvas wearing a costume. A board is
 * not one scene: it is N of them plus the words under each, and pretending
 * otherwise is exactly what the first attempt did — with the result that the
 * structure holding it together was selectable, deletable, and listed in the
 * layers panel alongside the user's own shapes.
 */
function Block({
  blockId,
  data,
  onChange,
}: {
  blockId: string;
  data: string;
  onChange: (data: string) => void;
}) {
  const readOnly = useReadOnly();
  return (
    // `w-full` is load-bearing: BlockNote lays a block's content out with flex,
    // so this wrapper is a flex item and would otherwise shrink to its content.
    <div className="relative w-full">
      <StoryboardSurface
        blockId={blockId}
        source={data}
        onChange={onChange}
        readOnly={readOnly}
      />
    </div>
  );
}

export const storyboardBlockSpec = createReactBlockSpec(
  {
    type: "storyboard",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <Block
        blockId={block.id}
        data={block.props.data}
        onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
      />
    ),
  },
)();
