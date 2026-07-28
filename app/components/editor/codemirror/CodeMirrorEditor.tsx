"use client";

import { useEffect, useRef } from "react";
import { EditorState, Compartment, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { AI } from "@/app/lib/ai/aiConfig";
import { eveningExtensions } from "./theme";
import { codeGhostExtension, setCodeGhost } from "./ghost";
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
  getFimContext,
}: {
  initialValue: string;
  language: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Document HTML split at the caret inside this block, for completion. */
  getFimContext?: (offset: number) => { prefix: string; suffix: string } | null;
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
          codeGhostExtension,
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

  // Completion inside the block. The document is serialized into the auto-board
  // HTML language with the caret placed inside this <ab-code-block>, so the model
  // sees the whole page — the prose introducing the code, the diagram beside it —
  // and the closing tag sits in the suffix, so it returns bare code.
  const ctxRef = useRef(getFimContext);
  useEffect(() => {
    ctxRef.current = getFimContext;
  });

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;

    const run = async () => {
      const build = ctxRef.current;
      if (!build) return;
      const sel = view.state.selection.main;
      if (!sel.empty) return;
      const offset = sel.head;
      const ctx = build(offset);
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      try {
        const res = await fetch("/api/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ before: ctx.prefix, after: ctx.suffix, mode: "html" }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let acc = "";
        let settled = "";
        let headLitAt = 0;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += value;
          // The completion should stay inside the element; if the model starts
          // closing it, we've got everything that belongs in the block.
          const cut = acc.indexOf("</");
          const text = (cut === -1 ? acc : acc.slice(0, cut)).replace(/\s+$/, "");
          if (view.state.selection.main.head !== offset) return;
          if (text) {
            if (!headLitAt) headLitAt = performance.now();
            view.dispatch({
              effects: setCodeGhost.of({ text, streaming: true }),
            });
            settled = text;
          }
        }
        // The stream stopped: drop the live edge, keep the suggestion — but
        // hold the head long enough to actually be seen (see aiConfig).
        if (settled) {
          const done = settled;
          const settle = () => {
            if (view.state.selection.main.head !== offset) return;
            view.dispatch({
              effects: setCodeGhost.of({ text: done, streaming: false }),
            });
          };
          const lit = performance.now() - headLitAt;
          if (lit >= AI.timing.minStreamHeadMs) settle();
          else setTimeout(settle, AI.timing.minStreamHeadMs - lit);
        }
      } catch {
        // superseded or offline
      }
    };

    const schedule = () => {
      if (timer) clearTimeout(timer);
      abort?.abort();
      timer = setTimeout(() => void run(), 400);
    };

    const listener = EditorView.updateListener.of((u) => {
      if (u.docChanged || u.selectionSet) schedule();
    });
    view.dispatch({ effects: StateEffect.appendConfig.of(listener) });

    return () => {
      if (timer) clearTimeout(timer);
      abort?.abort();
    };
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
