"use client";

import { useEffect, useRef } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import * as Sentry from "@sentry/nextjs";
import { useMutation } from "convex/react";
import { track } from "@/app/lib/telemetry";
import { noteDismissal } from "@/app/components/feedback/sampler";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { AI } from "@/app/lib/ai/aiConfig";
import { project, type AnyBlock } from "@/app/lib/ai/projection";
import { resolveBatch, warnRejected } from "@/app/lib/ai/validate";
import { applyBatch, caretTarget, type ApplyResult } from "@/app/lib/ai/apply";
import { broadcastFimFlash } from "@/app/lib/sync/fimFlash";
import { adoptScene } from "@/app/components/editor/canvas/scene/adopt";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import {
  toDocHtml,
  toDocHtmlSplit,
  runsToHtmlFromRuns,
} from "@/app/lib/ai/html/serialize";
import { parseDocHtml } from "@/app/lib/ai/html/parse";
import { asListItems } from "@/app/lib/ai/html/listify";
import type { DocNode } from "@/app/lib/ai/html/grammar";
import { compileDocHtml } from "@/app/lib/ai/html/compile";
import { completionsSuspended } from "@/app/lib/ai/tourDrive";
import { INLINE_TAGS, grounding, type Run } from "@/app/lib/ai/html/grammar";
import type { Batch } from "@/convex/ai/operations";
import {
  setGhost,
  setAction,
  clearSuggestion,
  isSuggestionDispatch,
  setActionApplyHandler,
  setGhostAcceptHandler,
  setDismissHandler,
  type Preview,
} from "./ghostText";
import { canvasPreview, type GhostBlock } from "./previewWidgets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Editor = BlockNoteEditor<any, any, any>;

/**
 * One example of each element, so a cold document still completes into our
 * grammar. A comment is the natural place for it — the parser ignores comments
 * entirely.
 *
 * Measured, twice. With no example of the block elements the model falls back
 * to standard `<pre><code>`; with one it adopts ours exactly. With no example
 * of the INLINE marks it does something worse than omit them — it reaches for a
 * block to do an inline job, emitting
 * `<nt-code-block lang="python">open_connection</nt-code-block>` for a single
 * identifier mid-sentence. With one example it writes `<code>` there instead,
 * and will use several in a sentence where that reads better.
 */
const PREAMBLE = `<!-- Nootles document. Blocks: <p>, <h2>, <ul><li>, <ol><li>, <blockquote>, <hr>,
<table><tr><th>Region</th></tr><tr><td>North</td></tr></table>,
<details><summary>Toggle</summary><p>inside</p></details>,
<nt-code-block lang="python">code</nt-code-block>,
<nt-math-block><nt-math-line>a = 1</nt-math-line></nt-math-block>,
Inline: <code>maxRetries</code>, <strong>bold</strong>, <em>italic</em>, <nt-math>x^2</nt-math>
Anything drawn — diagram, mockup, chart, wireframe, storyboard, illustration — is one
element saying what it is for, with how it should look carried into the brief:
<p>The deploy pipeline works like this:</p>
<nt-build-diagram>a flowchart of the deploy pipeline</nt-build-diagram>
<p>This is a mockup of an iPhone todo app. It's modern, sleek, in dark mode:</p>
<nt-build-diagram>a mockup of a modern, sleek iPhone todo app, in dark mode</nt-build-diagram>
<p>Here's how the opening scene plays out:</p>
<nt-build-diagram>a storyboard of the opening scene, four frames, drawn</nt-build-diagram> -->
`;

/**
 * A diagram, written as the one element that says what it is for.
 *
 * The canvas vocabulary is seven shape kinds, a connector, an attribute/CSS
 * split and a handful of rules — far too much to teach in a preamble that
 * prefixes EVERY completion, most of which are prose. So stage one writes only
 * the brief, which is the part it is good at (it can see the paragraph the
 * caret is in), and `/api/diagram` writes the shapes.
 *
 * Deliberately an element rather than a signal picked up by a heuristic: the
 * model still decides, in the grammar, that a diagram comes next, exactly as it
 * decides a code block does. Expanding it is a macro substitution — the markup
 * lands where the element stood — so nothing outside the model classifies
 * anything, and the rest of this lane cannot tell the difference.
 */
const BUILD_TAG = "nt-build-diagram";

/**
 * The brief so far, where the element began, and whether it has closed. Null
 * until it opens. `at` is where the diagram is spliced in: the stream is
 * already bounded to this element, so everything from there on is the macro.
 */
function diagramBrief(
  text: string,
): { brief: string; at: number; closed: boolean } | null {
  const open = new RegExp(`<${BUILD_TAG}[^>]*>`, "i").exec(text);
  if (!open) return null;
  const rest = text.slice(open.index + open[0].length);
  const close = new RegExp(`</${BUILD_TAG}\\s*>`, "i").exec(rest);
  return {
    brief: close ? rest.slice(0, close.index) : rest,
    at: open.index,
    closed: !!close,
  };
}

/** The `<nt-diagram>` element out of a finished reply, or "". Models fence. */
function diagramElement(text: string): string {
  return /<nt-diagram[\s\S]*<\/nt-diagram>/i.exec(text)?.[0] ?? "";
}

/**
 * The real id of the canvas a batch just inserted.
 *
 * The batch names it by `tempId`, which the applier resolves as it goes — so
 * this is the only moment the two are both in hand, and the id is what the rest
 * of the stream needs to keep writing into.
 */
function canvasIdOf(batch: Batch, result: ApplyResult): string | null {
  for (const op of batch.ops) {
    if (op.kind !== "insertBlocks") continue;
    for (const block of op.blocks) {
      if (block.type === "canvas") return result.blocks[block.tempId] ?? null;
    }
  }
  return null;
}

