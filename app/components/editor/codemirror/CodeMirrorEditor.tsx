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
 * never tear the editor down. External `initialValue` changes (AI ops, another
 * synced tab) are reconciled into the live doc, but our own edits are filtered
 * out so the caret is never disturbed while typing.
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
  // Last text CodeMirror emitted; distinguishes our own round-tripped writes
  // from genuinely external `value` changes (AI ops, another synced tab).
  const lastValue = useRef(initialValue);

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
            if (u.docChanged) {
              const s = u.state.doc.toString();
              lastValue.current = s;
              onChangeRef.current(s);
            }
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

  // Reconcile external `value` changes (an AI op, or the same doc edited in
  // another tab) into the live editor. Our own edits set `lastValue` first, so
  // they no-op here and leave the caret untouched.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (initialValue === lastValue.current) return;
    if (initialValue === view.state.doc.toString()) return;
    lastValue.current = initialValue;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: initialValue },
    });
  }, [initialValue]);

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
