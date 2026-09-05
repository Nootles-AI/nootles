import type {
  NmlBlock,
  NmlInlineContent,
  NmlMark,
  NmlMediaSource,
} from "@/app/lib/nml/schema";

/**
 * NML blocks into the BlockNote blocks the editor actually inserts.
 *
 * Deliberately not an HTML round-trip. NML serializes to its own canonical tags
 * (`nt-code-block`, `nt-math-block`), and teaching BlockNote's HTML parser to
 * read them is the ProseMirror View Bridge's job — step 6 of the NML plan, not
 * yet built. Compiling to the same `PartialBlock` shapes the AI applier already
 * uses (`app/lib/ai/apply.ts`) needs no bridge and keeps the import on the one
 * operation vocabulary: these are the blocks a person's own typing produces.
 *
 * The mapping is close to one-to-one because NML's block vocabulary was derived
 * from this editor's. Where it is not, the difference is named below.
 */

type Styles = Partial<Record<NmlMark, boolean>>;
type BNText = { type: "text"; text: string; styles: Styles };
type BNInline =
  | BNText
  | { type: "math"; props: { latex: string } }
  | { type: "pageMention"; props: { pageId: string; title: string } }
  | { type: "link"; href: string; content: BNText[] };

// BlockNote's block type is invariant in its schema; the applier makes the same
// hop for the same reason.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPartialBlock = any;

const styled = (text: string, marks: readonly NmlMark[]): BNText => ({
  type: "text",
  text,
  styles: Object.fromEntries(marks.map((mark) => [mark, true])),
});

function inline(content: NmlInlineContent): BNInline[] {
  return content.map((node) => {
    if (node.type === "text") return styled(node.text, node.marks);
    if (node.type === "math") return { type: "math", props: { latex: node.latex } };
    if (node.type === "pageRef") {
      return { type: "pageMention", props: { pageId: node.pageId, title: node.fallbackTitle } };
    }
    return {
      type: "link",
      href: node.href,
      content: node.content.map((run) => styled(run.text, run.marks)),
    };
  });
}

/**
 * A resolved media source: the permanent URL the rehost gave back, keyed by the
 * block id the converter minted. A block whose file could not be copied is
 * absent here and keeps its caption without a picture.
 */
export type ResolvedMedia = ReadonlyMap<string, string>;

export function toBlockNote(blocks: NmlBlock[], media: ResolvedMedia): AnyPartialBlock[] {
  return blocks.map((block) => one(block, media)).filter((block) => block !== null);
}

function one(block: NmlBlock, media: ResolvedMedia): AnyPartialBlock | null {
  const children = block.children.length ? { children: toBlockNote(block.children, media) } : {};

  switch (block.type) {
    case "paragraph":
    case "quote":
      return { type: block.type, content: inline(block.content), ...children };
    case "heading":
      // BlockNote heads at three levels; NML allows six because canonical
      // documents may hold imported ones. Deeper headings clamp rather than
      // disappear — a level-5 heading is still a heading.
      return {
        type: "heading",
        props: { level: Math.min(block.props.level, 3) },
        content: inline(block.content),
        ...children,
      };
    case "bulletListItem":
    case "numberedListItem":
    case "toggleListItem":
      return { type: block.type, content: inline(block.content), ...children };
    case "checkListItem":
      return {
        type: "checkListItem",
        props: { checked: block.props.checked ?? false },
        content: inline(block.content),
        ...children,
      };
    case "codeBlock":
      return { type: "codeBlock", props: { language: block.props.language, code: block.code } };
    case "mathBlock":
      // The block holds one string; NML holds addressable rows. Newline is the
      // row separator on both sides, which is how the applier writes it too.
      return { type: "mathBlock", props: { source: block.rows.map((row) => row.latex).join("\n") } };
    case "divider":
      return { type: "divider" };
    case "table":
      return {
        type: "table",
        content: {
          type: "tableContent",
          columnWidths: block.columns.map(() => undefined),
          ...(block.props.headerRows ? { headerRows: block.props.headerRows } : {}),
          rows: block.rows.map((row) => ({ cells: row.cells.map((cell) => inline(cell.content)) })),
        },
      };
    case "image":
    case "video":
    case "audio":
    case "file": {
      const url = media.get(block.id) ?? sourceUrl(block.props.source);
      // A media block with no URL at all would render as a broken upload
      // prompt, which reads as something the reader must fix. The caption is
      // the part worth keeping, so it survives as a paragraph.
      if (!url) {
        return block.props.caption
          ? { type: "paragraph", content: [styled(block.props.caption, [])] }
          : null;
      }
      return {
        type: block.type,
        props: {
          url,
          ...(block.props.caption ? { caption: block.props.caption } : {}),
          ...(block.props.name ? { name: block.props.name } : {}),
        },
      };
    }
    default:
      // canvas, album, storyboard and location have no Notion counterpart, so
      // the converter never produces one. Nothing is silently dropped here.
      return null;
  }
}

/** A converter-produced media block always carries a URL source, or none. */
function sourceUrl(source: NmlMediaSource | undefined): string | undefined {
  return source?.kind === "url" ? source.url : undefined;
}
