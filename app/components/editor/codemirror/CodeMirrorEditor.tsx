"use client";

import { useEffect, useRef } from "react";
import { EditorState, Compartment } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { eveningExtensions } from "./theme";
import { loadLanguage } from "./languages";

/**
 * A thin React wrapper around a CodeMirror 6 EditorView. CodeMirror owns the
 * live text; `onChange` fires on every edit (the caller debounces persistence).
 * The view is created once; language grammar is swapped via a Compartment so we
 * never tear the editor down. External `value` changes are intentionally NOT
 * pushed back in while editing — CodeMirror is the source of truth here.
 */
export function CodeMirrorEditor({
  initialValue,
  language,
  onChange,
  onBlur,
}: {
  initialValue: string;
  language: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const langCompartment = useRef(new Compartment());

  // Keep callbacks fresh without re-creating the editor (updated in an effect
  // so we never write refs during render).
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  useEffect(() => {
    onChangeRef.current = onChange;
    onBlurRef.current = onBlur;
  });

  useEffect(() => {
    if (!host.current) return;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          langCompartment.current.of([]),
          EditorState.tabSize.of(2),
          eveningExtensions,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            blur: () => {
              onBlurRef.current?.();
              return false;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mount once; `initialValue` is only the seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swap the language grammar without destroying the editor.
  useEffect(() => {
    let cancelled = false;
    loadLanguage(language).then((ext) => {
      if (cancelled || !viewRef.current) return;
      viewRef.current.dispatch({
        effects: langCompartment.current.reconfigure(ext),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  return <div ref={host} className="ab-cm" />;
}
