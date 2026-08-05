import { createExtension } from "@blocknote/core";
import {
  ghostTextPlugin,
  acceptSuggestion,
  dismissSuggestion,
  currentSuggestion,
} from "./ghostText";

/**
 * Wires the ghost-text plugin into BlockNote and binds the keys. Tab accepts a
 * showing suggestion; returning false when none is showing lets Tab fall through
 * to BlockNote's normal list-indent behaviour. Escape dismisses. Mod+E toggles
 * inline code, which BlockNote does not bind itself.
 */
export const completionExtension = createExtension({
  key: "nt-tab-completion",
  prosemirrorPlugins: [ghostTextPlugin()],
  keyboardShortcuts: {
    Tab: ({ editor }) => acceptSuggestion(editor.prosemirrorView),
    // Inline code. BlockNote binds Mod+B/I/U for the styles it ships with but
    // has no code mark in its toolbar, so this is ours to bind.
    "Mod-e": ({ editor }) => {
      editor.toggleStyles({ code: true });
      return true;
    },
    Escape: ({ editor }) => {
      const view = editor.prosemirrorView;
      if (!currentSuggestion(view.state)) return false;
      dismissSuggestion(view);
      return true;
    },
  },
});
