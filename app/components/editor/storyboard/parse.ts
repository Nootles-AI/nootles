import { applyOps } from "../canvas/scene/ops";
import { parseScene, type ParseHtml } from "../canvas/scene/parse";
import { serializeScene } from "../canvas/scene/serialize";
import {
  NOTE_TAGS,
  SHOT_TAGS,
  SHOT_W,
  STORYBOARD_TAGS,
  ratioById,
  shotHeight,
  type Ratio,
  type Shot,
  type Storyboard,
} from "./types";

/**
 * Storyboard HTML → {@link Storyboard}.
 *
 * Strict in what the serializer writes, liberal in what this reads — the same
 * bargain the canvas parser makes, and for the same reason: a model writes this
 * format, and `<shot>` where the canonical tag is `<nt-shot>` is a naming
 * preference rather than an error.
 *
 * A shot's canvas is normalised through the canvas's OWN parser and serializer
 * on the way in. That is what keeps the round trip exact without this module
 * having any opinion about scenes: whatever spelling the diagram arrived in, it
 * is stored in the one canonical form, so re-serializing cannot change it.
 */

const defaultParseHtml: ParseHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html");

const matches = (el: Element, tags: readonly string[]) =>
  tags.includes(el.tagName.toLowerCase());

function findRoot(el: Element): Element | null {
  for (const child of Array.from(el.children)) {
    if (matches(child, STORYBOARD_TAGS)) return child;
    const nested = findRoot(child);
    if (nested) return nested;
  }
  return null;
}

/**
 * A shot's canvas, canonical and sized to the board's ratio.
 *
 * The size is imposed rather than read: every shot in a board is the same
 * frame, so a `w`/`h` that disagreed with the ratio would be a second answer to
 * a question the board has already settled — and a model, asked for a 2.39
 * board, will cheerfully write 16:9 boxes.
 */
function sceneOf(el: Element | null, ratio: Ratio, parseHtml: ParseHtml): string {
  if (!el) return "";
  const parsed = parseScene(el.outerHTML, parseHtml);
  if (!parsed.nodes.length && !parsed.edges.length) return "";
  // Scaled into the shot's box, not relabelled to fit it. A drawing arrives in
  // whatever space it was made in — the draw tool asks for double on purpose,
  // and a model told 320 will still hand back 560 — so imposing w/h would leave
  // the picture at a fraction of the frame with the rest empty. The scale op
  // reaches path data and style lengths as well as boxes, which is exactly the
  // difference between a scaled drawing and a broken one.
  const k = parsed.w > 0 ? SHOT_W / parsed.w : 1;
  const scene =
    k === 1
      ? parsed
      : applyOps(parsed, [
          {
            type: "scale",
            ids: parsed.nodes.map((node) => node.id),
            k,
            anchor: { x: 0, y: 0 },
          },
        ]);
  return serializeScene({
    ...scene,
    w: SHOT_W,
    h: shotHeight(ratio),
    // The shot's own frame is the container's to draw, so a stray id or
    // dimension from the source is dropped rather than carried.
    id: undefined,
  });
}

/**
 * A note's text, with `<br>` and block boundaries read as line breaks — the
 * same reading the canvas gives a shape's label, so text pasted from either
 * lands the same way.
 */
function noteOf(el: Element | null): string {
  if (!el) return "";
  const out: string[] = [];
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out.push(child.textContent ?? "");
        return;
      }
      if (child.nodeType !== 1) return;
      const tag = (child as Element).tagName.toLowerCase();
      if (tag === "br") {
        out.push("\n");
        return;
      }
      if (tag === "div" || tag === "p") {
        if (out.length && !out[out.length - 1].endsWith("\n")) out.push("\n");
        walk(child);
        return;
      }
      walk(child);
    });
  };
  walk(el);
  return out.join("").replace(/[ \t]+\n/g, "\n").trim();
}

function shotOf(el: Element, ratio: Ratio, parseHtml: ParseHtml): Shot {
  const diagram = Array.from(el.children).find(
    (c) => c.tagName.toLowerCase() === "nt-diagram",
  );
  const note = Array.from(el.children).find((c) => matches(c, NOTE_TAGS));
  return {
    scene: sceneOf(diagram ?? null, ratio, parseHtml),
    note: noteOf(note ?? null),
  };
}

export function parseStoryboard(
  html: string,
  parseHtml: ParseHtml = defaultParseHtml,
): Storyboard {
  // Wrapped explicitly: given a bare fragment, DOM implementations disagree
  // about whether content lands in <body> or at the document root.
  const doc = parseHtml(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const root = findRoot(doc.body);
  if (!root) return { ratio: ratioById(undefined), shots: [] };

  const ratio = ratioById(root.getAttribute("ratio")?.trim());
  const id = root.getAttribute("id")?.trim();
  const w = Number.parseFloat(root.getAttribute("w") ?? "");
  const cols = Number.parseFloat(root.getAttribute("cols") ?? "");
  const shots = Array.from(root.children)
    .filter((el) => matches(el, SHOT_TAGS))
    .map((el) => shotOf(el, ratio, parseHtml));

  return {
    ratio,
    shots,
    ...(id ? { id } : {}),
    ...(Number.isFinite(w) && w > 0 ? { w: Math.round(w) } : {}),
    ...(Number.isFinite(cols) && cols >= 1 ? { cols: Math.round(cols) } : {}),
  };
}
