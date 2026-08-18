"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { AudioSurface } from "../audio/AudioSurface";

/**
 * The audio block: a song, by link or by file.
 *
 * Replaces BlockNote's built-in audio block, keeping its prop names — `url`,
 * `name`, `caption` — because the AI grammar already reads and writes an
 * `<audio src title>` element onto exactly those props. A streaming link
 * (Spotify, Apple Music, YouTube, SoundCloud) renders as that provider's
 * player; an uploaded file as a plain one. Which is which is derived from the
 * URL every render (`audio/link.ts`), never stored.
 */
export const audioBlockSpec = createReactBlockSpec(
  {
    type: "audio",
    propSchema: {
      url: { default: "" },
      name: { default: "" },
      caption: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      // `w-full` is load-bearing: BlockNote lays a block's content out with
      // flex, so this wrapper would otherwise shrink to the player's width.
      <div className="relative w-full">
        <AudioSurface
          url={block.props.url}
          title={block.props.caption || block.props.name}
          onSet={(next) => editor.updateBlock(block.id, { props: next })}
        />
      </div>
    ),
  },
)();
