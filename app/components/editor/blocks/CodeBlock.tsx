"use client";

import { useState } from "react";
import { createReactBlockSpec } from "@blocknote/react";
import { CodeSurface } from "../codemirror/CodeSurface";
import { useReadOnly } from "../readOnly";
import { useDebouncedPersist } from "../useDebouncedPersist";
import { toDocHtmlSplit } from "@/app/lib/ai/html/serialize";
import { AI } from "@/app/lib/ai/aiConfig";
import { track } from "@/app/lib/telemetry";
import { usePageTitle } from "../PageTitleContext";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { LANGUAGES, languageLabel } from "../codemirror/languages";

/** Quiet time before typed code reaches the block. Keystrokes are not writes. */
const PERSIST_MS = 400;

function CaretDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function Cross() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function LanguageDropdown({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="nt-code-lang">
      <button className="nt-code-lang-btn" onClick={() => setOpen((v) => !v)}>
        {languageLabel(value)}
        <CaretDown />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="nt-code-lang-menu">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                className={l.id === value ? "is-active" : ""}
                onClick={() => {
                  onChange(l.id);
                  setOpen(false);
                }}
              >
                {l.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

type CodeBlockViewProps = {
  language: string;
  code: string;
  onChangeCode: (value: string) => void;
  onChangeLanguage: (id: string) => void;
  onDelete: () => void;
  getFimContext?: (
    offset: number,
    title: string,
  ) => { prefix: string; suffix: string } | null;
};

function CodeBlockView({
  language,
  code,
  onChangeCode,
  onChangeLanguage,
  onDelete,
  getFimContext,
}: CodeBlockViewProps) {
  // A page-level fact, reached from deep in the editor tree.
  const title = usePageTitle();
  const readOnly = useReadOnly();

  // CodeMirror holds the live text; it reaches the block prop after a pause,
  // and on blur or unmount. An outside change needs no reconciling here — the
  // editor below takes it into its own document.
  const persist = useDebouncedPersist(onChangeCode, PERSIST_MS, code);

  return (
    <div className="nt-code" contentEditable={false}>
      <div className="nt-code-topbar">
        {readOnly ? (
          <span className="nt-code-lang-label">{languageLabel(language)}</span>
        ) : (
          <>
            <LanguageDropdown value={language} onChange={onChangeLanguage} />
            <button
              className="nt-code-delete"
              onClick={onDelete}
              aria-label="Delete code block"
              title="Delete"
            >
              <Cross />
            </button>
          </>
        )}
      </div>
      <CodeSurface
        initialValue={code}
        language={language}
        onChange={persist.schedule}
        onBlur={persist.flush}
        readOnly={readOnly}
        // The page title is a page-level fact and this block sits deep in the
        // editor tree, so it comes from context and is handed back up.
        getFimContext={
          readOnly ? undefined : (offset) => getFimContext?.(offset, title) ?? null
        }
      />
    </div>
  );
}

export const codeBlockSpec = createReactBlockSpec(
  {
    type: "codeBlock",
    propSchema: {
      language: { default: "typescript" },
      code: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <CodeBlockView
        language={block.props.language}
        code={block.props.code}
        onChangeCode={(value) =>
          editor.updateBlock(block.id, { props: { code: value } })
        }
        onChangeLanguage={(id) => {
          editor.updateBlock(block.id, { props: { language: id } });
          track("code_language_set", { lang: id });
        }}
        onDelete={() => editor.removeBlocks([block.id])}
        // The caret lives in CodeMirror, not ProseMirror, so we place it in the
        // serialized document ourselves — the model still sees the whole page.
        getFimContext={(offset, title) =>
          toDocHtmlSplit(
            editor.document as unknown as AnyBlock[],
            block.id,
            offset,
            { title, window: AI.projection.window, collapseDrawn: true },
          )
        }
      />
    ),
  },
)();
