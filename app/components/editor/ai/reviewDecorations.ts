import { Plugin, PluginKey } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { HunkKind } from "@/app/lib/ai/review/hunks";
import { tokenDiff } from "@/app/lib/ai/review/textDiff";
import { anchorFor, seats, type Anchor, type Seat, type Where } from "@/app/lib/ai/review/undo";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { runsToHtml } from "@/app/lib/ai/html/serialize";
import {
  disposePreview,
  previewElement,
  previewOf,
  renderInline,
} from "./previewWidgets";

/**
 * The pending change, drawn in the document.
 *
 * Decorations only, and that is not a stylistic preference: a node added to the
 * document would sync through prosemirror-sync to the other tab, land in the
 * undo stack, and be typable. A review is a claim ABOUT the document, not part
 * of it — and every one of these is derived from the session's hunks, so the
 * drawing cannot drift from what accepting or discarding would actually do.
 *
 * React owns the state and pushes it in through a meta transaction, exactly as
 * the completion plugin does; the plugin owns the geometry.
 */

export type ReviewHunk = {
  id: string;
  kind: HunkKind;
  /** Blocks it wrote that were not there before. */
  added: string[];
  /** Blocks it rewrote, paired with the version the checkpoint holds. */
  changed: Array<{ id: string; before: AnyBlock }>;
  /** Blocks it left as they were, somewhere else. */
  moved: string[];
  /** Blocks it deleted, as they were. */
  removed: AnyBlock[];
  /**
   * The page as its own turn found it. Per hunk rather than per page: two turns
   * can be waiting on one page, and each deletion belongs where the checkpoint
   * IT was measured against had it.
   */
  before: AnyBlock[];
  /** The user has since rewritten part of it, so it can no longer be taken back. */
  kept: boolean;
};

export type ReviewSpec = {
  hunks: ReviewHunk[];
  answer: (hunkId: string, answer: "accepted" | "rejected") => void;
} | null;

const META = "ab-review";
export const reviewKey = new PluginKey<State>("ab-review");

type State = { spec: ReviewSpec; decorations: DecorationSet };

export function setReview(view: EditorView, spec: ReviewSpec) {
  const current = reviewKey.getState(view.state);
  if (!current?.spec && !spec) return;
  view.dispatch(view.state.tr.setMeta(META, spec));
}

export function reviewPlugin(): Plugin<State> {
  return new Plugin<State>({
    key: reviewKey,
    state: {
      init: () => ({ spec: null, decorations: DecorationSet.empty }),
      apply(tr, prev): State {
        const meta = tr.getMeta(META) as ReviewSpec | undefined;
        const spec = meta === undefined ? prev.spec : meta;
        // Recomputed rather than mapped whenever the text moves: the inline diff
        // is between the checkpoint and what is on screen NOW, so a keystroke
        // changes which words are marked, not just where they sit.
        if (meta === undefined && !tr.docChanged) return prev;
        if (!spec) return { spec, decorations: DecorationSet.empty };
        return {
          spec,
          decorations: DecorationSet.create(tr.doc, reviewDecorations(tr.doc, spec)),
        };
      },
    },
    props: {
      decorations(state) {
        return reviewKey.getState(state)?.decorations ?? null;
      },
    },
  });
}

type Seated = { node: Node; pos: number };

/** Every block in the document, by id, with the position of its container. */
function blockPositions(doc: Node): Map<string, Seated> {
  const out = new Map<string, Seated>();
  doc.descendants((node, pos) => {
    const id = (node.attrs as { id?: unknown } | undefined)?.id;
    if (typeof id === "string" && node.firstChild) out.set(id, { node, pos });
    return true;
  });
  return out;
}

/**
 * The whole drawing, as a flat list. Pure over (document, spec) so it can be
 * asserted without a browser.
 */
