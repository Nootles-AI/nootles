/**
 * A shape's label as canonical inline markup.
 *
 * A label is almost always plain words, but it may carry two more things: page
 * references — `<nt-ref page="…">Title</nt-ref>` — and bold spans, `<b>…</b>`.
 * The `label` field holds the words ALREADY escaped, with line breaks as
 * literal newlines and any refs and bolds as elements: exactly the substring
 * the serializer writes between the shape's tags. That keeps the round trip
 * byte-exact (`serializeScene(parseScene(html)) === html`) without teaching
 * the scene model a second representation of rich text.
 *
 * Everything that wants the label as something else goes through here: the
 * renderer and the editor read {@link labelRuns}, the layers panel reads
 * {@link labelText}, the parser and the editor's commit read the DOM through
 * {@link labelOfElement}, and anything writing user-typed words into a label
 * goes through {@link textToLabel} so a typed `<` stays a `<`. Nothing renders
 * a label with `innerHTML` — runs become text nodes and elements — so markup
 * this module does not know is shown as the literal text it is, never
 * executed.
 */

export type LabelRun =
  | { kind: "text"; text: string; bold: boolean }
  | { kind: "ref"; pageId: string; title: string };

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Plain words → their place in a label. */
export function textToLabel(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

function escAttr(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ESCAPE[c]);
}

/** A page reference → its place in a label. */
export function refToLabel(pageId: string, title: string): string {
  return `<nt-ref page="${escAttr(pageId)}">${textToLabel(title)}</nt-ref>`;
}

/** Runs → the one canonical string: escaped text, minimal `<b>` pairs. */
export function runsToLabel(runs: readonly LabelRun[]): string {
  let out = "";
  let bold = false;
  for (const run of runs) {
    if (run.kind === "text" && run.text === "") continue;
    const wants = run.kind === "text" && run.bold;
    if (wants !== bold) {
      out += wants ? "<b>" : "</b>";
      bold = wants;
    }
    out += run.kind === "text" ? textToLabel(run.text) : refToLabel(run.pageId, run.title);
  }
  if (bold) out += "</b>";
  return out;
}

/** The named entities {@link textToLabel} writes, read back. */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : '"',
  );
}

const TOKEN = /<nt-ref\b([^>]*)>([\s\S]*?)<\/nt-ref\s*>|<\/?b\s*>/gi;
const PAGE_ATTR = /\bpage\s*=\s*"([^"]*)"/i;

/**
 * A label, read back as runs. `<b>`/`</b>` toggle bold; anything that is not a
 * bold tag or a well-formed ref — which includes markup some other author put
 * there — is words, exactly as typed.
 */
export function labelRuns(label: string): LabelRun[] {
  const out: LabelRun[] = [];
  let bold = 0;
  let last = 0;
  const text = (end: number) => {
    if (end > last) {
      out.push({ kind: "text", text: unescape(label.slice(last, end)), bold: bold > 0 });
    }
  };
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(label); m; m = TOKEN.exec(label)) {
    const token = m[0].toLowerCase();
    if (token.startsWith("<b") || token.startsWith("</b")) {
      text(m.index);
      if (token[1] === "b") bold += 1;
      else if (bold > 0) bold -= 1;
      last = m.index + m[0].length;
      continue;
    }
    const pageId = PAGE_ATTR.exec(m[1] ?? "")?.[1];
    if (pageId === undefined) continue;
    text(m.index);
    out.push({ kind: "ref", pageId: unescape(pageId), title: unescape(m[2]) });
    last = m.index + m[0].length;
  }
  text(label.length);
  return out;
}

/** The label as plain words — a ref reads as its title, bold as its text. */
export function labelText(label: string): string {
  return labelRuns(label)
    .map((run) => (run.kind === "text" ? run.text : run.title))
    .join("");
}

/** Non-canonical spellings of the ref tag, accepted on the way in. */
const REF_TAGS = new Set(["nt-ref", "ref", "page-ref", "mention"]);

/** Elements whose text is not label text under any reading. */
const SKIPPED = new Set(["script", "style", "template"]);

/** Elements whose start implies a line break, as a paste can bring them. */
const BLOCK = new Set(["div", "p", "li"]);

function isBold(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === "b" || tag === "strong") return true;
  // Some engines write `execCommand` bolds as styled spans rather than tags.
  const weight = (el as HTMLElement).style?.fontWeight ?? "";
  return weight === "bold" || Number.parseInt(weight, 10) >= 600;
}

/** The ref an element is, if it is one: the grammar's tag, or the editor's chip. */
function refOf(el: Element): { pageId: string; title: string } | null {
  if (REF_TAGS.has(el.tagName.toLowerCase())) {
    const pageId = el.getAttribute("page");
    return pageId === null ? null : { pageId, title: el.textContent ?? "" };
  }
  const pageId = el.getAttribute("data-page");
  return pageId === null
    ? null
    : { pageId, title: el.getAttribute("data-title") ?? "" };
}

/**
 * An element's inline content → a canonical label: the parser's half of the
 * round trip, and what the editor's commit reads out of its contentEditable.
 * Text is (re-)escaped, refs are kept as elements, bold survives `<b>`,
 * `<strong>` and a bold-styled span alike, `<br>` and block boundaries become
 * newlines, and any other markup a model wrapped the words in is flattened to
 * the words.
 */
export function labelOfElement(root: Element): string {
  const runs: LabelRun[] = [];
  const walk = (node: Node, bold: boolean) => {
    // Numeric, not `Node.TEXT_NODE`: this runs against injected documents in
    // server-side code, where there is no DOM global to read.
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? "";
      if (text) runs.push({ kind: "text", text, bold });
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (SKIPPED.has(tag)) return;
    if (tag === "br") {
      runs.push({ kind: "text", text: "\n", bold });
      return;
    }
    const ref = refOf(el);
    if (ref) {
      runs.push({ kind: "ref", ...ref });
      return;
    }
    if (BLOCK.has(tag) && runs.length > 0) {
      const tail = runs[runs.length - 1];
      if (tail.kind !== "text" || !tail.text.endsWith("\n")) {
        runs.push({ kind: "text", text: "\n", bold });
      }
    }
    const wraps = bold || isBold(el);
    el.childNodes.forEach((child) => walk(child, wraps));
  };
  root.childNodes.forEach((child) => walk(child, false));
  return runsToLabel(runs).trim();
}
