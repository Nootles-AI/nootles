"use client";

import { useEffect, useRef } from "react";
import { EditorState, Compartment, StateEffect } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
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
  readOnly = false,
}: {
  initialValue: string;
  language: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Document HTML split at the caret inside this block, for completion. */
  getFimContext?: (offset: number) => { prefix: string; suffix: string } | null;
  /** Fixed for the life of the editor — the share viewer never becomes an author. */
  readOnly?: boolean;
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
          // Selection and copy still work; the document just cannot change.
          ...(readOnly
            ? [EditorState.readOnly.of(true), EditorView.editable.of(false)]
            : []),
          // No CodeMirror-local history: code edits persist onto the block
          // prop and live on the workspace timeline like everything else.
          // A second stack here meant ⌘Z answered differently depending on
          // where the caret sat, and the two stacks could ping-pong.
          keymap.of([...defaultKeymap, indentWithTab]),
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

  // Reconcile external `value` changes (an AI op, an undo landing on the
  // block prop, the same doc edited in another tab) into the live editor. Our
  // own edits set `lastValue` first, so they no-op here and leave the caret
  // untouched. The change is dispatched as the minimal middle — common prefix
  // and suffix stripped — so the caret maps through it instead of being
  // thrown by a whole-document replace.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (initialValue === lastValue.current) return;
    const prev = view.state.doc.toString();
    if (initialValue === prev) return;
    lastValue.current = initialValue;
    const next = initialValue;
    let start = 0;
    while (start < prev.length && start < next.length && prev[start] === next[start]) {
      start++;
    }
    let prevEnd = prev.length;
    let nextEnd = next.length;
    while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
      prevEnd--;
      nextEnd--;
    }
    view.dispatch({
      changes: { from: start, to: prevEnd, insert: next.slice(start, nextEnd) },
    });
  }, [initialValue]);

  // Completion inside the block. The document is serialized into the Nootles
  // HTML language with the caret placed inside this <nt-code-block>, so the model
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
    // Which suggestion is current. The caret alone cannot say: a stream
    // dismissed with Escape is dismissed at the offset it was asked for, and
    // would otherwise draw itself again on the next chunk.
    let seq = 0;

    const run = async () => {
      const build = ctxRef.current;
      if (!build) return;
      const sel = view.state.selection.main;
      if (!sel.empty) return;
      const mySeq = seq;
      const offset = sel.head;
      const ctx = build(offset);
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      const current = () =>
        seq === mySeq && view.state.selection.main.head === offset;
      try {
        const res = await fetch("/api/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // The wire call cuts to these numbers anyway; cutting here too
            // keeps a page carrying one very large block from uploading what
            // is about to be trimmed off again.
            before: ctx.prefix.slice(-AI.fim.maxBefore),
            after: ctx.suffix.slice(0, AI.fim.maxAfter),
            mode: "structure",
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let acc = "";
        let settled = "";
        let headLitAt = 0;
        let closed = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += value;
          // The completion should stay inside the element; if the model starts
          // closing it, we've got everything that belongs in the block.
          const cut = acc.indexOf("</");
          closed = cut !== -1;
          const text = (closed ? acc.slice(0, cut) : acc).replace(/\s+$/, "");
          if (!current()) return;
          if (text) {
            if (!headLitAt) headLitAt = performance.now();
            view.dispatch({
              effects: setCodeGhost.of({ text, streaming: true }),
            });
            settled = text;
          }
          // Everything that belongs in the block has arrived; the rest of the
          // completion is the rest of the page, and it is paid for by token.
          if (closed) break;
        }
        if (closed) controller.abort();
        // The stream stopped: drop the live edge, keep the suggestion — but
        // hold the head long enough to actually be seen (see aiConfig).
        if (settled) {
          const done = settled;
          const settle = () => {
            if (!current()) return;
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

    /** Nothing in flight, nothing pending: the suggestion is over. */
    const dismiss = () => {
      seq++;
      if (timer) clearTimeout(timer);
      timer = null;
      abort?.abort();
    };

    const schedule = () => {
      dismiss();
      timer = setTimeout(() => void run(), 400);
    };

    const listener = EditorView.updateListener.of((u) => {
      // A cleared ghost is a stream nobody is waiting for any more — Escape
      // dismissing it, or Tab having taken it (see ghost.ts).
      const cleared = u.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setCodeGhost) && e.value === null),
      );
      if (cleared) dismiss();
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

  return <div ref={host} className="nt-cm" />;
}
