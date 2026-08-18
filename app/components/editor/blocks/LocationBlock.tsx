"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { LocationSurface } from "../location/LocationSurface";

/**
 * The location block: a place, as a card.
 *
 * Thin on purpose, like the album and the diagram: it holds its whole state as
 * markup in one prop — `<nt-location>` with the place's facts on the root and
 * a line per picture — so the AI reads and writes a place through the same
 * grammar it reads and writes everything else through, and the surface below
 * is left to be nothing but the card and its editor.
 */
export const locationBlockSpec = createReactBlockSpec(
  {
    type: "location",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      // `w-full` is load-bearing: BlockNote lays a block's content out with
      // flex, so this wrapper would otherwise shrink to the map's width.
      <div className="relative w-full">
        <LocationSurface
          blockId={block.id}
          source={block.props.data}
          onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
        />
      </div>
    ),
  },
)();
