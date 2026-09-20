"use client";

import { createReactInlineContentSpec } from "@blocknote/react";
import { useReadOnly } from "../readOnly";

/**
 * A tick box that lives INSIDE a line rather than in front of one.
 *
 * The to-do list already owns "a line you can tick", and it owns it at block
 * level: the box is the list item's marker, drawn in the gutter, one per block.
 * A table cell holds inline content and no blocks at all, so there was no way
 * to put a box in one — an agent asked for a habit tracker wrote `☐` glyphs
 * into the cells instead, which read right and tick never (NT-41). This is the
 * same idea as an inline equation: a thing with its own state sitting in the
 * run of text, valid anywhere inline content is — cells, paragraphs, headings,
 * quotes, and the text of a list item.
 *
 * A real `<input type="checkbox">`, like BlockNote's own list marker, so the
 * box a reader tabs to, presses Space on, or hears announced is the browser's
 * own and not an impression of one.
 */
function CheckboxView({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: (next: boolean) => void;
}) {
  const readOnly = useReadOnly();
  return (
    <span className="nt-check" contentEditable={false}>
      <input
        type="checkbox"
        className="nt-check-box"
        checked={checked}
        disabled={readOnly}
        // `change` rather than `click`: it is the event the keyboard raises
        // too, so Space on a focused box ticks it exactly as a press does.
        onChange={(event) => onToggle(event.currentTarget.checked)}
      />
    </span>
  );
}

export const checkboxSpec = createReactInlineContentSpec(
  {
    type: "checkbox",
    propSchema: { checked: { default: false } },
    content: "none",
  },
  {
    render: (props) => (
      <CheckboxView
        checked={props.inlineContent.props.checked}
        onToggle={(checked) =>
          props.updateInlineContent({ type: "checkbox", props: { checked } })
        }
      />
    ),
  },
);
