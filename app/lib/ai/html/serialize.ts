import { parseAlbum } from "@/app/components/editor/album/parse";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { parseLocation } from "@/app/components/editor/location/parse";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import type { AnyBlock } from "../projection";
import { MARK_TAGS, type Mark, type Run } from "./grammar";

/**
 * Renders the document into the Nootles HTML grammar — the text the model
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
  /**
   * Collapse path-heavy drawings to an addressed stub —
   * `<nt-diagram drawn="240 shapes" at="blockId:shot"></nt-diagram>` — for
   * reads the model gets. A drawn shot is hundreds of kilobytes of path
   * coordinates it must not spend context on and must never retype; the stub
   * says a picture is here and names where it lives, and `edit_page` redeems
   * the stub for the real shapes before compiling (see clientTools). Only
   * drawings collapse: a hand-built diagram is mostly boxes and words, and
   * those stay inline where the model can read and edit them.
   */
  collapseDrawn?: boolean;
  /** Block ids exempt from the collapse — the model asked to see the shapes. */
  expandDrawn?: ReadonlySet<string>;
};

/**
 * A drawing, as opposed to a diagram: most of its bytes are path data. The
 * cheapest honest test — imported vector art is thousands of `d=` coordinates,
 * where even a sprawling flowchart is mostly words and geometry attributes.
 */
function isDrawn(sceneHtml: string): boolean {
  if (sceneHtml.length < 4_000) return false;
  let dBytes = 0;
  for (const m of sceneHtml.matchAll(/ d="[^"]*"/g)) dBytes += m[0].length;
  return dBytes > sceneHtml.length / 2;
}

function drawnStub(sceneHtml: string, blockId: string, at: string): string {
  const shapes = (sceneHtml.match(/<nt-[a-z]/g) ?? []).length - 1;
  // The importer names each drawing's group after its brief's opening clause;
  // quoting that here tells the model what a picture it cannot see SHOWS —
  // which is what lets it fill a board's missing shots in the same world.
  const name = /<nt-group[^>]*\bname="([^"]*)"/.exec(sceneHtml)?.[1];
  const drawn = `${name ? `${name} — ` : ""}${shapes} shapes`;
  return `<nt-diagram${attr("id", blockId)} drawn="${drawn}"${attr("at", at)}></nt-diagram>`;
}

/** A stub coming back in the model's own HTML — the `at` names the picture. */
const DRAWN_STUB = /<nt-diagram\b[^>]*\bat="([^"]+)"[^>]*>\s*<\/nt-diagram\s*>/gi;

