"use client";

import {
  useActiveStyles,
  useBlockNoteEditor,
  useComponentsContext,
} from "@blocknote/react";
import { Code } from "../Icons";

/**
 * A toolbar button for the inline `code` mark.
 *
 * BlockNote's own `BasicTextStyleButton` can't be used here: its default
 * toolbar ships bold/italic/underline/strike only, and the shared i18n
 * dictionary has no `code` entry, so asking for one throws on the tooltip
 * lookup. This drives the same public verb the built-ins do — `toggleStyles` —
 * it just brings its own label and icon.
 *
 * The AI can already emit `<code>` through the document grammar, so the UI has
 * to be able to produce the identical mark. Same verb, one vocabulary.
 */
export function InlineCodeButton() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const active = useActiveStyles();

  return (
    <Components.FormattingToolbar.Button
      className="bn-button"
      data-test="code"
      label="Code"
      mainTooltip="Code"
      secondaryTooltip="Mod+E"
      isSelected={!!active.code}
      onClick={() => {
        editor.focus();
        editor.toggleStyles({ code: true });
      }}
      icon={<Code width={16} height={16} />}
    />
  );
}
