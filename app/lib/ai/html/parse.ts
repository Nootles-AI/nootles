import {
  RAW_TEXT_TAGS,
  TAG_TO_MARK,
  type DocNode,
  type Mark,
  type Run,
  type ShapeKind,
} from "./grammar";

/**
 * Parses the auto-board document language back into normalized nodes.
 *
 * The interesting part is how code survives. HTML only starts markup when `<`
 * is followed by a letter, `/`, `!` or `?` — so `i < 10` is already safe — but
 * `Array<string>` or JSX genuinely would be parsed as elements, and reading the
 * element back with `innerHTML` would silently "repair" it into something else.
 *
 * Rather than asking the model to escape (which it will eventually forget), we
 * treat our code and math elements as RAW TEXT, exactly as the HTML spec does
 * for `<script>`/`<style>`/`<textarea>`: their contents are lifted out before
 * the DOM ever sees them, and restored afterwards. The model can then write
 * whatever it likes inside them.
 */

const SHAPES: ShapeKind[] = ["rectangle", "ellipse", "diamond", "text"];

/** Browsers give us DOMParser; tests inject one. */
export type ParseHtml = (html: string) => Document;

const defaultParseHtml: ParseHtml = (html) =>
  new DOMParser().parseFromString(html, "text/html");

/**
 * Lift raw-text element bodies out of the source so the HTML parser can't
 * misread code as markup. Returns the rewritten HTML plus the extracted bodies.
 */