function findBlock(blocks: AnyBlock[], id: string): AnyBlock | null {
  for (const b of blocks) {
    if (b.id === id) return b;
    const hit = b.children?.length ? findBlock(b.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/**
 * The collapse, run backwards: every stub in the model's HTML is redeemed for
 * the picture it stands for, read from the live document the stub was minted
 * against. A returned stub therefore compiles to "the picture, unchanged" —
 * or "the picture, moved here" — without the shapes ever having crossed the
 * model's context. An address that no longer resolves (the block or shot went
 * away since the read) is reported, not guessed at.
 */
export function redeemDrawnStubs(
  html: string,
  blocks: AnyBlock[],
): { html: string; missing: string[] } {
  const missing: string[] = [];
  const out = html.replace(DRAWN_STUB, (whole, at: string) => {
    const colon = at.lastIndexOf(":");
    const shot = colon >= 0 ? Number(at.slice(colon + 1)) : NaN;
    const blockId = Number.isInteger(shot) ? at.slice(0, colon) : at;
    const block = findBlock(blocks, blockId);
    if (block?.type === "storyboard" && Number.isInteger(shot)) {
      const scene = parseStoryboard(String(block.props.data ?? "")).shots[shot]?.scene;
      if (scene) return scene;
    } else if (block?.type === "canvas" && !Number.isInteger(shot)) {
      return serializeScene({
        ...migrateLegacyCanvas(String(block.props.data ?? "")),
        id: block.id,
      });
    }
    missing.push(at);
    return whole;
  });
  return { html: out, missing };
}

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

export function runsToHtml(content: unknown): string {
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
        return `<nt-math>${latex}</nt-math>`;
      }
      if (item.type === "pageMention") {
        const props = item.props as { pageId?: string; title?: string } | undefined;
        return `<nt-ref${attr("page", props?.pageId)}>${esc(props?.title ?? "")}</nt-ref>`;
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
      if (r.type === "math") return `<nt-math>${r.latex}</nt-math>`;
      if (r.type === "pageRef") {
        return `<nt-ref${attr("page", r.pageId)}>${esc(r.title)}</nt-ref>`;
      }
      if (r.type === "link") {
        return `<a${attr("href", r.href)}>${runsToHtmlFromRuns(r.content)}</a>`;
      }
      let out = esc(r.text);
      for (const m of r.marks ?? []) out = `<${MARK_TAGS[m]}>${out}</${MARK_TAGS[m]}>`;
      return out;
    })
    .join("");
}

function blockToHtml(block: AnyBlock, opts: SerializeOptions): string {
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
      return `<nt-file${id}${attr("href", String(block.props.url ?? ""))}${attr(
        "name",
        String(block.props.name ?? ""),
      )}>${esc(String(block.props.caption ?? ""))}</nt-file>`;
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
            // BlockNote wraps each cell in a `tableCell` around its runs; the
            // bare run list is what the applier writes on insert, and what
            // older documents hold.
            .map((cell) => {
              const runs = Array.isArray(cell) ? cell : (cell as { content?: unknown })?.content;
              return `<${tag}>${runsToHtml(runs)}</${tag}>`;
            })
            .join("");
          return `\n  <tr>${cells}</tr>`;
        })
        .join("");
      return `<table${id}>${rows}\n</table>`;
    }
    case "codeBlock": {
      const lang = String(block.props.language ?? "plaintext");
      // Raw, unescaped — the parser reads this element as raw text.
      return `<nt-code-block${id}${attr("lang", lang)}>${String(
        block.props.code ?? "",
      )}</nt-code-block>`;
    }
    case "mathBlock": {
      const source = String(block.props.source ?? "");
      const rows = source.length ? source.split("\n") : [""];
      const lines = rows.map((r) => `\n  <nt-math-line>${r}</nt-math-line>`).join("");
      return `<nt-math-block${id}>${lines}\n</nt-math-block>`;
    }
    case "canvas": {
      // The block stores this grammar, so there is nothing to translate — only
      // the block's own id to put on it, which is how the compiler tells an
      // edit of this diagram from a new one. Documents written before the
      // canvas stored HTML come through the migrator on the way past.
      const scene = serializeScene({
        ...migrateLegacyCanvas(String(block.props.data ?? "")),
        id: block.id,
      });
      if (opts.collapseDrawn && !opts.expandDrawn?.has(block.id) && isDrawn(scene)) {
        return drawnStub(scene, block.id, block.id);
      }
      return scene;
    }
    case "album":
      // As with the diagram above: the block stores this grammar, so only its
      // id has to be put on the way past.
      return serializeAlbum({
        ...parseAlbum(String(block.props.data ?? "")),
        id: block.id,
      });
    case "location":
      // As with the album: the block stores this grammar, so only its own id
      // has to be put on the way past.
      return serializeLocation({
        ...parseLocation(String(block.props.data ?? "")),
        id: block.id,
      });
    case "storyboard": {
      // And again. The board's own id is the block's; the shots inside carry
      // none, because a shot is addressed by its position — it is shot three,
      // and it stays shot three however it is written down.
      const board = parseStoryboard(String(block.props.data ?? ""));
      const shots =
        opts.collapseDrawn && !opts.expandDrawn?.has(block.id)
          ? board.shots.map((shot, i) =>
              shot.scene && isDrawn(shot.scene)
                ? { ...shot, scene: drawnStub(shot.scene, "", `${block.id}:${i}`) }
                : shot,
            )
          : board.shots;
      return serializeStoryboard({ ...board, shots, id: block.id });
    }
    case "paragraph":
      return `<p${id}>${inner}</p>`;
    default:
      // A block type the grammar has no tag for. Emitted opaque and named
      // rather than as an empty <p>: an empty paragraph reads as a gap to fill,
      // and the model duly filled it, which the validator then rejected — and
      // it rejected the whole batch, so good edits beside it died too. This
      // keeps the block's position visible while denying authorship of it.
      return `<nt-block${id}${attr("type", block.type)}></nt-block>`;
  }
}

/** Which list element a block belongs in, or null if it isn't a list item. */
function listTagFor(type: string): "ul" | "ol" | null {
  if (type === "bulletListItem" || type === "checkListItem") return "ul";
  if (type === "numberedListItem") return "ol";
  return null;
}

