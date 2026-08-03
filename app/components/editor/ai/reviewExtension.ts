import { createExtension } from "@blocknote/core";
import { reviewPlugin } from "./reviewDecorations";

/** Wires the review overlay into BlockNote. It binds no keys: answering a review
 *  is a decision, and the keyboard belongs to the person writing. */
export const reviewExtension = createExtension({
  key: "nt-review",
  prosemirrorPlugins: [reviewPlugin()],
});