export function reviewDecorations(doc: Node, spec: NonNullable<ReviewSpec>): Decoration[] {
  const at = blockPositions(doc);
  // The same question the undo asks, so the red side is drawn where discarding
  // would put it back — including the case where the change consumed every
  // block at its level and there is nothing left to stand beside.
  const where: Where = {
    present: (id) => at.has(id),
    // The block that ends last, which is the last TOP-LEVEL one: a container
    // encloses its children, so it always outlasts them. The same block the
    // undo's own fallback picks, which is the point of sharing this.
    last: () => {
      let ref: string | null = null;
      let ends = -1;
      for (const [id, seat] of at) {
        const to = seat.pos + seat.node.nodeSize;
        if (to > ends) [ref, ends] = [id, to];
      }
      return ref ? { ref, placement: "after" } : null;
    },
  };
  const decos: Decoration[] = [];
  // Hunks of one turn share a checkpoint, and seating it is a walk of the whole
  // document.
  const placed = new Map<AnyBlock[], Map<string, Seat>>();
  const seatsOf = (before: AnyBlock[]) => {
    const known = placed.get(before);
    if (known) return known;
    const fresh = seats(before);
    placed.set(before, fresh);
    return fresh;
  };

  for (const hunk of spec.hunks) {
    // Where the hunk's own affordance goes: its first surviving block, or —
    // when it only deleted things — the facsimile standing in for them.
    let controls: number | null = null;
    const claim = (pos: number) => {
      if (controls === null || pos < controls) controls = pos;
    };

    for (const id of hunk.added) {
      const seat = at.get(id);
      if (!seat) continue;
      decos.push(blockMark(seat, hunk.kept ? "kept" : "add"));
      claim(seat.pos);
    }

    for (const { id, before } of hunk.changed) {
      const seat = at.get(id);
      if (!seat) continue;
      const inline = hunk.kept ? [] : inlineDiff(seat, before);
      // A block whose own words are marked does not also get a wash — that
      // would be the change said twice, and the second time less precisely.
      // Whole-block is the fallback for the ones with no words to mark: a
      // rewritten diagram, a recompiled code block, a heading that changed
      // level.
      decos.push(blockMark(seat, hunk.kept ? "kept" : inline.length ? "edit" : "whole"));
      decos.push(...inline);
      claim(seat.pos);
    }

    // Nothing inside them changed, so there is nothing to mark up: the claim
    // being made is about where they are.
    for (const id of hunk.moved) {
      const seat = at.get(id);
      if (!seat) continue;
      decos.push(blockMark(seat, hunk.kept ? "kept" : "move"));
      claim(seat.pos);
    }

    if (hunk.removed.length) {
      const place = seatsOf(hunk.before);
      for (const run of removalRuns(hunk.removed, place)) {
        const anchor = anchorFor(run[0].id, place, where);
        const pos = anchorPos(anchor, at);
        if (pos === null) continue;
        const runId = `${hunk.id}:${run[0].id}`;
        decos.push(
          Decoration.widget(pos, () => removedWidget(run), {
            side: anchor?.placement === "before" ? -1 : 1,
            key: `ab-review-gone-${runId}`,
            ...INERT,
            // A removed diagram is drawn by the canvas renderer, so this run
            // may own a React root — the only one of these widgets that can.
            destroy: disposePreview,
          }),
        );
        claim(pos);
      }
    }

    if (controls !== null) {
      decos.push(
        Decoration.widget(controls, () => actionsWidget(hunk, spec), {
          side: -2,
          key: `ab-review-act-${hunk.id}-${hunk.kept ? "kept" : "open"}`,
          ...INERT,
        }),
      );
    }
  }

  return decos;
}

/** Widgets are chrome: never selected, never typed into, never PM's business. */
const INERT = {
  ignoreSelection: true,
  stopEvent: () => true,
} as const;

function blockMark(
  seat: Seated,
  tone: "add" | "edit" | "whole" | "move" | "kept",
): Decoration {
  const content = seat.node.firstChild!;
  const from = seat.pos + 1;
  return Decoration.node(from, from + content.nodeSize, {
    class: `ab-diff ab-diff-${tone}`,
  });
}

function anchorPos(anchor: Anchor | null, at: Map<string, Seated>): number | null {
  if (!anchor) return null;
  const seat = at.get(anchor.ref);
  if (!seat) return null;
  if (anchor.placement === "before") return seat.pos;
  // Inside the block that held it, where its children begin — the same level
  // discarding would put it back at.
  if (anchor.placement === "in") return seat.pos + 1 + seat.node.firstChild!.nodeSize;
  return seat.pos + seat.node.nodeSize;
}

/**
 * Deletions grouped into the runs they formed in the checkpoint, so a fold of
 * six paragraphs reads as one thing removed rather than six.
 */
