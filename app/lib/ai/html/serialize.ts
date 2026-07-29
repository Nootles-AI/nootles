import { parseCanvas } from "@/app/components/editor/canvas/types";
import type { AnyBlock } from "../projection";
import { MARK_TAGS, type Mark, type Run } from "./grammar";

/**
 * Renders the document into the auto-board HTML grammar — the text the model
 * reads and completes.
 *
 * Code and LaTeX are emitted RAW, not entity-escaped: the parser treats those
 * elements as raw text (the way the HTML spec treats `<script>`), so escaping
 * would only add tokens and give the model something extra to get wrong.
 */

type SerializeOptions = {
  /**
   * The block holding the caret. Used only to centre the window — deliberately
   * NOT emitted as an attribute. Fill-in-the-middle already locates the caret at
   * the prefix/suffix boundary, and a marker attribute is worse than redundant:
   * the model copies it into the blocks it writes, so completions came back
   * carrying a stray `data-cursor="1"`.
   */
  cursorBlockId?: string;
  /** Top-level blocks to include either side of the cursor. */
  window?: number;
  /**
   * The page title, emitted as <title>. It is the strongest single piece of
   * context the model gets — a page called "Intro to Java" should not be
   * completing Python — and it doubles as the file name.
   *
   * Standard element, standard meaning, so nothing new to teach. It is context
   * only: the parser drops it, so a completion can never turn the title into a
   * block. Renaming the page stays a separate operation.
   */
  title?: string;
};

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

/** Escape prose only. Raw-text elements deliberately skip this. */
function esc(text: string): string {
  return text.replace(/[&<>]/g, (c) => ESCAPE[c]);
}

function attr(name: string, value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  return ` ${name}="${String(value).replace(/"/g, "&quot;")}"`;
}

function marksOf(styles: unknown): Mark[] {
  if (!styles || typeof styles !== "object") return [];
  const s = styles as Record<string, unknown>;
  return (Object.keys(MARK_TAGS) as Mark[]).filter((m) => s[m] === true);
}

function runsToHtml(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .map((item) => {
      if (item.type === "text") {
        const marks = marksOf(item.styles);
        let out = esc(String(item.text ?? ""));
        // Innermost first so nesting is stable when parsed back.
        for (const m of marks) out = `<${MARK_TAGS[m]}>${out}</${MARK_TAGS[m]}>`;
        return out;
      }
      if (item.type === "math") {
        const latex = (item.props as { latex?: string } | undefined)?.latex ?? "";
        return `<ab-math>${latex}</ab-math>`;
      }
      if (item.type === "link") {
        const href = String(item.href ?? "");
        return `<a${attr("href", href)}>${runsToHtml(item.content)}</a>`;
      }
      return "";
    })
    .join("");
}

/** Runs (from a parsed completion) back to HTML — used for previews/tests. */
export function runsToHtmlFromRuns(runs: Run[]): string {
  return runs
    .map((r) => {
      if (r.type === "math") return `<ab-math>${r.latex}</ab-math>`;
      let out = esc(r.text);
      for (const m of r.marks ?? []) out = `<${MARK_TAGS[m]}>${out}</${MARK_TAGS[m]}>`;
      return out;
    })
    .join("");
}

