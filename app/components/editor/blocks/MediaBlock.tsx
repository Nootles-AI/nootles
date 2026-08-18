"use client";

import { createReactBlockSpec } from "@blocknote/react";
import { MediaSurface } from "../media/MediaSurface";
import { blockTypeFor } from "../media/link";

/**
 * The media block: a song or a video, by link or by file. One face, two block
 * types — the AI grammar already speaks in <audio> and <video>, so instead of
 * inventing a third word this replaces BlockNote's built-in audio AND video
 * blocks, keeping their prop names (`url`, `name`, `caption`) that the
 * grammar's elements land on unchanged.
 *
 * Which of the two a block is gets settled by what lands in it: a Spotify
 * link makes it audio, a Vimeo link makes it video, an upload goes by its
 * MIME type. Until something lands, the type is only a default — the empty
 * face is identical from both sides.
 */
function mediaBlockSpec(type: "audio" | "video") {
  return createReactBlockSpec(
    {
      type,
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
          <MediaSurface
            blockId={block.id}
            url={block.props.url}
            title={block.props.caption || block.props.name}
            fallbackKind={type}
            onSet={({ media, ...props }) =>
              editor.updateBlock(block.id, {
                type: media ?? blockTypeFor(props.url) ?? type,
                props,
              })
            }
          />
        </div>
      ),
    },
  )();
}

export const audioBlockSpec = mediaBlockSpec("audio");
export const videoBlockSpec = mediaBlockSpec("video");
