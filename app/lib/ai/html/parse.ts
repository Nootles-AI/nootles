import { normalizeLanguage } from "../aiConfig";
import {
  canonicalTag,
  RAW_TEXT_TAGS,
  TAG_TO_MARK,
  type DocNode,
  type Mark,
  type Run,
} from "./grammar";

/**
 * Parses the Nootles document language back into normalized nodes.
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

/**
 * Raw-text bodies bypass the DOM, so entities in them are never decoded. We
 * emit code unescaped and models mostly follow suit, but they sometimes escape
 * out of habit — leaving a literal `&gt;` in the code. Decode the standard few;
 * code that genuinely means the characters `&gt;` is far rarer than code that
 * means `>`.
 */
const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&", // last: so &amp;lt; decodes to &lt; rather than <
};

function decodeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out;
}

function rawOf(el: Element, raw: string[]): string {
  const i = el.getAttribute("data-raw");
  if (i === null) return textOf(el);
  const body = raw[Number(i)];
  return body === undefined ? textOf(el) : decodeEntities(body);
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

/** Schemes that cannot do anything but navigate. */
const SAFE_SCHEME = /^(?:https?|mailto|tel):/;

/**
 * Drops everything a browser skips over while it reads a scheme: the C0 range
 * and space, DEL, and the C1 range.
 *
 * Written as a code-point test rather than a character class on purpose. The
 * escapes for these are the sort of thing that survives being written and then
 * does not survive being edited, and the failure is silent and specific — a
 * class that gains a stray hyphen strips the hyphens out of every url it is
 * handed, and `my-site.com` becomes a host that does not exist.
 */
function withoutControls(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!control) out += ch;
  }
  return out;
}

/**
 * A destination we are willing to make clickable, or null.
 *
 * The model writes these, and every one of them passes through here: the
 * compiler builds page links from what this returns, and the chat renders its
 * links through it too. A `javascript:` url refused at this line cannot reach an
 * anchor anyone could click. Not a theoretical concern — hrefs arrive from
 * whatever the model read, `search_web` included, so a page it summarises is in
 * a position to suggest one.
 *
 * Control characters go before the scheme is read, because `java\tscript:` is a
 * scheme to a browser and a mystery to a regex. What is left is either a scheme
 * we allow, or no scheme at all — a relative path or a fragment, which navigates
 * and nothing more.
 */
export function safeHref(raw: string): string | null {
  const href = withoutControls(raw);
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return SAFE_SCHEME.test(href.toLowerCase()) ? href : null;
  }
  return href;
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
    if (canonicalTag(tag) === "nt-math") {
      out.push({ type: "math", latex: textOf(el) });
      return;
    }
    if (canonicalTag(tag) === "nt-ref") {
      const pageId = (el.getAttribute("page") ?? "").trim();
      // A ref that names no page has no destination to carry — its text is
      // still words the block said, exactly like a link we cannot make.
      if (pageId) out.push({ type: "pageRef", pageId, title: textOf(el) });
      else out.push(...runsOf(el, marks));
      return;
    }
    if (tag === "input") return; // checkbox marker, handled by the list item
    // A nested list is structure, not text — it becomes children, so it must not
    // bleed into the parent item's content.
    if (tag === "ul" || tag === "ol") return;
    if (tag === "a") {
      const href = safeHref(el.getAttribute("href") ?? "");
      const inner = runsOf(el, marks);
      // A link holds text and nothing else. Anything else the model put inside
      // one has no destination to carry, so it stays beside it — an <a> we
      // cannot make a link of is still words the block said.
      const text = inner.filter((r) => r.type === "text");
      if (href && text.length === inner.length) {
        out.push({ type: "link", href, content: text });
        return;
      }
      out.push(...inner);
      return;
    }
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

