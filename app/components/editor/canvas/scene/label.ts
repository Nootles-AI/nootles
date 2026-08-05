/**
 * A shape's label as canonical inline markup.
 *
 * A label is almost always plain words, but it may carry page references —
 * `<nt-ref page="…">Title</nt-ref>` — so the `label` field holds the words
 * ALREADY escaped, with any refs as elements: exactly the substring the
 * serializer writes between the shape's tags. That keeps the round trip
 * byte-exact (`serializeScene(parseScene(html)) === html`) without teaching the
 * scene model a second representation of rich text.
 *
 * Everything that wants the label as something else goes through here: the
 * renderer and the editor read {@link labelRuns}, the layers panel reads
 * {@link labelText}, and anything writing user-typed words into a label goes
 * through {@link textToLabel} so a typed `<` stays a `<`.
 */

export type LabelRun =
  | { kind: "text"; text: string }
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

export function runsToLabel(runs: LabelRun[]): string {
  return runs
    .map((run) =>
      run.kind === "text"
        ? textToLabel(run.text)
        : refToLabel(run.pageId, run.title),
    )
    .join("");
}

/** The named entities {@link textToLabel} writes, read back. */
function unescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/g, (_, name: string) =>
    name === "amp" ? "&" : name === "lt" ? "<" : name === "gt" ? ">" : '"',
  );
}

const REF = /<nt-ref\b([^>]*)>([\s\S]*?)<\/nt-ref\s*>/gi;
const PAGE_ATTR = /\bpage\s*=\s*"([^"]*)"/i;

/**
 * A label, read back as runs. Anything that is not a well-formed ref — which
 * includes markup some other author put there — is words, exactly as typed.
 */
export function labelRuns(label: string): LabelRun[] {
  const out: LabelRun[] = [];
  let last = 0;
  REF.lastIndex = 0;
  for (let m = REF.exec(label); m; m = REF.exec(label)) {
    const pageId = PAGE_ATTR.exec(m[1])?.[1];
    if (pageId === undefined) continue;
    if (m.index > last) {
      out.push({ kind: "text", text: unescape(label.slice(last, m.index)) });
    }
    out.push({ kind: "ref", pageId: unescape(pageId), title: unescape(m[2]) });
    last = m.index + m[0].length;
  }
  if (last < label.length) {
    out.push({ kind: "text", text: unescape(label.slice(last)) });
  }
  return out;
}

/** The label as plain words — a ref reads as its title. */
export function labelText(label: string): string {
  return labelRuns(label)
    .map((run) => (run.kind === "text" ? run.text : run.title))
    .join("");
}

/** Non-canonical spellings of the ref tag, accepted on the way in. */
const REF_TAGS = new Set(["nt-ref", "ref", "page-ref", "mention"]);

/**
 * An element's inline content → a canonical label. The parser's half of the
 * round trip: text is (re-)escaped, refs are kept as elements, and any other
 * markup a model wrapped the words in is flattened to the words.
 */
export function labelOfElement(el: Element): string {
  let out = "";
  el.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out += textToLabel(child.textContent ?? "");
      return;
    }
    if (child.nodeType !== 1) return;
    const ref = child as Element;
    const page = REF_TAGS.has(ref.tagName.toLowerCase())
      ? ref.getAttribute("page")
      : null;
    out +=
      page === null
        ? labelOfElement(ref)
        : refToLabel(page, ref.textContent ?? "");
  });
  return out.trim();
}
