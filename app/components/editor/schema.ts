import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { codeBlockSpec } from "./blocks/CodeBlock";
import { keepListItems, stepOutOfEmptyItems } from "./blocks/listSafe";
import { markersByDepth } from "./blocks/listMarkers";
import { TURN_INTO, withoutShortcuts } from "./notionKeys";
import { mathBlockSpec } from "./blocks/MathBlock";
import { canvasBlockSpec } from "./blocks/CanvasBlock";
import { albumBlockSpec } from "./blocks/AlbumBlock";
import { storyboardBlockSpec } from "./blocks/StoryboardBlock";
import { audioBlockSpec, videoBlockSpec } from "./blocks/MediaBlock";
import { locationBlockSpec } from "./blocks/LocationBlock";
import { notionStubBlockSpec } from "./blocks/NotionStubBlock";
import { checkboxSpec } from "./inline/Checkbox";
import { mathInlineSpec } from "./inline/MathInline";
import { pageMentionSpec } from "./inline/PageMention";
import type { BlockType } from "@/convex/ai/operations";

const TURN_INTO_KEYS = Object.keys(TURN_INTO);

// Swap BlockNote's built-in code, audio and video blocks for our own.
const {
  codeBlock: _builtInCodeBlock,
  audio: _builtInAudio,
  video: _builtInVideo,
  ...rest
} = defaultBlockSpecs;

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...rest,
    // The paragraph and heading give up their ⌘⌥0–6 to the turn-into row in
    // `notionKeys`, which retypes a whole selection rather than one block.
    paragraph: withoutShortcuts(defaultBlockSpecs.paragraph, TURN_INTO_KEYS),
    // BlockNote's own heading and quote, less the one thing their markdown
    // prefixes were never meant to do — see `keepListItems`.
    heading: keepListItems(withoutShortcuts(defaultBlockSpecs.heading, TURN_INTO_KEYS)),
    quote: keepListItems(defaultBlockSpecs.quote),
    // BlockNote's own list items, less the one thing Enter on an empty one was
    // never meant to do — see `stepOutOfEmptyItems`.
    bulletListItem: stepOutOfEmptyItems(defaultBlockSpecs.bulletListItem),
    // Numbered items also count 1. a. i. by depth — see `markersByDepth`.
    numberedListItem: markersByDepth(
      stepOutOfEmptyItems(defaultBlockSpecs.numberedListItem),
    ),
    checkListItem: stepOutOfEmptyItems(defaultBlockSpecs.checkListItem),
    toggleListItem: stepOutOfEmptyItems(defaultBlockSpecs.toggleListItem),
    codeBlock: codeBlockSpec,
    mathBlock: mathBlockSpec,
    canvas: canvasBlockSpec,
    album: albumBlockSpec,
    storyboard: storyboardBlockSpec,
    audio: audioBlockSpec,
    video: videoBlockSpec,
    location: locationBlockSpec,
    // Never offered by the slash menu: only an import writes one.
    notionStub: notionStubBlockSpec,
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    checkbox: checkboxSpec,
    math: mathInlineSpec,
    pageMention: pageMentionSpec,
  },
});

export type EditorSchema = typeof schema;

/**
 * Every block the editor can produce must be nameable by the AI operation
 * vocabulary. A block missing from `BLOCK_TYPES` has no tag in the document
 * grammar, so it reaches the model as an opaque placeholder it can neither read
 * nor author — which is how divider, toggle and the media blocks quietly went
 * missing for months.
 *
 * This is a type-level assertion, not a runtime one: adding a block spec above
 * without adding it to the vocabulary fails `tsc`, and the error names the
 * block. Deliberately here rather than in the pure AI modules, because this is
 * the file that decides what the editor can produce.
 */
type Unaddressable = Exclude<keyof EditorSchema["blockSchema"], BlockType>;
const _everyBlockIsAddressable: [Unaddressable] extends [never]
  ? true
  : Unaddressable = true;
void _everyBlockIsAddressable;
