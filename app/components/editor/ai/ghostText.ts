import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
} from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import katex from "katex";
import type { Batch } from "@/convex/ai/operations";
import {
  canvasHeightFor,
  SHAPE_H,
  SHAPE_W,
} from "@/app/components/editor/canvas/types";

/**
 * The suggestion plugin: at the caret it shows AT MOST ONE suggestion, either
 *  - a "ghost" — inline prose continuation (FIM), accepted by inserting text; or
 *  - an "action" — a hint chip for a structured edit (the planner's compiled op
 *    batch), accepted by applying the batch.
 * Decorations produce no PM steps, so suggestions are local-only and never sync;
 * accepting is what mutates the doc.
 *
 * The plugin renders and holds state; the React controllers drive it via the
 * set/clear helpers. Applying an action needs the BlockNote editor + Convex, so
 * it's delegated to a handler the action controller registers.
 */

export type PreviewNode = {
  tempId: string;
  shape: string;
  label: string;
  x: number;
  y: number;
};
export type PreviewEdge = { source: string; target: string; label?: string };

/** What a suggestion will produce, rendered faded before it is accepted. */
export type Preview =
  | { kind: "code"; language: string; code: string }
  | { kind: "math"; lines: string[] }
  | { kind: "diagram"; nodes: PreviewNode[]; edges: PreviewEdge[] };

export type Suggestion =
  | {
      kind: "ghost";
      /** Plain text — this is what gets inserted on accept. */
      text: string;
      pos: number;
      streaming?: boolean;
      /**
       * The same completion with its inline markup intact, for rendering only.
       * Kept apart from `text` so accepting can never paste a literal `<code>`.
       */
      markup?: string;
    }
  | {
      kind: "action";
      label: string;
      pos: number;
      /**
       * Null while Tier 2 content is still being generated: the chip shows
       * immediately (so the suggestion feels instant) but Tab stays inert until
       * there is something real to apply.
       */
      batch: Batch | null;
      // When present (insertCode), render a faded preview of the block below the
      // line instead of just a chip.
      preview?: Preview;
      /**
       * Prose the completion adds to the current block before opening the new
       * one. A suggestion that finishes "Here's a dia" into "…diagram of the
       * quadratic formula:" and then draws the diagram has to show BOTH halves,
       * or the preview looks like it appeared out of nowhere.
       */
      tail?: string;
    }
  | null;

const META = "ab-suggestion";
export const ghostTextKey = new PluginKey<Suggestion>("ab-suggestion");

// Tab pressed while content was still generating. Rather than do nothing (which
// reads as broken) we remember the intent and apply the moment the batch lands.
let armedAccept = false;

type ActionApply = (batch: Batch) => void;
let actionApplyHandler: ActionApply | null = null;
/** The action controller registers how an accepted action batch is applied+logged. */
export function setActionApplyHandler(fn: ActionApply | null) {
  actionApplyHandler = fn;
  // Teardown (page switch / unmount): drop any queued Tab. Leaving it set would
  // auto-apply the next page's first suggestion without the user asking.
  if (!fn) armedAccept = false;
}

// Showing/clearing a suggestion is a meta-only transaction (no doc/selection
// change). This flag lets the two suggestion controllers ignore those so they
// don't mistake a suggestion appearing for a user edit and clear each other.
let suppressDepth = 0;
export function isSuggestionDispatch(): boolean {
  return suppressDepth > 0;
}
function metaDispatch(view: EditorView, value: Suggestion) {
  suppressDepth++;
  try {
    view.dispatch(view.state.tr.setMeta(META, value));
  } finally {
    suppressDepth--;
  }
}

/** Inline elements the ghost renders for real; anything else is unwrapped. */
const GHOST_TAGS: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  u: "u",
  s: "s",
  code: "code",
};

/**
 * Renders a completion's inline markup into real nodes, so a suggestion looks
 * the way it will look once accepted — bold is bold, `code` wears the code
 * chrome, `<ab-math>` renders through KaTeX.
 *
 * Showing the raw tags instead was the tell that the preview and the accepted
 * result were two different things. Parsing is forgiving by design: mid-stream
 * the last tag is usually incomplete, and the parser simply drops it.
 */
function renderInline(source: string, into: HTMLElement) {
  const body = new DOMParser().parseFromString(
    `<body>${source}</body>`,
    "text/html",
  ).body;

  const walk = (node: Node, parent: HTMLElement) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        parent.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (tag === "ab-math") {
        const span = document.createElement("span");
        try {
          span.innerHTML = katex.renderToString(el.textContent ?? "", {
            throwOnError: false,
          });
        } catch {
          span.textContent = el.textContent ?? "";
        }
        parent.appendChild(span);
        continue;
      }

      const mapped = GHOST_TAGS[tag];
      // Unknown tag: keep its text, drop the wrapper. A half-arrived block tag
      // must never show up as literal angle brackets.
      const next = mapped ? document.createElement(mapped) : parent;
      if (mapped) parent.appendChild(next);
      walk(el, next as HTMLElement);
    }
  };

  walk(body, into);
}

