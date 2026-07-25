import { createExtension } from "@blocknote/core";
import {
  ghostTextPlugin,
  acceptSuggestion,
  clearSuggestion,
  currentSuggestion,
} from "./ghostText";

/**
 * Wires the ghost-text plugin into BlockNote and binds the keys. Tab accepts a
 * showing suggestion; returning false when none is showing lets Tab fall through
 * to BlockNote's normal list-indent behaviour. Escape dismisses.
 */
export const completionExtension = createExtension({
  key: "ab-tab-completion",
  prosemirrorPlugins: [ghostTextPlugin()],
  keyboardShortcuts: {
    Tab: ({ editor }) => acceptSuggestion(editor.prosemirrorView),
    Escape: ({ editor }) => {
      const view = editor.prosemirrorView;
      if (!currentSuggestion(view.state)) return false;
      clearSuggestion(view);
      return true;
    },
  },
});