function blockToHtml(block: AnyBlock): string {
  const id = attr("id", block.id);
  const inner = runsToHtml(block.content);

  switch (block.type) {
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(block.props.level ?? 2)));
      return `<h${level}${id}>${inner}</h${level}>`;
    }
    case "quote":
      return `<blockquote${id}>${inner}</blockquote>`;
    case "divider":
      return `<hr${id}>`;
    case "image":
      // alt, not a caption element: the model's job is to know what the picture
      // is, and alt says that in the one place every model already looks.
      return `<img${id}${attr("src", String(block.props.url ?? ""))}${attr(
        "alt",
        String(block.props.caption ?? block.props.name ?? ""),
      )}>`;
    case "video":
    case "audio":
      return `<${block.type}${id}${attr("src", String(block.props.url ?? ""))}${attr(
        "title",
        String(block.props.caption ?? block.props.name ?? ""),
      )}></${block.type}>`;
    case "file":
      // The one construct here with no standard element: `<a download>` is a
      // link inside prose, not a block sitting in the document.
      return `<ab-file${id}${attr("href", String(block.props.url ?? ""))}${attr(
        "name",
        String(block.props.name ?? ""),
      )}>${esc(String(block.props.caption ?? ""))}</ab-file>`;
    case "table": {
      // Standard elements with the right meaning, so nothing to teach: a header
      // row is <th>, everything else <td>. BlockNote marks headers with a
      // `headerRows` count, which the parser turns back into this.
      const content = block.content as
        | { rows?: Array<{ cells?: unknown[] }>; headerRows?: number }
        | undefined;
      const headerRows = Number(content?.headerRows ?? 0);
      const rows = (content?.rows ?? [])
        .map((row, r) => {
          const tag = r < headerRows ? "th" : "td";
          const cells = (row.cells ?? [])
            .map((cell) => `<${tag}>${runsToHtml(cell)}</${tag}>`)
            .join("");
          return `\n  <tr>${cells}</tr>`;
        })
        .join("");
      return `<table${id}>${rows}\n</table>`;
    }
    case "codeBlock": {
      const lang = String(block.props.language ?? "plaintext");
      // Raw, unescaped — the parser reads this element as raw text.
      return `<ab-code-block${id}${attr("lang", lang)}>${String(
        block.props.code ?? "",
      )}</ab-code-block>`;
    }
    case "mathBlock": {
      const source = String(block.props.source ?? "");
      const rows = source.length ? source.split("\n") : [""];
      const lines = rows.map((r) => `\n  <ab-math-line>${r}</ab-math-line>`).join("");
      return `<ab-math-block${id}>${lines}\n</ab-math-block>`;
    }
    case "canvas": {
      const { nodes, edges } = parseCanvas(String(block.props.data ?? ""));
      const nodeHtml = nodes
        .map(
          (n) =>
            `\n  <ab-node${attr("id", n.id)}${attr(
              "shape",
              String(n.data?.shape ?? "rectangle"),
            )}${attr("x", Math.round(n.position?.x ?? 0))}${attr(
              "y",
              Math.round(n.position?.y ?? 0),
            )}>${esc(String(n.data?.label ?? ""))}</ab-node>`,
        )
        .join("");
      const edgeHtml = edges
        .map((e) => {
          const label = typeof e.label === "string" ? e.label : "";
          return `\n  <ab-edge${attr("from", e.source)}${attr("to", e.target)}${attr(
            "label",
            label,
          )}></ab-edge>`;
        })
        .join("");
      return `<ab-diagram${id}>${nodeHtml}${edgeHtml}\n</ab-diagram>`;
    }
    case "paragraph":
      return `<p${id}>${inner}</p>`;
    default:
      // A block type the grammar has no tag for. Emitted opaque and named
      // rather than as an empty <p>: an empty paragraph reads as a gap to fill,
      // and the model duly filled it, which the validator then rejected — and
      // it rejected the whole batch, so good edits beside it died too. This
      // keeps the block's position visible while denying authorship of it.
      return `<ab-block${id}${attr("type", block.type)}></ab-block>`;
  }
}

/** Which list element a block belongs in, or null if it isn't a list item. */
function listTagFor(type: string): "ul" | "ol" | null {
  if (type === "bulletListItem" || type === "checkListItem") return "ul";
  if (type === "numberedListItem") return "ol";
  return null;
}

function listItemHtml(block: AnyBlock): string {
  const id = attr("id", block.id);
  const box =
    block.type === "checkListItem"
      ? `<input type="checkbox"${block.props.checked ? " checked" : ""}>`
      : "";
  // Nested items live INSIDE the parent <li>, which is how HTML expresses an
  // indented outline — and how the model expects to read and write one.
  const nested = block.children?.length
    ? blocksToHtml(block.children)
    : "";
  return `<li${id}>${box}${runsToHtml(block.content)}${nested}</li>`;
}

/**
 * A toggle is `<details>`/`<summary>` — the standard element for exactly this,
 * so there is nothing to teach. Its children stay INSIDE, which also fixes the
 * old flattening: collapsed content used to serialize as ordinary top-level
 * paragraphs, leaving the model unable to tell what was inside the toggle from
 * what merely followed it.
 */
function toggleHtml(block: AnyBlock): string {
  const id = attr("id", block.id);
  const nested = block.children?.length ? `\n${blocksToHtml(block.children)}\n` : "";
  return `<details${id}><summary>${runsToHtml(block.content)}</summary>${nested}</details>`;
}