/**
 * Math is not markup.
 *
 * `<nt-math>i < n</nt-math>` carries a `<` that is a comparison, and a scanner
 * looking for tags reads `< n` as one opening. Since `n` is not an inline mark
 * the whole completion was then judged structural and thrown away — so a
 * suggestion ending in an inequality appeared and vanished, while one ending in
 * `a < b` survived, because `b` happens to be the bold tag.
 *
 * The interior is blanked rather than removed: `findBlockTag` returns an index
 * that {@link proseTail} slices the ORIGINAL string with, so the mask has to be
 * the same length as what it covers.
 */
function maskMath(text: string): string {
  return text.replace(
    /(<nt-math>)([\s\S]*?)(<\/nt-math>|$)/gi,
    (_, open: string, body: string, close: string) =>
      open + body.replace(/</g, " ") + close,
  );
}

/** The first block-level tag in the text, or -1. Inline marks are skipped:
 * `<code>`, `<strong>` and friends are prose, not a new block. */
function findBlockTag(text: string): number {
  // No `\s*` after the `<`: a tag is written `<p>`, never `< p>`, and allowing
  // the space is what let a bare `x < y` in prose read as an opening tag too.
  const re = /<(\/?)([a-zA-Z][\w-]*)/g;
  const scanned = maskMath(text);
  let m: RegExpExecArray | null;
  while ((m = re.exec(scanned))) {
    if (!INLINE_TAGS.has(m[2].toLowerCase())) return m.index;
  }
  return -1;
}

/**
 * A completion that opens or closes a BLOCK, rather than continuing prose.
 *
 * Inline marks must not count. Treating them as structure truncated
 * "the <code>maxRetries</code> option controls…" at the closing tag and tried
 * to compile the fragment into ops, so inline code in a suggestion arrived as a
 * mangled half-sentence.
 */
function isStructural(text: string): boolean {
  return findBlockTag(text) !== -1;
}

/**
 * The prose a structural completion writes before it opens its first element.
 * Finishing "Here's a dia" into "…gram of the quadratic formula:" and then
 * drawing the diagram is one suggestion, and both halves have to be visible.
 */
function proseTail(text: string): string {
  const cut = findBlockTag(text);
  return (cut === -1 ? text : text.slice(0, cut)).replace(/\n+$/, "");
}

/** Index just past `<tag>…</tag>`, counting nesting, or -1 if it never closes. */
function endOfElement(text: string, tag: string): number {
  const re = new RegExp(`<(/?)${tag}(?=[\\s/>])`, "gi");
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!m[1]) {
      depth++;
      continue;
    }
    if (--depth > 0) continue;
    const gt = text.indexOf(">", m.index);
    return gt === -1 ? -1 : gt + 1;
  }
  return -1;
}

/**
 * The completion cut down to one block: the prose finishing the current block,
 * the tag closing it, and the first element opened after that.
 *
 * Left alone the model keeps writing — asked to finish "Here's a dia" it drew
 * the diagram and then toured every other block type in the grammar. That made
 * the preview a lie, showing one block where Tab would have applied five. `done`
 * says the element closed, so the stream can be cut short.
 */
function firstBlock(acc: string): { text: string; done: boolean } {
  const cut = findBlockTag(acc);
  if (cut === -1) return { text: acc, done: false };
  let head = acc.slice(0, cut);
  let rest = acc.slice(cut);
  const closing = /^<\/[a-zA-Z][\w-]*\s*>\s*/.exec(rest);
  if (closing) {
    head += closing[0];
    rest = rest.slice(closing[0].length);
  }
  const open = /^<([a-zA-Z][\w-]*)[^>]*>/.exec(rest);
  if (!open) return { text: head + rest, done: false };
  const end = endOfElement(rest, open[1]);
  if (end === -1) return { text: head + rest, done: false };
  return { text: head + rest.slice(0, end), done: true };
}

/** Any tag at all — inline marks included. */
function hasMarkup(text: string): boolean {
  return /<\s*\/?[a-zA-Z]/.test(text);
}

/**
 * What the ghost SHOWS. Inline markup is rendered away, including a tag still
 * mid-arrival, so the reader never sees a raw `<strong>` or a dangling `<str`.
 */
function displayText(text: string): string {
  return text
    .replace(/<\/?[a-zA-Z][\w-]*(?:\s[^>]*)?>/g, "")
    .replace(/<[^>]*$/, "")
    .replace(/^\n+/, "");
}

/**
 * Preview built from a HALF-ARRIVED completion, so a diagram draws itself as its
 * shapes come in rather than sitting behind a spinner for a few seconds.
 *
 * The partial markup is malformed by definition — the last tag is usually cut
 * mid-attribute — but DOM parsing is forgiving, so complete elements come back
 * and the rest is ignored. Positions run through the same layout the compiler
 * uses, so nothing shifts when the finished version replaces it.
 */
function partialPreview(acc: string): { label: string; preview?: Preview } | null {
  let nodes;
  try {
    nodes = parseDocHtml(acc);
  } catch {
    return null;
  }
  const canvas = nodes.find((n) => n.type === "canvas");
  if (canvas && canvas.type === "canvas") {
    const preview = canvasPreview(canvas.html);
    return { label: "Add diagram", ...(preview ? { preview } : {}) };
  }
  const code = nodes.find((n) => n.type === "codeBlock");
  if (code && code.type === "codeBlock") {
    return {
      label: "Insert code block",
      preview: { kind: "code", language: code.language, code: code.code },
    };
  }
  const math = nodes.find((n) => n.type === "mathBlock");
  if (math && math.type === "mathBlock") {
    const lines = math.rows.filter(Boolean);
    if (!lines.length) return { label: "Insert math block" };
    return { label: "Insert math block", preview: { kind: "math", lines } };
  }
  const table = nodes.find((n) => n.type === "table");
  if (table && table.type === "table") {
    if (!table.rows.length) return { label: "Insert table" };
    return {
      label: "Insert table",
      preview: tablePreview(table.header, table.rows),
    };
  }
  // Whatever is left is text, and text is shown as text.
  return null;
}

