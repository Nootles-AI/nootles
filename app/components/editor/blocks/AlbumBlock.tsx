"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { AlbumSurface } from "../album/AlbumSurface";

/**
 * The album block: photos and videos, packed into a waterfall.
 *
 * Thin on purpose. Like the canvas it holds its whole state as markup in one
 * prop — `<nt-album>` with an element per picture — so the AI reads and writes
 * an album through the same grammar it reads and writes a diagram through, and
 * the surface below is left to be nothing but the editor for it.
 */
export const albumBlockSpec = createReactBlockSpec(
  {
    type: "album",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      // `w-full` is load-bearing: BlockNote lays a block's content out with
      // flex, so this wrapper is a flex item and would otherwise shrink to the
      // width of the widest picture.
      <div className="relative w-full">
        <AlbumSurface
          source={block.props.data}
          onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
        />
      </div>
    ),
  },
)();
