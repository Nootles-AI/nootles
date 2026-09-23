import { createExtension } from "@blocknote/core";
import { commentDecorationsPlugin } from "./commentDecorations";

/** Comment highlights in BlockNote. Decorations only: the page is never written. */
export const commentExtension = createExtension({
  key: "nt-comments",
  prosemirrorPlugins: [commentDecorationsPlugin()],
});