/** Table cells as inline markup, so the preview renders marks and maths. */
function tablePreview(
  header: boolean | undefined,
  rows: Run[][][],
): Extract<Preview, { kind: "table" }> {
  return {
    kind: "table",
    header: !!header,
    rows: rows.map((cells) => cells.map(runsToHtmlFromRuns)),
  };
}

/**
 * Cheap signal for "enough has arrived to be worth redrawing".
 *
 * Counts CLOSED shapes, not open ones: a shape whose tag has arrived but whose
 * label has not would otherwise redraw the whole preview to add an empty box,
 * and then again a moment later to fill it in.
 */
function previewSignature(acc: string): string {
  const shapes = (
    acc.match(/<\/nt-(?:rect|ellipse|polygon|text|image|path|group)>/gi) ?? []
  ).length;
  const edges = (acc.match(/<\/nt-edge\s*>/gi) ?? []).length;
  return `${proseTail(acc)}:${shapes}:${edges}:${acc.length >> 5}`;
}

/**
 * Human label + preview for whatever the completion turned out to be, or null
 * when the only honest answer would be a generic one.
 */
function describe(batch: Batch): { label: string; preview?: Preview } | null {
  for (const op of batch.ops) {
    if (op.kind !== "insertBlocks") continue;
    const block = op.blocks[0];
    if (block.type === "codeBlock") {
      const props = block.props ?? {};
      return {
        label: "Insert code block",
        preview: {
          kind: "code",
          language: String(props.language ?? "plaintext"),
          code: String(props.code ?? ""),
        },
      };
    }
    if (block.type === "canvas") {
      // From the block's own data, which is where the compiler puts a diagram —
      // it emits `props.data`, never the shape-level ops. Reading those instead
      // found nothing, so the preview came back empty, and an "Add diagram"
      // with nothing to show is refused below: the suggestion vanished.
      const preview = canvasPreview(String(block.props?.data ?? ""));
      return { label: "Add diagram", ...(preview ? { preview } : {}) };
    }
    if (block.type === "mathBlock") {
      const lines = String(block.props?.source ?? "")
        .split("\n")
        .filter(Boolean);
      return {
        label: "Insert math block",
        ...(lines.length ? { preview: { kind: "math" as const, lines } } : {}),
      };
    }
    if (block.type === "table") {
      // A table travels in `rows` rather than `content`, because it is the one
      // block that is two-dimensional.
      const rows = (block.rows ?? []) as unknown as Run[][][];
      return {
        label: "Insert table",
        ...(rows.length ? { preview: tablePreview(!!block.headerRows, rows) } : {}),
      };
    }
    if (block.type === "heading") return null;
  }
  // Ordinary text is described from the markup instead — see `textFromMarkup`.
  return null;
}

/**
 * A text-only completion as the blocks it will become.
 *
 * Blocks that are only text get no preview chrome and no chip: they are already
 * legible as themselves, so they are drawn as themselves, below the caret's line
 * where accepting will put them.
 *
 * Takes the nodes the completion authored, read in their place in the document
 * — see `authored`. Built from the PARSED completion rather than the compiled batch, because the
 * two carry inline marks differently — the batch says `marks: ["bold"]` while
 * `runsToHtml` reads `styles: { bold: true }`, so serialising the batch quietly
 * returns the words with every mark and every equation stripped. It type-checks
 * either way; `content` is `unknown` on that path.
 */
function blocksFromMarkup(nodes: DocNode[]): GhostBlock[] {
  const convert = (list: DocNode[]): GhostBlock[] =>
    list.flatMap((node) => {
      if (!("content" in node)) return [];
      const html = runsToHtmlFromRuns(node.content ?? []);
      const children =
        "children" in node && node.children?.length ? convert(node.children) : [];
      // An empty paragraph is the seam left by splicing into the middle of a
      // block, not something the completion wrote. Drawing it would put a blank
      // row in the preview and, worse, disagree with `caretTarget`, which lands
      // the caret in the last block that actually has words in it.
      if (node.type === "paragraph" && !html.trim() && !children.length) return [];
      return [
        {
          type: node.type,
          ...(node.level !== undefined ? { level: node.level } : {}),
          ...(node.checked !== undefined ? { checked: node.checked } : {}),
          ...(node.start !== undefined ? { start: node.start } : {}),
          html,
          ...(children.length ? { children } : {}),
        },
      ];
    });
  return convert(nodes);
}

/**
 * The single inline-suggestion lane.
 *
 * The document is serialized into the Nootles HTML language and split at the
 * caret; the model completes the middle. Nothing classifies intent — if the
 * natural continuation is a code block, the model writes one, because that's
 * what comes next in the grammar. The SHAPE of the completion decides how it's
 * shown: bare text streams as ghost text, markup is compiled into ops and
 * offered as a previewed block. Tab accepts either.
 */
export type PageMode = "create" | "complete";

/** Everything the telemetry row needs about the suggestion on screen. */
type ShownState = {
  kind: string;
  latencyMs: number;
  shownAt: number;
  text: string;
  contextBefore: string;
  docLength: number;
};

type DismissReason =
  | "typed-through"
  | "cursor-moved"
  | "superseded"
  | "escape"
  | "timeout";

const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Cut a completion to its first clause. Complete offers a few words you were
 * obviously about to type, never a paragraph you did not ask for.
 */
function firstClause(text: string, max: number): string {
  const end = text.search(/[.!?;:](\s|$)/);
  const cut = end === -1 ? text : text.slice(0, end + 1);
  return cut.length > max ? cut.slice(0, max).replace(/\s+\S*$/, "") : cut;
}