/**
 * `live` = tokens are still arriving, so the head pulses. When false the head
 * stays but goes steady, marking where the caret lands if you press Tab.
 */
function ghostWidget(source: string, live = false) {
  return () => {
    const span = document.createElement("span");
    span.className = "ab-ghost ab-stream-head" + (live ? " is-live" : "");
    renderInline(source, span);
    return span;
  };
}

function chipWidget(label: string, pending: boolean) {
  return () => {
    const span = document.createElement("span");
    span.className = pending ? "ab-action-chip is-pending" : "ab-action-chip";
    span.textContent = pending ? `${label}…` : `⇥ ${label}`;
    return span;
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";
// Match the canvas's real defaults so the preview reads true.
const NODE_W = SHAPE_W;
const NODE_H = SHAPE_H;

function svgEl(name: string, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A faded, to-scale sketch of the diagram that accepting would insert. */
function diagramPreviewWidget(nodes: PreviewNode[], edges: PreviewEdge[]) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = "ab-diagram-preview";
    wrap.contentEditable = "false";
    // Same height the real canvas will take, so accepting doesn't jump.
    wrap.style.height = `${canvasHeightFor(nodes)}px`;

    const head = document.createElement("div");
    head.className = "ab-code-preview-head";
    head.textContent = `⇥ Tab to insert · diagram (${nodes.length} shapes)`;
    wrap.appendChild(head);

    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W;
    const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_H;
    const pad = 24;
    const svg = svgEl("svg", {
      class: "ab-diagram-preview-svg",
      viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
      preserveAspectRatio: "xMidYMid meet",
    });

    // Edges first so shapes sit on top.
    const byId = new Map(nodes.map((n) => [n.tempId, n]));
    for (const e of edges) {
      const a = byId.get(e.source);
      const b = byId.get(e.target);
      if (!a || !b) continue;
      svg.appendChild(
        svgEl("line", {
          class: "ab-diagram-preview-edge",
          x1: a.x + NODE_W / 2,
          y1: a.y + NODE_H / 2,
          x2: b.x + NODE_W / 2,
          y2: b.y + NODE_H / 2,
        }),
      );
    }

    for (const n of nodes) {
      const cx = n.x + NODE_W / 2;
      const cy = n.y + NODE_H / 2;
      if (n.shape === "ellipse") {
        svg.appendChild(
          svgEl("ellipse", {
            class: "ab-diagram-preview-shape",
            cx,
            cy,
            rx: NODE_W / 2,
            ry: NODE_H / 2,
          }),
        );
      } else if (n.shape === "diamond") {
        svg.appendChild(
          svgEl("polygon", {
            class: "ab-diagram-preview-shape",
            points: `${cx},${n.y} ${n.x + NODE_W},${cy} ${cx},${n.y + NODE_H} ${n.x},${cy}`,
          }),
        );
      } else if (n.shape !== "text") {
        svg.appendChild(
          svgEl("rect", {
            class: "ab-diagram-preview-shape",
            x: n.x,
            y: n.y,
            width: NODE_W,
            height: NODE_H,
            rx: 8,
          }),
        );
      }
      const text = svgEl("text", {
        class: "ab-diagram-preview-text",
        x: cx,
        y: cy,
        "text-anchor": "middle",
        "dominant-baseline": "central",
      });
      text.textContent = n.label;
      svg.appendChild(text);
    }

    wrap.appendChild(svg);
    return wrap;
  };
}

function mathPreviewWidget(lines: string[]) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = "ab-math-preview";
    wrap.contentEditable = "false";
    const head = document.createElement("div");
    head.className = "ab-code-preview-head";
    head.textContent = "⇥ Tab to insert · math";
    wrap.appendChild(head);
    for (const latex of lines) {
      const row = document.createElement("div");
      row.className = "ab-math-preview-row";
      row.innerHTML = katex.renderToString(latex, { throwOnError: false });
      wrap.appendChild(row);
    }
    return wrap;
  };
}

function codePreviewWidget(preview: { language: string; code: string }) {
  return () => {
    const wrap = document.createElement("div");
    wrap.className = "ab-code-preview";
    wrap.contentEditable = "false";
    const head = document.createElement("div");
    head.className = "ab-code-preview-head";
    head.textContent = `⇥ Tab to insert · ${preview.language}`;
    const body = document.createElement("pre");
    body.className = "ab-code-preview-body";
    body.textContent = preview.code;
    wrap.appendChild(head);
    wrap.appendChild(body);
    return wrap;
  };
}