function removalRuns(removed: AnyBlock[], place: Map<string, Seat>): AnyBlock[][] {
  const seated = removed
    .flatMap((block) => {
      const seat = place.get(block.id);
      return seat ? [{ block, seat }] : [];
    })
    .sort((a, b) => a.seat.index - b.seat.index);

  const runs: AnyBlock[][] = [];
  let last: Seat | null = null;
  for (const { block, seat } of seated) {
    if (!last || last.siblings !== seat.siblings || seat.at !== last.at + 1) runs.push([]);
    runs[runs.length - 1].push(block);
    last = seat;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Inline diff

type CharMap = { text: string; posAt: number[] };

/**
 * The block's text with the document position of every character, so a diff
 * offset becomes a ProseMirror position. Only text counts: an inline maths node
 * occupies a position but contributes no characters, and treating it as one
 * would slide every mark after it along by one.
 */
function charMap(content: Node, start: number): CharMap {
  let text = "";
  const posAt: number[] = [];
  content.forEach((child, offset) => {
    if (!child.isText) return;
    const value = child.text ?? "";
    for (let i = 0; i < value.length; i++) posAt.push(start + offset + i);
    text += value;
  });
  posAt.push(start + content.content.size);
  return { text, posAt };
}

/** The same text, from a checkpoint block rather than from a live node. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((item) => {
      if (item.type === "text") return String(item.text ?? "");
      if (item.type === "link") return textOf(item.content);
      return "";
    })
    .join("");
}

function inlineDiff(seat: Seated, before: AnyBlock): Decoration[] {
  const content = seat.node.firstChild!;
  if (!content.type.spec.content?.includes("inline")) return [];

  const live = charMap(content, seat.pos + 2);
  const parts = tokenDiff(textOf(before.content), live.text);
  if (!parts?.length) return [];

  const decos: Decoration[] = [];
  for (const part of parts) {
    if (part.kind === "same") continue;
    if (part.kind === "add") {
      const from = live.posAt[part.at];
      const to = live.posAt[part.end];
      if (from === undefined || to === undefined || to <= from) continue;
      decos.push(Decoration.inline(from, to, { class: "ab-diff-ins" }));
      continue;
    }
    const pos = live.posAt[part.at];
    if (pos === undefined) continue;
    const text = part.text;
    decos.push(
      Decoration.widget(pos, () => struck(text), {
        side: -1,
        key: `ab-diff-del-${pos}-${text}`,
        ...INERT,
      }),
    );
  }
  return decos;
}

function struck(text: string): HTMLElement {
  const el = document.createElement("del");
  el.className = "ab-diff-del";
  el.textContent = text;
  return el;
}

// ---------------------------------------------------------------------------
// Widgets

/** Marks the shape of a text block the document no longer has. */
const GONE_PREFIX: Record<string, string> = {
  bulletListItem: "•",
  numberedListItem: "—",
  checkListItem: "☐",
  quote: "❝",
};

/**
 * Children and all: `removeBlock` takes a whole subtree, and so does putting one
 * back — a deleted list drawn as one struck line understates what discarding
 * would restore by however deep it went.
 */
function goneBlock(block: AnyBlock): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ab-diff-gone";
  wrap.dataset.type = block.type;

  const preview = previewOf(block);
  if (preview) {
    wrap.appendChild(previewElement(preview, "removed"));
    return wrap;
  }

  const prefix = GONE_PREFIX[block.type];
  if (prefix) {
    const mark = document.createElement("span");
    mark.className = "ab-diff-gone-mark";
    mark.textContent = prefix;
    wrap.appendChild(mark);
  }
  const line = document.createElement("del");
  line.className = "ab-diff-gone-line";
  if (block.type === "heading") {
    line.dataset.level = String(block.props?.level ?? 1);
  }
  const html = runsToHtml(block.content);
  if (html) renderInline(html, line);
  else line.textContent = "empty";
  wrap.appendChild(line);

  if (block.children?.length) {
    const nested = document.createElement("div");
    nested.className = "ab-diff-gone-children";
    for (const child of block.children) nested.appendChild(goneBlock(child));
    wrap.appendChild(nested);
  }
  return wrap;
}

/**
 * Every deleted block, struck through where it stood.
 *
 * A run used to fold itself behind a count once it passed three blocks, on the
 * grounds that a long deletion is a fact rather than something to read. But the
 * question the review asks is whether to put this back, and a count cannot be
 * answered — the one thing a reviewer needs is the words that would return.
 */
function removedWidget(run: AnyBlock[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ab-diff-removed";
  wrap.contentEditable = "false";
  for (const block of run) wrap.appendChild(goneBlock(block));
  return wrap;
}

const ICON = {
  keep: "M20 6 9 17l-5-5",
  discard: "M18 6 6 18M6 6l12 12",
};

function icon(path: string): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const d = document.createElementNS("http://www.w3.org/2000/svg", "path");
  d.setAttribute("d", path);
  svg.appendChild(d);
  return svg;
}

/**
 * Zero height and absolutely positioned, so the answer sits in the margin
 * beside its hunk and the document reads at exactly the width it will keep.
 * Anything that reflowed the text would make reviewing a change change it.
 */
function actionsWidget(hunk: ReviewHunk, spec: NonNullable<ReviewSpec>): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "ab-diff-actions";
  wrap.contentEditable = "false";

  const inner = document.createElement("div");
  inner.className = "ab-diff-actions-inner";

  const button = (
    answer: "accepted" | "rejected",
    label: string,
    path: string,
    tip: string,
  ) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `ab-diff-btn is-${answer === "accepted" ? "keep" : "discard"}`;
    el.title = tip;
    el.setAttribute("aria-label", label);
    el.appendChild(icon(path));
    el.addEventListener("click", () => spec.answer(hunk.id, answer));
    return el;
  };

  inner.appendChild(
    button(
      "accepted",
      hunk.kept ? "Dismiss this change" : "Keep this change",
      ICON.keep,
      hunk.kept ? "You edited this — it stays" : "Keep",
    ),
  );
  // No discard once the user has rewritten it: putting the checkpoint back
  // would throw away their words, and there is no version of this hunk that
  // holds both.
  if (!hunk.kept) {
    inner.appendChild(button("rejected", "Discard this change", ICON.discard, "Discard"));
  }

  wrap.appendChild(inner);
  return wrap;
}