export function useTabCompletion(
  editor: Editor | null | undefined,
  pageId?: Id<"pages"> | null,
  title = "",
  mode: PageMode = "create",
  /** The sync doc, so an accept can announce itself to collaborators. */
  docId?: string,
) {
  const appendBatch = useMutation(api.ai.opLog.appendBatch);
  const logSuggestion = useMutation(api.ai.suggestions.log);
  const amendSuggestion = useMutation(api.ai.suggestions.amend);
  const appendRef = useRef(appendBatch);
  const logRef = useRef(logSuggestion);
  const amendRef = useRef(amendSuggestion);
  useEffect(() => {
    appendRef.current = appendBatch;
    logRef.current = logSuggestion;
    amendRef.current = amendSuggestion;
  });

  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let abort: AbortController | null = null;
    /**
     * A diagram the user accepted mid-flight, still being written into.
     *
     * Held apart from `abort` on purpose: that one is cancelled by the next
     * keystroke, and the whole point of an accepted diagram is that the user
     * goes on typing while it finishes. Only unmounting stops this one.
     */
    let liveAbort: AbortController | null = null;
    let seq = 0;
    let shown: ShownState | null = null;

    const view = () => editor.prosemirrorView;
    // Convex mutations trigger React state; dispatching one from inside the
    // editor's update cycle re-enters rendering. Always defer writes out of it.
    const defer = (fn: () => void) => setTimeout(fn, 0);

    /** The full telemetry row for a settled suggestion. Resolves to its id. */
    const logOutcome = (
      s: ShownState,
      outcome: "accepted" | "dismissed" | "superseded",
      extra?: {
        dismissReason?: DismissReason;
        blockIds?: string[];
        acceptedText?: string;
      },
    ) => {
      const decisionMs = Math.round(performance.now() - s.shownAt);
      if (outcome === "accepted") {
        track("suggestion_accepted", {
          kind: s.kind,
          latencyMs: s.latencyMs,
          decisionMs,
        });
      } else {
        track("suggestion_dismissed", {
          kind: s.kind,
          reason: extra?.dismissReason ?? outcome,
        });
        if (outcome === "dismissed") noteDismissal();
      }
      if (!pageId) return Promise.resolve(null);
      return logRef.current({
        pageId,
        kind: s.kind,
        gateOk: true,
        shown: true,
        outcome,
        latencyMs: s.latencyMs,
        suggestionText: s.text,
        contextBefore: s.contextBefore,
        model: s.kind === "Add diagram" ? AI.diagram.model : AI.fim.model,
        pageMode: mode,
        docLength: s.docLength,
        decisionMs,
        ...extra,
      });
    };

    /**
     * The strongest negative signal there is: an accept undone within 30s.
     * Watched client-side because undo never reaches the op log — it is a
     * plain editor history step.
     */
    let undoWatch: {
      id: Id<"suggestionLog">;
      blockIds: string[];
      /** For prose accepts, where the block outlives the undo: the text must. */
      snippet: string | null;
      at: number;
    } | null = null;

    const watchUndo = (
      id: Id<"suggestionLog">,
      blockIds: string[],
      snippet: string | null,
    ) => {
      undoWatch = { id, blockIds, snippet, at: Date.now() };
    };

    const blockTextOf = (id: string): string | null => {
      let block: unknown;
      try {
        block = editor.getBlock(id);
      } catch {
        return null;
      }
      if (!block) return null;
      const parts: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        const n = node as {
          text?: unknown;
          content?: unknown;
          children?: unknown;
          rows?: unknown;
          cells?: unknown;
        };
        if (typeof n.text === "string") parts.push(n.text);
        walk(n.content);
        walk(n.children);
        // Table text lives in rows→cells, and missing it read every accept
        // inside a table as undone within seconds.
        walk(n.rows);
        walk(n.cells);
      };
      walk(block);
      return parts.join(" ");
    };

    const checkUndo = () => {
      const w = undoWatch;
      if (!w) return;
      if (Date.now() - w.at > 30_000) {
        undoWatch = null;
        return;
      }
      const texts = w.blockIds.map(blockTextOf);
      const allGone = texts.every((t) => t === null);
      const snippetLost =
        w.snippet !== null &&
        !texts.some((t) => t !== null && squash(t).includes(w.snippet as string));
      if (!allGone && !snippetLost) return;
      const { id, at } = w;
      undoWatch = null;
      defer(() => {
        void amendRef
          .current({ id, undoneWithinMs: Date.now() - at })
          .catch(() => {});
      });
    };

    /** Applies a batch, lands the caret after it, and records both. */
    const applyNow = (batch: Batch) => {
      const s = shown;
      shown = null;
      const result = applyBatch(editor, batch, "fim");
      const target = caretTarget(result);
      if (target) editor.setTextCursorPosition(target, "end");
      // In the same task as the apply, never deferred: the marker must ride
      // the same sync flush as the content so it arrives gold-first.
      if (s && docId) {
        const blockIds = Object.values(result.blocks);
        if (blockIds.length) broadcastFimFlash(docId, blockIds);
      }
      if (pageId) {
        defer(() => {
          void appendRef
            .current({ pageId, source: "ai", ops: batch.ops })
            .catch(() => {});
          if (s) {
            const blockIds = Object.values(result.blocks);
            void logOutcome(s, "accepted", {
              acceptedText: s.text,
              ...(blockIds.length ? { blockIds } : {}),
            })
              .then((id) => {
                if (id && blockIds.length) watchUndo(id, blockIds, null);
              })
              .catch(() => {});
          }
        });
      }
      return result;
    };
    setActionApplyHandler(applyNow);

    // A plain-prose ghost accept inserts text directly — a doc change this
    // hook cannot tell from typing. The handler runs synchronously before the
    // insert, so the accept is logged as one (it used to read as a dismissal).
    setGhostAcceptHandler((text) => {
      const s = shown;
      shown = null;
      if (!s) return;
      let blockId: string | null = null;
      try {
        blockId = editor.getTextCursorPosition().block.id as string;
      } catch {}
      const snippet = squash(text).slice(0, 40) || null;
      // Synchronous, pre-insert: the marker queues just ahead of the text in
      // the same flush, which is what makes it gold on arrival.
      if (docId && blockId) broadcastFimFlash(docId, [blockId]);
      defer(() => {
        void logOutcome(s, "accepted", {
          acceptedText: text,
          ...(blockId ? { blockIds: [blockId] } : {}),
        })
          .then((id) => {
            if (id && blockId) watchUndo(id, [blockId], snippet);
          })
          .catch(() => {});
      });
    });

    // Escape, as opposed to typing through or moving away.
    setDismissHandler(() => {
      const s = shown;
      shown = null;
      if (!s) return;
      defer(() => {
        void logOutcome(s, "dismissed", { dismissReason: "escape" }).catch(
          () => {},
        );
      });
    });

    /**
     * Writes into a diagram block that has already been accepted, while the
     * builder is still drawing it.
     *
     * Through the op vocabulary rather than by touching the editor directly,
     * because this is a mutation like any other — it just happens to have no
     * one waiting to approve it.
     */
    const writeDiagram = (blockId: string, data: string) => {
      applyBatch(
        editor,
        { ops: [{ kind: "updateBlockProps", blockId, props: { data } }] },
        "diagram",
      );
    };

    const context = () => {
      const state = editor.prosemirrorState;
      const sel = state.selection;
      if (!sel.empty || !sel.$from.parent.isTextblock) return null;
      // A caret in a table cell. BlockNote's cursor block is the table itself —
      // cells are not blocks — so which cell has to be read off the ProseMirror
      // ancestry: the row's index in the table, the cell's index in the row.
      const $from = sel.$from;
      let cell: { row: number; col: number } | undefined;
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === "tableRow") {
          cell = { row: $from.index(d - 1), col: $from.index(d) };
          break;
        }
      }
      let cursorBlockId: string;
      try {
        cursorBlockId = editor.getTextCursorPosition().block.id as string;
      } catch {
        return null;
      }
      const blocks = editor.document as unknown as AnyBlock[];
      const split = toDocHtmlSplit(
        blocks,
        cursorBlockId,
        sel.$from.parentOffset,
        { title },
        cell,
      );
      if (!split) return null;
      // Enough written to complete from. "complete" wants more before it
      // speaks at all.
      const bare = split.prefix.replace(/<[^>]*>/g, "");
      const visible = bare.trim();
      if (visible.length < AI.modes[mode].minContextChars) return null;
      // Untrimmed: whether the caret sits mid-word decides what "complete" is
      // willing to offer.
      return {
        ...split,
        cursorBlockId,
        blocks,
        visible,
        midWord: /\w$/.test(bare),
        cell,
      };
    };

    /**
     * Stage two: a brief becomes shapes.
     *
     * Returns the `<nt-diagram>` element, `""` when there was nothing worth
     * drawing (the builder is allowed to decline — the brief came from a model
     * that only saw one paragraph), and `null` when there is nothing left for
     * the caller to do: the turn was superseded, or the user accepted the
     * diagram mid-flight and it has been finishing in the document ever since.
     *
     * Two modes, and Tab is what moves between them. Until it is pressed the
     * shapes go to the preview and `abort` owns the stream, so the next
     * keystroke cancels it. After it, the diagram is a real block: the shapes go
     * there instead, and the stream moves to `liveAbort` — out of reach of the
     * typing the user is now free to do.
     */
    const buildDiagram = async (
      brief: string,
      page: string,
      tail: string,
      mySeq: number,
      place: (diagram: string) => string | null,
    ): Promise<string | null> => {
      const controller = new AbortController();
      abort = controller;
      let out = "";
      let lastSig = "";
      /** The block the shapes are going into, once there is one. */
      let live: string | null = null;

      // Whole shapes only: the tail of the stream is usually a tag cut
      // mid-attribute, and the scene parser drops it. Re-serialized so what is
      // placed is closed and canonical — spliced in unclosed, the rest of the
      // document would parse as being inside the diagram. Adopted for the same
      // reason `canvasData` adopts: a path arrives with the box the model
      // guessed, and the preview has to be drawn against the box the document
      // will end up with, or accepting the diagram would move it.
      const soFar = (): string => {
        const scene = adoptScene(migrateLegacyCanvas(out));
        return scene.nodes.length ? serializeScene(scene) : "";
      };

      const accept = () => {
        const drawn = soFar();
        if (!drawn) return;
        // Handed over BEFORE placing, not after. Placing changes the document,
        // which runs `schedule()` synchronously, and the first thing that does
        // is abort whatever `abort` is holding — so handing over afterwards
        // cancelled the stream a moment before it was rescued.
        if (abort === controller) abort = null;
        liveAbort = controller;
        const placed = place(drawn);
        if (placed) {
          live = placed;
          return;
        }
        // Nothing landed, so this is still an ordinary suggestion: give the
        // stream back to the keystroke that would have cancelled it.
        liveAbort = null;
        abort = controller;
      };

      try {
        const res = await fetch("/api/diagram", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brief, page, title }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return "";
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // Only while it is still a suggestion. Once placed it belongs to the
          // document, and the document does not care what the caret is doing.
          if (!live && mySeq !== seq) return null;
          out += value;
          const sig = previewSignature(out);
          if (sig === lastSig) continue;
          lastSig = sig;
          if (live) {
            // Straight into the block, so it fills in under the user while they
            // carry on writing beneath it.
            const drawn = soFar();
            if (drawn) writeDiagram(live, drawn);
            continue;
          }
          // Drawn as the shapes arrive, so a two-second call reads as a diagram
          // building itself. From `soFar()` rather than from the raw stream, so
          // the preview is the exact string `accept` would place: half-arrived
          // markup is dropped and every path is already tightened onto its box,
          // and a Tab pressed mid-stream lands what was on screen rather than
          // something a rounding away from it.
          const preview = canvasPreview(soFar());
          if (preview) {
            setAction(view(), {
              label: "Add diagram",
              batch: null,
              preview,
              tail,
              onAccept: accept,
            });
          }
        }
      } catch {
        // A placed diagram that was cut off keeps whatever it had drawn: it is
        // in the document, and half a diagram the user can finish by hand beats
        // one that empties itself.
        return null;
      }
      if (!live) return diagramElement(out);
      const finished = soFar();
      if (finished) {
        writeDiagram(live, finished);
        if (pageId) {
          const ops = [
            {
              kind: "updateBlockProps" as const,
              blockId: live,
              props: { data: finished },
            },
          ];
          defer(() => {
            void appendRef.current({ pageId, source: "ai", ops }).catch(() => {});
          });
        }
      }
      liveAbort = null;
      return null;
    };

    const run = async (mySeq: number) => {
      const ctx = context();
      if (!ctx) return;
      const controller = new AbortController();
      abort = controller;
      const started = performance.now();

      /** What the telemetry row will say about the suggestion now on screen. */
      const shownState = (kind: string): ShownState => {
        const latencyMs = elapsed(started);
        track("suggestion_shown", { kind, latencyMs });
        return {
          kind,
          latencyMs,
          shownAt: performance.now(),
          text: acc,
          contextBefore: ctx.visible.slice(-500),
          docLength: ctx.visible.length,
        };
      };

      const limits = AI.modes[mode];
      // How many blocks stand before the caret. Whatever the parse returns past
      // this is what the completion added, read in its place in the document —
      // a bare `<li>` cannot say which kind of list it belongs to on its own.
      const written = parseDocHtml(ctx.prefix).length;
      // The caret's own block included: the completion writes into it too, and
      // it is the block a "1." the user just typed is sitting in.
      const from = Math.max(0, written - 1);
      /**
       * The completion's own blocks, normalized the way typing them would be.
       * Bounded at `end` — the document carries on past the caret, and rewriting
       * a list marker in a paragraph further down the page would be an edit
       * nobody asked for.
       */
      const authored = (nodes: DocNode[], end: number): DocNode[] => [
        ...nodes.slice(0, from),
        ...asListItems(nodes.slice(from, end)),
        ...nodes.slice(end),
      ];
      const preview = (text: string) => {
        try {
          const nodes = parseDocHtml(ctx.prefix + text);
          return blocksFromMarkup(authored(nodes, nodes.length).slice(written));
        } catch {
          return [];
        }
      };
      /**
       * The completion as ops: the document rebuilt with it spliced in, and the
       * difference taken. Null when there is nothing to do or the batch does
       * not resolve — both of which mean there is no offer to make.
       *
       * Shared by the two things that need it, which no longer happen at the
       * same time: the end of a completion, and a Tab pressed on a diagram that
       * is still being drawn.
       */
      const compileWith = (completion: string): Batch | null => {
        try {
          const ends = parseDocHtml(ctx.prefix + completion).length;
          const next = authored(
            parseDocHtml(ctx.prefix + completion + ctx.suffix),
            ends,
          );
          const current = parseDocHtml(toDocHtml(ctx.blocks));
          const batch = compileDocHtml(next, {
            current,
            anchorBlockId: ctx.cursorBlockId,
          });
          if (!batch.ops.length) return null;
          const resolved = resolveBatch(batch, project(ctx.blocks).index);
          if (!resolved.ok) {
            warnRejected("completion", resolved);
            return null;
          }
          return resolved.batch;
        } catch {
          return null;
        }
      };
      let acc = "";
      let raw = "";
      let lastSig = "";
      let headLitAt = 0;
      try {
        const res = await fetch("/api/complete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            before: ctx.prefix,
            after: ctx.suffix,
            seed: PREAMBLE,
            mode: "html",
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (mySeq !== seq) return;
          raw += value;
          /**
           * Nothing a half-arrived completion does may end it.
           *
           * Everything below draws markup that is malformed by definition — the
           * last tag is usually cut mid-attribute, and a math row is cut
           * mid-command. KaTeX only demotes a ParseError to red text, the canvas
           * parser and the widget builders have refusals of their own, and any
           * one of those throws used to reach the loop's own catch, which reads
           * an exception as the stream having been superseded. A math block
           * therefore died a character before it finished arriving.
           *
           * So a chunk that cannot be drawn is skipped, not fatal: `acc` keeps
           * everything received, and the next chunk draws it with more of the
           * expression present. The stream is only ever ended by the stream.
           */
          try {
            const bounded = firstBlock(raw);
            acc = bounded.text;
            if (bounded.done) break; // the block closed; nothing after it is ours
            // Nobody wants a diagram proposed while someone is still talking —
            // but the words BEFORE the block are still a good completion, and
            // throwing them out with it is what made "the formula is:" followed
            // by a math block flash up and disappear. Keep the prose, drop the
            // block; only a completion that is nothing but a block has nothing
            // left to offer. Same rule the diagram branch below already follows.
            // A table cell holds inline content only, so inside one every block
            // the model opens is cut the same way.
            if ((!limits.allowBlocks || ctx.cell) && isStructural(acc)) {
              const tail = proseTail(acc);
              if (!tail.trim()) return clear();
              acc = tail;
              break;
            }
            // A brief, not a diagram. Show the prose half and a pending chip
            // straight away — the shapes are a second call away, and a suggestion
            // that sits blank for a second reads as one that is not coming.
            const asked = diagramBrief(acc);
            if (asked) {
              setAction(view(), {
                label: "Add diagram",
                batch: null,
                loading: true,
                tail: proseTail(acc),
              });
              if (asked.closed) break;
              continue;
            }
            if (isStructural(acc)) {
              // Draw what has arrived so far. The batch stays null until the
              // stream ends, so Tab queues rather than applying a half-diagram.
              const sig = previewSignature(acc);
              if (sig !== lastSig) {
                lastSig = sig;
                const partial = partialPreview(acc);
                if (partial?.preview) {
                  setAction(view(), {
                    label: partial.label,
                    batch: null,
                    preview: partial.preview,
                    tail: proseTail(acc),
                  });
                } else if (!partial) {
                  // Text so far: the words are the whole of it. A block whose tag
                  // has arrived but whose contents have not shows nothing yet —
                  // a chip standing in for it would be an offer with nothing to
                  // read, which is what the finished version is not allowed to
                  // make either.
                  const blocks = preview(acc);
                  if (blocks.length) {
                    setAction(view(), {
                      batch: null,
                      tail: proseTail(acc),
                      blocks,
                    });
                  }
                }
              }
            } else {
              if (!headLitAt) headLitAt = performance.now();
              // Plain text to insert, raw markup to render.
              setGhost(view(), displayText(acc), true, acc);
              // One clause is all "complete" ever offers; stop paying for more.
              if (displayText(acc).length >= limits.maxChars) break;
            }
          } catch (error) {
            if (process.env.NODE_ENV !== "production") {
              console.warn("[Nootles] completion: chunk not drawn\n  ", error);
            }
            continue;
          }
        }
      } catch (error) {
        // Only the read itself gets here now. An abort is the ordinary way out
        // — a keystroke superseded us — and says nothing.
        if (controller.signal.aborted || mySeq !== seq) return;
        Sentry.captureException(error, { tags: { feature: "tab-completion" } });
        if (process.env.NODE_ENV !== "production") {
          console.warn("[Nootles] completion: stream failed\n  ", error);
        }
        return;
      }
      // We have all we intend to use; stop paying for the rest of the stream.
      controller.abort();
      // Superseded while the stream was finishing. It used to `return` here,
      // which left the half-built suggestion standing: the preview had already
      // been drawn during the stream, but the batch behind it is only attached
      // below — so the chip sat on "Drawing…" for ever, offering something it
      // could no longer produce. Whoever superseded us is drawing their own.
      if (mySeq !== seq) return clear();

      // The in-loop cut again, for a block that closed within its first chunk —
      // `firstBlock` breaks the loop before the cell check ever runs then.
      if (ctx.cell && isStructural(acc)) {
        const tail = proseTail(acc);
        if (!tail.trim()) return clear();
        acc = tail;
      }

      // The macro expands: the shapes land exactly where the element stood, so
      // every line below this one treats the completion as though the model had
      // written the diagram itself. The prose half comes along unchanged, which
      // is what keeps "Here's the pipeline:" and the diagram one suggestion.
      const asked = diagramBrief(acc);
      if (asked) {
        const brief = asked.brief.trim();
        if (!brief) return clear();
        const tail = proseTail(acc);
        // Said straight away, because the element usually arrives whole in one
        // chunk — `firstBlock` sees it close and breaks the loop before the
        // chip above ever runs, and the shapes are a second call behind. Left
        // to the first preview, the suggestion would sit blank for that second.
        setAction(view(), {
          label: "Add diagram",
          batch: null,
          loading: true,
          tail,
        });
        const page = ctx.visible.slice(-AI.diagram.contextChars);
        /**
         * Puts a half-drawn diagram into the document and says where it landed,
         * so the rest of the stream has somewhere to go. The same expansion the
         * finished version does — the shapes replace the element, and the
         * compiler works out the ops — only sooner.
         */
        const place = (drawn: string): string | null => {
          const batch = compileWith(acc.slice(0, asked.at) + drawn);
          if (!batch) return null;
          shown = shownState("Add diagram");
          return canvasIdOf(batch, applyNow(batch));
        };
        const html = await buildDiagram(brief, page, tail, mySeq, place);
        if (html === null) return;
        // Nothing worth drawing, or nothing that parsed. Either way there is no
        // honest offer to make.
        if (!html) return clear();
        acc = acc.slice(0, asked.at) + html;
      }

      // "complete" only keeps what could have been read off the page: a
      // continuation reusing its vocabulary, or the ending of the word being
      // typed. Ungrounded guesses measured 0.00 overlap and ran 2-3x longer,
      // and during a meeting they are pure noise.
      if (limits.minGrounding > 0) {
        acc = firstClause(acc, limits.maxChars);
        // Mid-word, the only genuinely inferable part is the rest of that word.
        // The model volunteers a whole clause after it — "y window will need to
        // be widened" — and judging that clause as a unit threw away the one
        // piece that was certain. Take the word, drop the speculation.
        if (ctx.midWord) {
          const head = displayText(acc).match(/^\S+/)?.[0] ?? "";
          acc = head;
        }
        const shown = displayText(acc);
        if (!shown.trim()) return clear();
        const finishesAWord = !/\s/.test(shown.trim());
        if (!finishesAWord && grounding(ctx.visible, shown) < limits.minGrounding) {
          return clear();
        }
      }

      // Plain prose — no markup at all — is the fast path: the ghost text IS
      // the insertion, so accepting is a plain insertText.
      if (!isStructural(acc) && !hasMarkup(acc)) {
        // Drop the live edge once the stream stops, but never before the head
        // has been visible long enough to see.
        if (acc.trim()) {
          const text = displayText(acc);
          const lit = headLitAt ? performance.now() - headLitAt : Infinity;
          const settle = () => {
            if (mySeq === seq) setGhost(view(), text, false, acc);
          };
          if (lit >= AI.timing.minStreamHeadMs) settle();
          else setTimeout(settle, AI.timing.minStreamHeadMs - lit);
          shown = shownState("prose");
        }
        return;
      }

      // Everything else goes through the compiler: rebuild the document with the
      // completion spliced in and let it work out which ops that implies. That
      // includes prose carrying only inline marks — it does not open a block, but
      // `<strong>` still has to become bold rather than five literal characters.
      try {
        const compiled = compileWith(acc);
        if (!compiled) return clear();
        const resolved = { batch: compiled };
        if (!isStructural(acc)) {
          // Inline marks only. Still prose to the reader: ghost text, no chip and
          // no preview — but Tab applies the compiled batch, so the marks land.
          shown = shownState("prose+marks");
          // Raw markup: the tail renders it, and Tab applies the batch.
          setAction(view(), { batch: resolved.batch, tail: acc });
          return;
        }
        // Blocks with chrome of their own are described from the batch, whose
        // positions are the ones the applier will use.
        const described = describe(resolved.batch);
        if (described?.preview) {
          shown = shownState(described.label);
          setAction(view(), {
            label: described.label,
            batch: resolved.batch,
            preview: described.preview,
            tail: proseTail(acc),
          });
          return;
        }
        // Everything else is text. It shows as ghost text at the caret, and Tab
        // applies the batch — so the structure still lands, the reader just is
        // not shown a rendering of some words they can already read. Nothing to
        // show at all means nothing to offer: a Tab that does something
        // unannounced is what the rule exists to prevent.
        const blocks = preview(acc);
        if (!blocks.length) return clear();
        shown = shownState("text");
        setAction(view(), { batch: resolved.batch, tail: proseTail(acc), blocks });
      } catch (error) {
        // Never silently. A throw anywhere in here — the compiler, `describe`,
        // or KaTeX, whose `throwOnError: false` suppresses a ParseError and
        // nothing else — used to come out as the suggestion appearing and then
        // vanishing, with no way to tell which of them had failed or why. The
        // clear still happens; it just says so first.
        if (process.env.NODE_ENV !== "production") {
          console.warn(
            "[Nootles] completion: dropped while previewing\n  ",
            error,
            "\n  completion was:",
            acc,
          );
        }
        clear();
      }
    };

    const elapsed = (from: number) => Math.round(performance.now() - from);
    const clear = () => {
      shown = null;
      clearSuggestion(view());
    };

    /**
     * The document and selection as of the last real edit.
     *
     * `isSuggestionDispatch()` alone is not enough to recognise our own
     * transactions. It is a depth counter held only for the synchronous span of
     * `view.dispatch`, but `onChange` and `onSelectionChange` fire AFTER the
     * transaction cycle — by which time the counter is back to zero and a
     * suggestion appearing looks exactly like the user typing.
     *
     * It went unnoticed while a suggestion was drawn once, at the end. Drawing
     * one AS IT STREAMS dispatches on every chunk, so a completion now had many
     * chances to be mistaken for an edit and cancel ITSELF: `seq` moved on, the
     * finishing code hit `if (mySeq !== seq) return`, and the half-built
     * suggestion was left on screen with no batch behind it — the chip stuck on
     * "Drawing…" — until the next schedule cleared it.
     *
     * A meta-only transaction changes neither the doc nor the selection, and
     * ProseMirror keeps the same doc node when nothing edits it, so identity is
     * the reliable test where the flag is not.
     */
    let seenDoc: unknown = null;
    let seenSel: { from: number; to: number } | null = null;

    const schedule = () => {
      if (isSuggestionDispatch()) return; // our own suggestion transaction
      // First run paints its own suggestions and calls no model; the lane must
      // not answer over the top of it, nor clear what the guide has drawn.
      if (completionsSuspended()) return;
      const state = view()?.state;
      let docChanged = true;
      if (state) {
        const sel = { from: state.selection.from, to: state.selection.to };
        const same =
          state.doc === seenDoc &&
          seenSel !== null &&
          sel.from === seenSel.from &&
          sel.to === seenSel.to;
        docChanged = state.doc !== seenDoc;
        seenDoc = state.doc;
        seenSel = sel;
        if (same) return; // a suggestion being drawn, not an edit
      }
      checkUndo();
      if (timer) clearTimeout(timer);
      abort?.abort();
      seq++;
      if (shown) {
        const s = shown;
        const reason: DismissReason = docChanged ? "typed-through" : "cursor-moved";
        defer(() => {
          void logOutcome(s, "dismissed", { dismissReason: reason }).catch(
            () => {},
          );
        });
      }
      shown = null;
      const mySeq = seq;
      // onChange fires inside the editor's transaction cycle; dispatching
      // another transaction synchronously from here re-enters rendering.
      defer(() => {
        if (mySeq === seq) clearSuggestion(view());
      });
      timer = setTimeout(() => void run(mySeq), AI.modes[mode].debounceMs);
    };

    const unsubChange = editor.onChange(schedule, false);
    const unsubSelection = editor.onSelectionChange(schedule, false);

    return () => {
      unsubChange?.();
      unsubSelection?.();
      if (timer) clearTimeout(timer);
      abort?.abort();
      // The one thing that stops a diagram the user already accepted: there is
      // no editor left to write the rest of it into.
      liveAbort?.abort();
      if (shown) {
        const s = shown;
        shown = null;
        void logOutcome(s, "superseded").catch(() => {});
      }
      setActionApplyHandler(null);
      setGhostAcceptHandler(null);
      setDismissHandler(null);
    };
  }, [editor, pageId, title, mode, docId]);
}