export function ghostTextPlugin(): Plugin<Suggestion> {
  return new Plugin<Suggestion>({
    key: ghostTextKey,
    state: {
      init: () => null,
      apply(tr, prev): Suggestion {
        const meta = tr.getMeta(META) as Suggestion | undefined;
        if (meta !== undefined) return meta; // explicit set/clear wins
        if (tr.docChanged) return null; // typing or accepting clears
        if (prev) {
          const sel = tr.selection;
          if (!sel.empty || sel.from !== prev.pos) return null; // caret moved away
        }
        return prev;
      },
    },
    props: {
      decorations(state): DecorationSet | null {
        const s = ghostTextKey.getState(state);
        if (!s) return null;

        if (s.kind === "ghost") {
          if (!s.text) return null;
          return DecorationSet.create(state.doc, [
            Decoration.widget(s.pos, ghostWidget(s.markup ?? s.text, s.streaming), {
              side: 1,
              ignoreSelection: true,
              key: `ab-ghost-${s.pos}-${s.markup ?? s.text}-${s.streaming ? "s" : ""}`,
            }),
          ]);
        }

        const decos: Decoration[] = [];

        // The prose half of the completion, shown at the caret exactly like a
        // plain ghost — the block preview below is the other half of the same
        // suggestion, and Tab accepts them together.
        if (s.tail) {
          decos.push(
            // The tail is the live edge while a block is still generating.
            Decoration.widget(s.pos, ghostWidget(s.tail, !s.batch), {
              side: 1,
              ignoreSelection: true,
              key: `ab-tail-${s.pos}-${s.tail}-${s.batch ? "r" : "s"}`,
            }),
          );
        }

        // With a preview, render a faded version of the real thing just below
        // the line — exactly where accepting will insert it.
        if (s.preview) {
          let after = s.pos;
          try {
            after = state.doc.resolve(s.pos).after();
          } catch {
            after = s.pos;
          }
          const p = s.preview;
          const widget =
            p.kind === "code"
              ? codePreviewWidget(p)
              : p.kind === "math"
                ? mathPreviewWidget(p.lines)
                : diagramPreviewWidget(p.nodes, p.edges);
          const sig =
            p.kind === "code"
              ? p.code.length
              : p.kind === "math"
                ? p.lines.join("|")
                : `${p.nodes.length}-${p.edges.length}`;
          decos.push(
            Decoration.widget(after, widget, {
              side: 1,
              key: `ab-preview-${after}-${p.kind}-${sig}`,
            }),
          );
        } else if (!s.tail) {
          // Only when there is nothing else to show. A chip next to streaming
          // ghost text reads as two competing suggestions rather than one.
          const pending = s.batch === null;
          decos.push(
            Decoration.widget(s.pos, chipWidget(s.label, pending), {
              side: 1,
              ignoreSelection: true,
              key: `ab-chip-${s.pos}-${s.label}-${pending ? "p" : "r"}`,
            }),
          );
        }

        return DecorationSet.create(state.doc, decos);
      },
    },
  });
}

export function currentSuggestion(state: EditorState): Suggestion {
  return ghostTextKey.getState(state) ?? null;
}

export function hasSuggestion(state: EditorState): boolean {
  return !!ghostTextKey.getState(state);
}

export function hasGhost(state: EditorState): boolean {
  return ghostTextKey.getState(state)?.kind === "ghost";
}

/**
 * Show inline prose ghost text at the caret (empty text clears it).
 *
 * Both lanes share this single suggestion slot, and the action lane is much
 * slower (a diagram takes seconds). Without this guard a ghost completion
 * arriving mid-flight silently replaces an action chip or preview, which is why
 * previews appeared only sometimes. Actions win.
 */
export function setGhost(
  view: EditorView,
  text: string,
  streaming = false,
  markup?: string,
) {
  if (ghostTextKey.getState(view.state)?.kind === "action") return;
  const pos = view.state.selection.from;
  metaDispatch(view, text ? { kind: "ghost", text, pos, streaming, markup } : null);
}

/** Show an action suggestion (chip, or a faded preview) carrying its op batch. */
export function setAction(
  view: EditorView,
  label: string,
  batch: Batch | null,
  preview?: Preview,
  tail?: string,
) {
  // The user already hit Tab while this was loading — honour it now rather than
  // making them press it again.
  if (batch && armedAccept) {
    armedAccept = false;
    if (ghostTextKey.getState(view.state)) metaDispatch(view, null);
    actionApplyHandler?.(batch);
    return;
  }
  const pos = view.state.selection.from;
  metaDispatch(view, { kind: "action", label, pos, batch, preview, tail });
}

export function clearSuggestion(view: EditorView) {
  armedAccept = false;
  if (!ghostTextKey.getState(view.state)) return;
  metaDispatch(view, null);
}

/** Accept whichever suggestion is showing. Returns false if there is none. */
export function acceptSuggestion(view: EditorView): boolean {
  const s = ghostTextKey.getState(view.state);
  if (!s) return false;
  if (s.kind === "ghost") {
    if (!s.text) return false;
    const tr = view.state.tr.insertText(s.text, s.pos);
    tr.setSelection(TextSelection.create(tr.doc, s.pos + s.text.length));
    tr.setMeta(META, null);
    view.dispatch(tr);
    return true;
  }
  // Content still generating: remember the Tab and apply as soon as it lands.
  // Consuming the key (true) matters — falling through would indent instead.
  if (!s.batch) {
    armedAccept = true;
    return true;
  }
  // action: clear the chip, then hand the batch to the registered applier.
  const batch = s.batch;
  clearSuggestion(view);
  actionApplyHandler?.(batch);
  return true;
}
