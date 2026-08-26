"use client";

import {
  BlockNoteSchema,
  createBlockSpec,
  createInlineContentSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  type PropSchema,
} from "@blocknote/core";
import type { EditorSchema } from "@/app/components/editor/schema";

/**
 * The editor's schema with the views taken out.
 *
 * Rebuilding a stored page needs the schema's SHAPE — node names, props,
 * content kind — and never its views: the headless editor these specs feed is
 * never mounted, so no render function here is ever called. The real specs
 * close over CodeMirror, KaTeX, the canvas renderer and the collab stack, so
 * importing them in order to READ a document drags the whole editor onto the
 * projects screen, whose thumbnails draw those same blocks themselves.
 *
 * `_mirrorsEditor` is what keeps the two honest: a prop added to a real block
 * and not to its stand-in fails `tsc` here, and the error names the block. The
 * type import that makes that work is erased, so the weight stays out.
 */

const emptyView = () => ({ dom: document.createElement("div") });

function standIn<const T extends string, const P extends PropSchema>(
  type: T,
  propSchema: P,
) {
  return createBlockSpec(
    { type, propSchema, content: "none" },
    { render: emptyView },
  )();
}

function inlineStandIn<const T extends string, const P extends PropSchema>(
  type: T,
  propSchema: P,
) {
  return createInlineContentSpec(
    { type, propSchema, content: "none" },
    { render: emptyView },
  );
}

const {
  codeBlock: _builtInCodeBlock,
  audio: _builtInAudio,
  video: _builtInVideo,
  ...rest
} = defaultBlockSpecs;

export const readerSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...rest,
    codeBlock: standIn("codeBlock", {
      language: { default: "typescript" },
      code: { default: "" },
    }),
    mathBlock: standIn("mathBlock", { source: { default: "" } }),
    canvas: standIn("canvas", { data: { default: "" } }),
    album: standIn("album", { data: { default: "" } }),
    storyboard: standIn("storyboard", { data: { default: "" } }),
    audio: standIn("audio", {
      url: { default: "" },
      name: { default: "" },
      caption: { default: "" },
    }),
    video: standIn("video", {
      url: { default: "" },
      name: { default: "" },
      caption: { default: "" },
    }),
    location: standIn("location", { data: { default: "" } }),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    math: inlineStandIn("math", { latex: { default: "" } }),
    pageMention: inlineStandIn("pageMention", {
      pageId: { default: "" },
      title: { default: "" },
    }),
  },
});

/**
 * Props and content kind per node name — the whole of what a reader needs to
 * agree on. The `type` field is dropped because the editor's audio and video
 * blocks are built by one factory and so carry the union of both names, which
 * says nothing about shape.
 */
type Shapes<S> = {
  [K in keyof S]: S[K] extends { type: string } ? Omit<S[K], "type"> : S[K];
};

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

const _mirrorsEditor: Exact<
  Shapes<(typeof readerSchema)["blockSchema"]>,
  Shapes<EditorSchema["blockSchema"]>
> &
  Exact<
    Shapes<(typeof readerSchema)["inlineContentSchema"]>,
    Shapes<EditorSchema["inlineContentSchema"]>
  > = true;
void _mirrorsEditor;