function elementToNode(el: Element, raw: string[]): DocNode | null {
  const tag = canonicalTag(el.tagName);
  const id = idOf(el);

  if (/^h[1-6]$/.test(tag)) {
    return {
      type: "heading",
      id,
      level: Number(tag[1]),
      content: normalizeRuns(runsOf(el)),
    };
  }
  if (tag === "p") return { type: "paragraph", id, content: normalizeRuns(runsOf(el)) };
  if (tag === "blockquote") return { type: "quote", id, content: normalizeRuns(runsOf(el)) };
  if (tag === "hr") return { type: "divider", id };

  // An unmapped block, echoed back by the model. It is shown one so it can see
  // the block is there; parsing it back would let it author a block the
  // vocabulary cannot name, so it stops here.
  if (tag === "nt-block") return null;

  if (tag === "details") {
    const summary = el.querySelector(":scope > summary");
    const children = Array.from(el.children)
      .filter((c) => c.tagName.toLowerCase() !== "summary")
      .flatMap((c) =>
        TRANSPARENT.has(c.tagName.toLowerCase())
          ? elementsToNodes(c, raw)
          : ([elementToNode(c, raw)].filter(Boolean) as DocNode[]),
      );
    return {
      type: "toggleListItem",
      id,
      content: normalizeRuns(summary ? runsOf(summary) : []),
      ...(children.length ? { children } : {}),
    };
  }

  if (tag === "img" || tag === "video" || tag === "audio" || tag === "nt-file") {
    const type = tag === "nt-file" ? "file" : (tag === "img" ? "image" : tag);
    // No source stated is not an empty source: a model re-captioning an image
    // has no reason to repeat the URL it was shown, and reading the omission as
    // "" would blank the picture. Undefined means the block keeps its source.
    const url = el.getAttribute(tag === "nt-file" ? "href" : "src") || undefined;
    // Without a source there is no media — a bare <img> would otherwise become
    // an empty block sitting in the document. One carrying an id is a different
    // thing: media exists in the document from the moment it is inserted until
    // something is uploaded to it, so dropping those would leave the round trip
    // short of blocks the model was just shown, and a block the round trip
    // loses is one the compiler reads as new and duplicates.
    if (!url && !id) return null;
    const caption =
      el.getAttribute("alt") ??
      el.getAttribute("title") ??
      (tag === "nt-file" ? textOf(el).trim() : "");
    return {
      type: type as "image" | "video" | "audio" | "file",
      id,
      url,
      ...(caption ? { caption } : {}),
      ...(el.getAttribute("name") ? { name: el.getAttribute("name")! } : {}),
    };
  }

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
    const list = el.parentElement;
    const ordered = list?.tagName.toLowerCase() === "ol";
    // `<ol start="4">` numbers from 4. The serializer writes it on the list and
    // reads it back off the item that opens the run, so that is where it goes —
    // without this the attribute is written and never parsed, and a list that
    // does not begin at 1 silently renumbers the moment it is rewritten.
    const start =
      ordered && el === list?.firstElementChild ? num(list, "start") : undefined;
    return {
      type: ordered ? "numberedListItem" : "bulletListItem",
      id,
      ...(start !== undefined ? { start } : {}),
      content: normalizeRuns(runsOf(el)),
      ...nested,
    };
  }

  // Context only — the title is a page field, not a block. Emitted by the
  // serializer, never parsed back.
  if (tag === "title") return null;
  if (tag === "table") {
    const rows: Run[][][] = [];
    let header = false;
    el.querySelectorAll("tr").forEach((tr, r) => {
      const cells: Run[][] = [];
      tr.querySelectorAll("th, td").forEach((cell) => {
        if (cell.tagName.toLowerCase() === "th" && r === 0) header = true;
        cells.push(normalizeRuns(runsOf(cell)));
      });
      if (cells.length) rows.push(cells);
    });
    if (!rows.length) return null;
    return { type: "table", ...(id ? { id } : {}), header, rows };
  }
  if (tag === "nt-code-block" || tag === "pre") {
    const inner = tag === "pre" ? el.querySelector("code") ?? el : el;
    return {
      type: "codeBlock",
      id,
      language: normalizeLanguage(el.getAttribute("lang") ?? undefined),
      code: rawOf(inner as Element, raw).replace(/^\n/, "").replace(/\s+$/, ""),
    };
  }

  if (tag === "nt-math-block") {
    const rows = Array.from(el.querySelectorAll("nt-math-line, math-line")).map((l) =>
      rawOf(l, raw).trim(),
    );
    return { type: "mathBlock", id, rows: rows.length ? rows : [""] };
  }

  // Taken whole. The canvas grammar has its own parser, which the block and the
  // compiler both go through, so re-reading the shapes here would be a second
  // opinion about a document that already has one.
  if (tag === "nt-diagram") return { type: "canvas", id, html: el.outerHTML };

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
