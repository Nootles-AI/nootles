import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { normalizeDocument, normalizeInline } from "./normalize";
import { NML_SCHEMA_VERSION, type NmlBlock, type NmlDocument, type NmlInlineContent, type NmlListBlock } from "./schema";
import { assertValidDocument } from "./validate";

const MARK_TAG = {
  code: "code",
  bold: "strong",
  italic: "em",
  strike: "s",
  underline: "u",
} as const;

function escText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(value: string): string {
  return escText(value).replace(/"/g, "&quot;");
}

function attr(name: string, value: string | number): string {
  return ` ${name}="${escAttr(String(value))}"`;
}

/**
 * A quoted span of the page, spelled so that a newline or tab in it survives
 * the round trip: HTML normalizes raw line breaks inside attribute values, a
 * character reference it leaves alone.
 */
function quoteAttr(name: string, value: string): string {
  const escaped = escAttr(value).replace(/[\t\n\r]/g, (char) => `&#${char.charCodeAt(0)};`);
  return ` ${name}="${escaped}"`;
}

function optionalAttr(name: string, value: string | number | undefined): string {
  return value === undefined ? "" : attr(name, value);
}

function inlineHtml(content: NmlInlineContent): string {
  return normalizeInline(content)
    .map((node) => {
      if (node.type === "math") return `<nt-math${attr("id", node.id)}>${escText(node.latex)}</nt-math>`;
      if (node.type === "pageRef") {
        return `<nt-ref${attr("id", node.id)}${attr("page-id", node.pageId)}>${escText(node.fallbackTitle)}</nt-ref>`;
      }
      // Always spelled out, never an HTML boolean attribute: the canonical form
      // has to round-trip byte for byte, and "absent" and "false" must not be
      // two ways of writing one state.
      if (node.type === "checkbox") {
        return `<nt-check${attr("id", node.id)}${attr("checked", node.checked ? "true" : "false")}></nt-check>`;
      }
      const text = node.type === "link" ? inlineHtml(node.content) : escText(node.text);
      const marked =
        node.type === "link"
          ? text
          : node.marks.map((mark) => `<${MARK_TAG[mark]}>`).join("") +
            text +
            [...node.marks].reverse().map((mark) => `</${MARK_TAG[mark]}>`).join("");
      return node.type === "link" ? `<a${attr("href", node.href)}>${marked}</a>` : marked;
    })
    .join("");
}

function indent(value: string, depth: number): string {
  const pad = "  ".repeat(depth);
  return value.split("\n").map((line) => (line ? pad + line : line)).join("\n");
}

function withLegacyMarkup(value: string, tag: string, legacyMarkup: string | undefined): string {
  if (legacyMarkup === undefined) return value;
  const close = `</${tag}>`;
  return value.slice(0, -close.length) + `<nt-legacy-markup>${escText(legacyMarkup)}</nt-legacy-markup>${close}`;
}

function blockHtml(block: NmlBlock, depth: number): string {
  const pad = "  ".repeat(depth);
  const children = () => block.children.map((child) => `\n${blockHtml(child, depth + 1)}`).join("");
  switch (block.type) {
    case "paragraph":
      return `${pad}<p${attr("id", block.id)}>${inlineHtml(block.content)}</p>`;
    case "quote":
      return `${pad}<blockquote${attr("id", block.id)}>${inlineHtml(block.content)}</blockquote>`;
    case "heading":
      return `${pad}<h${block.props.level}${attr("id", block.id)}>${inlineHtml(block.content)}</h${block.props.level}>`;
    case "bulletListItem":
    case "numberedListItem":
      throw new Error("List items are serialized by their parent sequence.");
    case "checkListItem":
      throw new Error("List items are serialized by their parent sequence.");
    case "toggleListItem":
      return `${pad}<details${attr("id", block.id)}><summary>${inlineHtml(block.content)}</summary>${children()}\n${pad}</details>`;
    case "table": {
      const columns = block.columns.map((column) => `<col${attr("id", column.id)}>`).join("");
      const rows = block.rows.map((row, rowIndex) => {
        const cellTag = rowIndex < block.props.headerRows ? "th" : "td";
        const cells = row.cells.map((cell) => `<${cellTag}${attr("id", cell.id)}>${inlineHtml(cell.content)}</${cellTag}>`).join("");
        return `${pad}  <tr${attr("id", row.id)}>${cells}</tr>`;
      });
      return `${pad}<table${attr("id", block.id)}${attr("header-rows", block.props.headerRows)}>\n${pad}  <colgroup>${columns}</colgroup>${rows.length ? `\n${rows.join("\n")}` : ""}\n${pad}</table>`;
    }
    case "codeBlock":
      return `${pad}<nt-code-block${attr("id", block.id)}${block.props.language ? attr("language", block.props.language) : ""}>${escText(block.code)}</nt-code-block>`;
    case "mathBlock": {
      const rows = block.rows.map((row) => `${pad}  <nt-math-line${attr("id", row.id)}>${escText(row.latex)}</nt-math-line>`).join("\n");
      return `${pad}<nt-math-block${attr("id", block.id)}>${rows ? `\n${rows}\n${pad}` : ""}</nt-math-block>`;
    }
    case "divider":
      return `${pad}<hr${attr("id", block.id)}>`;
    case "image":
    case "video":
    case "audio":
    case "file": {
      const tag = block.type === "file" ? "nt-file" : block.type === "image" ? "img" : block.type;
      const source = block.props.source;
      const sourceAttrs = !source ? "" : source.kind === "url" ? attr("src", source.url) : attr("storage-id", source.storageId);
      const caption = block.props.caption === undefined ? "" : attr("caption", block.props.caption);
      const name = block.props.name === undefined ? "" : attr("name", block.props.name);
      const open = `${pad}<${tag}${attr("id", block.id)}${sourceAttrs}${caption}${name}>`;
      return tag === "img" ? open : `${open}</${tag}>`;
    }
    case "canvas":
      return indent(serializeScene({ ...block.scene, id: block.id }), depth);
    case "album":
      return indent(withLegacyMarkup(serializeAlbum({ ...block.domain, id: block.id }), "nt-album", block.legacyMarkup), depth);
    case "storyboard":
      return indent(withLegacyMarkup(serializeStoryboard({ ...block.domain, id: block.id }), "nt-storyboard", block.legacyMarkup), depth);
    case "location":
      return indent(withLegacyMarkup(serializeLocation({ ...block.domain, id: block.id }), "nt-location", block.legacyMarkup), depth);
    case "commentThread": {
      const { anchor, status, resolvedBy, resolvedAt, orphanedAt, ambiguous } = block.props;
      const open =
        `${pad}<nt-thread${attr("id", block.id)}${attr("block-id", anchor.blockId)}` +
        `${quoteAttr("exact", anchor.exact)}${quoteAttr("prefix", anchor.prefix)}${quoteAttr("suffix", anchor.suffix)}` +
        `${attr("offset-hint", anchor.offsetHint)}${attr("status", status)}` +
        `${optionalAttr("resolved-by", resolvedBy)}${optionalAttr("resolved-at", resolvedAt)}` +
        `${optionalAttr("orphaned-at", orphanedAt)}${ambiguous ? attr("ambiguous", "true") : ""}>`;
      return `${open}${block.children.length ? `${children()}\n${pad}` : ""}</nt-thread>`;
    }
    case "comment":
      return `${pad}<nt-comment${attr("id", block.id)}${attr("author-id", block.props.authorId)}${attr("created-at", block.props.createdAt)}${optionalAttr("edited-at", block.props.editedAt)}${optionalAttr("via", block.props.via)}>${inlineHtml(block.content)}</nt-comment>`;
    case "notionStub":
      return `${pad}<nt-notion-stub${attr("id", block.id)}${attr("notion-type", block.props.notionType)}${attr("notion-id", block.props.notionId)}${attr("href", block.props.href)}>${escText(block.props.raw)}</nt-notion-stub>`;
  }
}

function blocksHtml(blocks: NmlBlock[], depth: number): string[] {
  const lines: string[] = [];
  for (let index = 0; index < blocks.length; ) {
    const block = blocks[index];
    if (block.type !== "bulletListItem" && block.type !== "numberedListItem" && block.type !== "checkListItem") {
      lines.push(blockHtml(block, depth));
      index++;
      continue;
    }
    const type = block.type;
    const firstIndex = index;
    const tag = type === "numberedListItem" ? "ol" : "ul";
    const kind = type === "checkListItem" ? ` data-kind="check"` : "";
    const start = type === "numberedListItem" && block.props.start !== undefined ? attr("start", block.props.start) : "";
    const pad = "  ".repeat(depth);
    const items: string[] = [];
    while (
      index < blocks.length &&
      blocks[index].type === type &&
      !(type === "numberedListItem" && index > firstIndex && (blocks[index] as NmlListBlock).props.start !== undefined)
    ) {
      const item = blocks[index] as NmlListBlock;
      const nested = blocksHtml(item.children, depth + 2);
      const checked = item.type === "checkListItem" && item.props.checked ? attr("checked", "true") : "";
      items.push(`${pad}  <li${attr("id", item.id)}${checked}>${inlineHtml(item.content)}${nested.length ? `\n${nested.join("\n")}\n${pad}  ` : ""}</li>`);
      index++;
    }
    lines.push(`${pad}<${tag}${kind}${start}>\n${items.join("\n")}\n${pad}</${tag}>`);
  }
  return lines;
}

export function serializeDocument(document: NmlDocument): string {
  const normalized = normalizeDocument(document);
  assertValidDocument(normalized);
  const body = blocksHtml(normalized.blocks, 1);
  const kind = normalized.kind ? attr("kind", normalized.kind) : "";
  const open = `<nt-document${attr("id", normalized.documentId)}${attr("schema-version", NML_SCHEMA_VERSION)}${kind}>`;
  return `${open}${body.length ? `\n${body.join("\n")}\n` : ""}</nt-document>\n`;
}