/** Serializes a sibling list, grouping consecutive items into one <ul>/<ol>. */
function blocksToHtml(blocks: AnyBlock[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === "toggleListItem") {
      out.push(toggleHtml(blocks[i]));
      i++;
      continue;
    }
    const tag = listTagFor(blocks[i].type);
    if (tag) {
      // A list that doesn't begin at 1 says so, the way HTML does.
      const first = Number(blocks[i].props?.start ?? 1);
      const start = tag === "ol" && first > 1 ? attr("start", first) : "";
      const items: string[] = [];
      while (i < blocks.length && listTagFor(blocks[i].type) === tag) {
        items.push(listItemHtml(blocks[i]));
        i++;
      }
      out.push(`<${tag}${start}>${items.join("")}</${tag}>`);
      continue;
    }
    out.push(blockToHtml(blocks[i]));
    // Children of non-list blocks are un-nested, as BlockNote's own HTML
    // export does — HTML has no way to nest a paragraph under a paragraph.
    if (blocks[i].children?.length) {
      out.push(blocksToHtml(blocks[i].children!));
    }
    i++;
  }
  return out.join("\n");
}

function collectIds(block: AnyBlock, out: Set<string>) {
  out.add(block.id);
  for (const c of block.children ?? []) collectIds(c, out);
}

/**
 * A marker placed at the caret before serializing. Chosen so escaping can't
 * touch it (no `&`, `<`, `>`) and prose can't contain it.
 */
const CARET = "\u0001CARET\u0001";

/** Copy of the block tree with a marker run spliced in at the caret. */
function withCaret(
  blocks: AnyBlock[],
  cursorBlockId: string,
  offset: number,
): AnyBlock[] {
  return blocks.map((b) => {
    if (b.id !== cursorBlockId) {
      return b.children?.length
        ? { ...b, children: withCaret(b.children, cursorBlockId, offset) }
        : b;
    }
    // Code and math keep their text in props rather than inline content, and
    // they're void nodes in ProseMirror — the caret is inside CodeMirror or
    // MathLive, not the document. Splitting the prop puts the marker in the
    // right place anyway, so completing inside them is the same FIM call.
    if (b.type === "codeBlock" || b.type === "mathBlock") {
      const key = b.type === "codeBlock" ? "code" : "source";
      const text = String(b.props?.[key] ?? "");
      const cut = Math.max(0, Math.min(offset, text.length));
      return {
        ...b,
        props: { ...b.props, [key]: text.slice(0, cut) + CARET + text.slice(cut) },
      };
    }
    const content = Array.isArray(b.content)
      ? (b.content as Array<Record<string, unknown>>)
      : [];
    const out: Array<Record<string, unknown>> = [];
    let acc = 0;
    let placed = false;
    for (const item of content) {
      const text = item.type === "text" ? String(item.text ?? "") : "";
      if (!placed && item.type === "text" && offset <= acc + text.length) {
        const cut = Math.max(0, offset - acc);
        out.push({ ...item, text: text.slice(0, cut) });
        out.push({ type: "text", text: CARET, styles: {} });
        out.push({ ...item, text: text.slice(cut) });
        placed = true;
      } else {
        out.push(item);
      }
      acc += text.length;
    }
    if (!placed) out.push({ type: "text", text: CARET, styles: {} });
    return { ...b, content: out };
  });
}

/**
 * The document in HTML, split at the caret — the two halves a fill-in-the-middle
 * model needs. Serializing a marked-up copy and splitting the string means
 * nesting, lists and custom elements are handled without special cases.
 *
 * Mid-paragraph the closing `</p>` lands in the suffix, so a prose completion is
 * bare text; at a block boundary the model closes the current element and opens
 * the next, which is exactly how it behaves in code.
 */
export function toDocHtmlSplit(
  blocks: AnyBlock[],
  cursorBlockId: string,
  offset: number,
  opts: SerializeOptions = {},
): { prefix: string; suffix: string } | null {
  const html = toDocHtml(withCaret(blocks, cursorBlockId, offset), {
    ...opts,
    cursorBlockId,
  });
  const i = html.indexOf(CARET);
  if (i === -1) return null;
  return { prefix: html.slice(0, i), suffix: html.slice(i + CARET.length) };
}

export function toDocHtml(
  blocks: AnyBlock[],
  opts: SerializeOptions = {},
): string {
  let visible = blocks;
  if (opts.cursorBlockId && opts.window !== undefined) {
    const center = blocks.findIndex((b) => {
      const ids = new Set<string>();
      collectIds(b, ids);
      return ids.has(opts.cursorBlockId!);
    });
    if (center !== -1) {
      visible = blocks.slice(
        Math.max(0, center - opts.window),
        Math.min(blocks.length, center + opts.window + 1),
      );
    }
  }

  const body = blocksToHtml(visible);
  const title = opts.title?.trim();
  return title ? `<title>${esc(title)}</title>\n${body}` : body;
}
