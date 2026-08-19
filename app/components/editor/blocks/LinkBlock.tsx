"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { LinkSurface } from "../link/LinkSurface";

/**
 * The link block: a rich link preview card.
 *
 * Stored as `<nt-link>` with href, title, subtitle, and image URL as attributes,
 * so the AI reads and writes links through the same grammar as other blocks.
 */
export const linkBlockSpec = createReactBlockSpec(
  {
    type: "link",
    propSchema: { data: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <div className="relative w-full">
        <LinkSurface
          blockId={block.id}
          source={block.props.data}
          onChange={(data) => editor.updateBlock(block.id, { props: { data } })}
        />
      </div>
    ),
  },
)();
