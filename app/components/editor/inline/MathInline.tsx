"use client";

import { useState } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { useKatex } from "../math/katex";
import { MathField } from "../math/MathField";
import { useReadOnly } from "../readOnly";

function MathInlineView({
  latex,
  onChange,
}: {
  latex: string;
  onChange: (latex: string) => void;
}) {
  const readOnly = useReadOnly();
  const render = useKatex();
  // Source until KaTeX arrives, not blank as a maths block is: an equation sits
  // in a line of prose, and a gap would close up and reflow the line on arrival.
  const typeset = () =>
    render ? { dangerouslySetInnerHTML: { __html: render(latex) } } : { children: latex };
  // Open the editor immediately for a freshly-inserted (empty) equation, so
  // `/math-equation` drops you straight into editing.
  const [editing, setEditing] = useState(latex.trim() === "");

  if (readOnly) {
    // A viewer gets the rendered equation and nothing to press; an empty one
    // is an authoring artefact and renders as nothing at all.
    if (latex.trim() === "") return null;
    return (
      <span
        className="nt-math-inline"
        contentEditable={false}
        {...typeset()}
      />
    );
  }

  if (editing) {
    return (
      <span className="nt-math-inline is-editing" contentEditable={false}>
        <MathField
          value={latex}
          onChange={onChange}
          onBlur={() => setEditing(false)}
          onEnter={() => setEditing(false)}
        />
      </span>
    );
  }

  if (latex.trim() === "") {
    return (
      <span
        className="nt-math-inline nt-math-placeholder"
        contentEditable={false}
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
      >
        equation
      </span>
    );
  }

  return (
    <span
      className="nt-math-inline"
      contentEditable={false}
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      {...typeset()}
    />
  );
}

export const mathInlineSpec = createReactInlineContentSpec(
  {
    type: "math",
    propSchema: { latex: { default: "" } },
    content: "none",
  },
  {
    render: (props) => (
      <MathInlineView
        latex={props.inlineContent.props.latex}
        onChange={(latex) =>
          props.updateInlineContent({ type: "math", props: { latex } })
        }
      />
    ),
  },
);