function listItemHtml(block: AnyBlock, opts: SerializeOptions): string {
  const id = attr("id", block.id);
  const box =
    block.type === "checkListItem"
      ? `<input type="checkbox"${block.props.checked ? " checked" : ""}>`
      : "";
  // Nested items live INSIDE the parent <li>, which is how HTML expresses an
  // indented outline — and how the model expects to read and write one.
  const nested = block.children?.length
    ? blocksToHtml(block.children, opts)
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
function toggleHtml(block: AnyBlock, opts: SerializeOptions): string {
  const id = attr("id", block.id);
  const nested = block.children?.length ? `\n${blocksToHtml(block.children, opts)}\n` : "";
  return `<details${id}><summary>${runsToHtml(block.content)}</summary>${nested}</details>`;
}

/** Serializes a sibling list, grouping consecutive items into one <ul>/<ol>. */
function blocksToHtml(blocks: AnyBlock[], opts: SerializeOptions): string {
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    if (blocks[i].type === "toggleListItem") {
      out.push(toggleHtml(blocks[i], opts));
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
        items.push(listItemHtml(blocks[i], opts));
        i++;
      }
      out.push(`<${tag}${start}>${items.join("")}</${tag}>`);
      continue;
    }
    out.push(blockToHtml(blocks[i], opts));
    // Children of non-list blocks are un-nested, as BlockNote's own HTML
    // export does — HTML has no way to nest a paragraph under a paragraph.
    if (blocks[i].children?.length) {
      out.push(blocksToHtml(blocks[i].children!, opts));
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

/** The run list with a marker run spliced in at the character offset. */
function spliceCaret(
  content: Array<Record<string, unknown>>,
  offset: number,
): Array<Record<string, unknown>> {
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
  return out;
}

/** Where the caret sits inside a table block: which cell, by position. */
export type TableCellRef = { row: number; col: number };

/** Copy of the block tree with a marker run spliced in at the caret. */
function withCaret(
  blocks: AnyBlock[],
  cursorBlockId: string,
  offset: number,
  cell?: TableCellRef,
): AnyBlock[] {
  return blocks.map((b) => {
    if (b.id !== cursorBlockId) {
      return b.children?.length
        ? { ...b, children: withCaret(b.children, cursorBlockId, offset, cell) }
        : b;
    }
    // Code and math keep their text in props rather than inline content, and
    // they're void nodes in ProseMirror — the caret is inside CodeMirror or
    // MathLive, not the document. Splitting the prop puts the marker in the
    // right place anyway, so completing inside them is the same FIM call.
    // A table keeps its text in `content.rows` rather than inline content, so
    // the marker goes into the cell the caret is in — `offset` is within that
    // cell. Without this the marker never serialized and the split came back
    // null, which is why completions were silent inside tables.
    if (b.type === "table") {
      if (!cell) return b;
      const content = b.content as
        | { rows?: Array<{ cells?: unknown[] }> }
        | undefined;
      const rows = (content?.rows ?? []).map((row, r) => {
        if (r !== cell.row) return row;
        const cells = (row.cells ?? []).map((c, i) => {
          if (i !== cell.col) return c;
          // A cell is a bare run list in what the applier writes, or a
          // `tableCell` wrapper in what BlockNote stores.
          const runs = Array.isArray(c)
            ? c
            : ((c as { content?: unknown[] })?.content ?? []);
          const spliced = spliceCaret(
            runs as Array<Record<string, unknown>>,
            offset,
          );
          return Array.isArray(c) ? spliced : { ...(c as object), content: spliced };
        });
        return { ...row, cells };
      });
      return { ...b, content: { ...content, rows } } as AnyBlock;
    }
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
    return { ...b, content: spliceCaret(content, offset) };
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
  cell?: TableCellRef,
): { prefix: string; suffix: string } | null {
  const html = toDocHtml(withCaret(blocks, cursorBlockId, offset, cell), {
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

  const body = blocksToHtml(visible, opts);
  const title = opts.title?.trim();
  return title ? `<title>${esc(title)}</title>\n${body}` : body;
}

/**
 * As much of the document as fits in `maxChars`, cut between top-level blocks.
 *
 * Never inside one, which a cut by characters or by lines cannot promise: a
 * table, a maths block and a diagram each span several lines, and the id that
 * addresses the whole of one is on its opening tag. Handed half a table the
 * model reads it as the table, rewrites it, and the compiler — diffing against
 * the real document — reads the rows it was never shown as rows it deleted
 * (measured: a 12-row table cut after row 4 compiles to setTableRows with 4).
 *
 * A single block over the cap is dropped whole for the same reason.
 */
export function toDocHtmlWithin(
  blocks: AnyBlock[],
  maxChars: number,
  opts: SerializeOptions = {},
): { html: string; dropped: number } {
  const whole = toDocHtml(blocks, opts);
  if (whole.length <= maxChars) return { html: whole, dropped: 0 };

  // Length grows with the number of blocks kept, so the boundary is findable
  // without serializing every prefix.
  let kept = 0;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (toDocHtml(blocks.slice(0, mid), opts).length <= maxChars) {
      kept = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return {
    html: toDocHtml(blocks.slice(0, kept), opts),
    dropped: blocks.length - kept,
  };
}
