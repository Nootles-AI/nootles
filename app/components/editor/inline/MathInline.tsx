"use client";

import { useState } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { createReactInlineContentSpec } from "@blocknote/react";
import { MathField } from "../math/MathField";

function renderKatex(latex: string): string {
  try {
    return katex.renderToString(latex, { throwOnError: false });
  } catch {
    return latex;
  }
}

function MathInlineView({
  latex,
  onChange,
}: {
  latex: string;
  onChange: (latex: string) => void;
}) {
  // Open the editor immediately for a freshly-inserted (empty) equation, so
  // `/math-equation` drops you straight into editing.
  const [editing, setEditing] = useState(latex.trim() === "");

  if (editing) {
    return (
      <span className="ab-math-inline is-editing" contentEditable={false}>
        <MathField
          initialValue={latex}
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
        className="ab-math-inline ab-math-placeholder"
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
      className="ab-math-inline"
      contentEditable={false}
      role="button"
      tabIndex={0}
      onClick={() => setEditing(true)}
      dangerouslySetInnerHTML={{ __html: renderKatex(latex) }}
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
