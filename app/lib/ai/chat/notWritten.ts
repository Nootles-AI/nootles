import type { Dropped } from "../html/parse";

/**
 * What an edit left out, in words the model can act on (NT-95).
 *
 * The parser collects every element and run of words it could not make a block
 * of; this says which ones, by the words they held, and what would have worked
 * instead. Without it, an edit made wholly of such things compiled to nothing
 * and was answered "the page already reads that way", and the model told the
 * user it had made a change that never happened.
 *
 * Returns null when nothing the model meant was left out: an `<nt-block>` is
 * the echo of a block the grammar cannot name, and a `<title>` that repeats the
 * page's own is the context line every read begins with.
 */
export function notWritten(dropped: Dropped[], pageTitle: string): string | null {
  const lines = dropped.flatMap((d) => {
    const line = describe(d, pageTitle.trim());
    return line ? [`- ${line}`] : [];
  });
  return lines.length ? [...new Set(lines)].join("\n") : null;
}

function describe(d: Dropped, pageTitle: string): string | null {
  const said = d.text ? ` ("${d.text}")` : "";
  const id = d.id ? ` id="${d.id}"` : "";
  switch (d.tag) {
    case "nt-block":
      return null;
    case "title":
      if (d.text === pageTitle) return null;
      return `a <title>${said}: edit_page does not rename the page — call rename_page for that.`;
    case "#text":
      return `words standing between blocks${said}: wrap them in <p>.`;
    case "img":
    case "video":
    case "audio":
    case "nt-file":
      return `${a(d.tag)} <${d.tag}> with no ${d.tag === "nt-file" ? "href" : "src"}: a new one needs its source.`;
    case "table":
      return `a <table>${id} with no rows: write its <tr> rows with <th>/<td> cells.`;
    case "figure":
    case "figcaption":
    case "picture":
      return `${a(d.tag)} <${d.tag}>${said}: not a block — write the picture as <img src="…" alt="caption"> on its own.`;
    case "nt-shot":
    case "nt-note":
      return `${a(d.tag)} <${d.tag}>${said} outside a storyboard: a shot goes inside <nt-storyboard>.`;
  }
  if (d.loose) {
    return `words straight inside <${d.tag}${id}>${said}: ${a(d.tag)} <${d.tag}> is not a block — write it as the block it is, e.g. <p${id}>.`;
  }
  if (d.id) {
    return `${a(d.tag)} <${d.tag}${id}>${said}: an id belongs on the block itself — write it as <p${id}>, <h2${id}>… whichever it is.`;
  }
  return `${a(d.tag)} <${d.tag}>${said}: not something a page can hold — write it as <p>, a heading, a list or a table.`;
}

/** The article a tag name takes when read aloud: "an <img>", "an <nt-note>". */
function a(tag: string): string {
  return /^([aeio]|nt-|h\d|li\b)/.test(tag) ? "an" : "a";
}