export function extractRawText(html: string): { html: string; raw: string[] } {
  const raw: string[] = [];
  let out = html;
  for (const tag of RAW_TEXT_TAGS) {
    // Non-greedy to the first closing tag — the same rule `</script>` follows.
    const re = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)</${tag}\\s*>`, "gi");
    out = out.replace(re, (_m, attrs: string, body: string) => {
      const i = raw.push(body) - 1;
      return `<${tag}${attrs} data-raw="${i}"></${tag}>`;
    });
  }
  return { html: out, raw };
}

function textOf(el: Element): string {
  return el.textContent ?? "";
}

function rawOf(el: Element, raw: string[]): string {
  const i = el.getAttribute("data-raw");
  if (i === null) return textOf(el);
  const body = raw[Number(i)];
  return body === undefined ? textOf(el) : body;
}

function idOf(el: Element): string | undefined {
  const id = el.getAttribute("id");
  return id ? id : undefined;
}

function num(el: Element, name: string): number | undefined {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Inline children → typed runs, accumulating marks down the tree. */
function runsOf(node: Node, marks: Mark[] = []): Run[] {
  const out: Run[] = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = child.textContent ?? "";
      if (text) out.push({ type: "text", text, ...(marks.length ? { marks: [...marks] } : {}) });
      return;
    }
    if (child.nodeType !== 1) return;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === "ab-math") {
      out.push({ type: "math", latex: textOf(el) });
      return;
    }
    if (tag === "input") return; // checkbox marker, handled by the list item
    // A nested list is structure, not text — it becomes children, so it must not
    // bleed into the parent item's content.
    if (tag === "ul" || tag === "ol") return;
    const mark = TAG_TO_MARK[tag];
    out.push(...runsOf(el, mark && !marks.includes(mark) ? [...marks, mark] : marks));
  });
  // Merge adjacent runs that carry identical marks — keeps output tidy.
  return out.reduce<Run[]>((acc, run) => {
    const prev = acc[acc.length - 1];
    if (
      prev &&
      prev.type === "text" &&
      run.type === "text" &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(run.marks ?? [])
    ) {
      prev.text += run.text;
      return acc;
    }
    acc.push(run);
    return acc;
  }, []);
}

/**
 * HTML is written with indentation and newlines between tags, and models will
 * do the same. Collapse insignificant whitespace the way a browser renders it.
 * Only applied to prose — code and LaTeX go through the raw-text path untouched.
 */
function normalizeRuns(runs: Run[]): Run[] {
  const out = runs.map((r) =>
    r.type === "text" ? { ...r, text: r.text.replace(/\s+/g, " ") } : r,
  );
  const first = out[0];
  if (first?.type === "text") first.text = first.text.replace(/^\s+/, "");
  const last = out[out.length - 1];
  if (last?.type === "text") last.text = last.text.replace(/\s+$/, "");
  return out.filter((r) => r.type !== "text" || r.text.length > 0);
}

function shapeOf(el: Element): ShapeKind {
  const s = (el.getAttribute("shape") ?? "rectangle").toLowerCase() as ShapeKind;
  return SHAPES.includes(s) ? s : "rectangle";
}

function elementToNode(el: Element, raw: string[]): DocNode | null {
  const tag = el.tagName.toLowerCase();
  const id = idOf(el);

  if (/^h[1-6]$/.test(tag)) {
    return {
      type: "heading",
      id,
      level: Math.min(3, Number(tag[1])),
      content: normalizeRuns(runsOf(el)),
    };
  }
  if (tag === "p") return { type: "paragraph", id, content: normalizeRuns(runsOf(el)) };
  if (tag === "blockquote") return { type: "quote", id, content: normalizeRuns(runsOf(el)) };

  if (tag === "li") {
    // Nested <ul>/<ol> inside this item are its children.
    const children = Array.from(el.children)
      .filter((c) => ["ul", "ol"].includes(c.tagName.toLowerCase()))
      .flatMap((list) => elementsToNodes(list, raw));
    const nested = children.length ? { children } : {};

    const checkbox = el.querySelector(':scope > input[type="checkbox"]');
    if (checkbox) {
      return {
        type: "checkListItem",
        id,
        checked: checkbox.hasAttribute("checked"),
        content: normalizeRuns(runsOf(el)),
        ...nested,
      };
    }
    const ordered = el.parentElement?.tagName.toLowerCase() === "ol";
    return {
      type: ordered ? "numberedListItem" : "bulletListItem",
      id,
      content: normalizeRuns(runsOf(el)),
      ...nested,
    };
  }

  if (tag === "ab-code-block" || tag === "pre") {
    const inner = tag === "pre" ? el.querySelector("code") ?? el : el;
    return {
      type: "codeBlock",
      id,
      language: el.getAttribute("lang") ?? "plaintext",
      code: rawOf(inner as Element, raw).replace(/^\n/, "").replace(/\s+$/, ""),
    };
  }

  if (tag === "ab-math-block") {
    const rows = Array.from(el.querySelectorAll("ab-math-line")).map((l) =>
      rawOf(l, raw).trim(),
    );
    return { type: "mathBlock", id, rows: rows.length ? rows : [""] };
  }

  if (tag === "ab-diagram") {
    const nodes = Array.from(el.querySelectorAll("ab-node")).map((n) => ({
      id: idOf(n),
      shape: shapeOf(n),
      label: textOf(n).trim(),
      x: num(n, "x"),
      y: num(n, "y"),
    }));
    const edges = Array.from(el.querySelectorAll("ab-edge"))
      .map((e) => ({
        from: e.getAttribute("from") ?? "",
        to: e.getAttribute("to") ?? "",
        label: e.getAttribute("label") ?? undefined,
      }))
      .filter((e) => e.from && e.to);
    return { type: "canvas", id, nodes, edges };
  }

  return null;
}

/** Container elements we walk through rather than treat as blocks. */
const TRANSPARENT = new Set(["ul", "ol", "div", "section", "article", "body"]);

/** Children of `parent` as document nodes, descending through containers. */
function elementsToNodes(parent: Element, raw: string[]): DocNode[] {
  const out: DocNode[] = [];
  Array.from(parent.children).forEach((el) => {
    if (TRANSPARENT.has(el.tagName.toLowerCase())) {
      out.push(...elementsToNodes(el, raw));
      return;
    }
    const node = elementToNode(el, raw);
    if (node) out.push(node);
  });
  return out;
}

export function parseDocHtml(
  html: string,
  parseHtml: ParseHtml = defaultParseHtml,
): DocNode[] {
  const { html: safe, raw } = extractRawText(html);
  // Wrap explicitly: given a bare fragment, DOM implementations disagree about
  // whether content lands in <body> or at the document root.
  const doc = parseHtml(`<!DOCTYPE html><html><body>${safe}</body></html>`);
  return elementsToNodes(doc.body, raw);
}
