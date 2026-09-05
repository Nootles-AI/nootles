import { NML_LIMITS, NML_SCHEMA_VERSION, type NmlBlock, type NmlInlineContent, type NmlIssue, type NmlDocument } from "@/app/lib/nml/schema";
import { normalizeDocument } from "@/app/lib/nml/normalize";
import { isSafeUrl } from "@/app/lib/nml/validate";
import { convertRichText, type NotionInlineContext } from "./richText";
import { nootlesLanguage } from "./languages";
import {
  booleanAt,
  fileAt,
  notionUrl,
  numberAt,
  payloadOf,
  richTextAt,
  stringAt,
  type NotionBlock,
} from "./types";

/**
 * A file Notion handed us that must be rehosted before it is worth keeping.
 *
 * Notion's own `file` URLs are signed and expire in about an hour, so an import
 * that stored them would be full of broken pictures by lunch. The converter is
 * pure and cannot download anything, so it records the request instead: the
 * import job fetches each one, puts it in Convex storage, and swaps the block's
 * source to `{kind: "storage"}` before the document is ever written.
 */
export type NotionAssetRequest = {
  blockId: string;
  url: string;
  /** True for Notion-hosted files, whose URL dies within the hour. */
  expiring: boolean;
  kind: "image" | "video" | "audio" | "file";
};

/**
 * What a block lost on the way in, kept outside the document.
 *
 * Fidelity that NML v1 cannot hold lives here rather than being thrown away, so
 * a later schema version can upgrade the stub in place through the migration
 * registry — without going back to Notion, whose token may be long gone.
 */
export type NotionLedgerEntry = {
  /** The NML block this became, or the one it was dropped in front of. */
  blockId: string;
  notionId: string;
  notionType: string;
  reason: "stubbed" | "degraded" | "dropped";
  raw: NotionBlock;
};

export type NotionConvertResult = {
  blocks: NmlBlock[];
  diagnostics: NmlIssue[];
  ledger: NotionLedgerEntry[];
  assets: NotionAssetRequest[];
};

export type NotionConvertOptions = {
  createId?: () => string;
  /** Notion page id → Nootles page id, for pages inside the same import set. */
  resolvePage?: (notionPageId: string) => string | undefined;
};

const HEADINGS: Record<string, 1 | 2 | 3> = { heading_1: 1, heading_2: 2, heading_3: 3 };
const LIST_TYPES: Record<string, NmlBlock["type"]> = {
  bulleted_list_item: "bulletListItem",
  numbered_list_item: "numberedListItem",
  to_do: "checkListItem",
  toggle: "toggleListItem",
};
const MEDIA_TYPES: Record<string, NotionAssetRequest["kind"]> = {
  image: "image",
  video: "video",
  audio: "audio",
  file: "file",
  pdf: "file",
};
/** Derived navigation, not content. Nothing of the page is lost by dropping it. */
const NAVIGATION_TYPES = new Set(["table_of_contents", "breadcrumb"]);

const defaultCreateId = () => {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("A cryptographically random createId function is required in this runtime.");
  return id;
};

/**
 * Notion blocks into NML blocks.
 *
 * The shape of this function is dictated by one NML fact: only list items have
 * children (`schema.ts:112`). Everything else is a leaf, so a Notion paragraph
 * or callout carrying children emits itself and then its children as following
 * siblings — the content survives, the nesting does not, and a diagnostic says
 * so rather than letting it happen quietly.
 */
export function convertBlocks(
  blocks: NotionBlock[],
  options: NotionConvertOptions = {},
): NotionConvertResult {
  const createId = options.createId ?? defaultCreateId;
  const resolvePage = options.resolvePage ?? (() => undefined);
  const diagnostics: NmlIssue[] = [];
  const ledger: NotionLedgerEntry[] = [];
  const assets: NotionAssetRequest[] = [];

  const report = (
    code: string,
    path: Array<string | number>,
    message: string,
    severity: NmlIssue["severity"] = "warning",
    nodeId?: string,
  ) => {
    diagnostics.push({ code, severity, path, message, ...(nodeId ? { nodeId } : {}) });
  };
  const inlineCtx: NotionInlineContext = { createId, resolvePage, report };
  const inline = (items: ReturnType<typeof richTextAt>, path: Array<string | number>): NmlInlineContent =>
    convertRichText(items, inlineCtx, path);

  /** The visible placeholder for anything NML cannot hold. */
  const stub = (block: NotionBlock, path: Array<string | number>, why: string): NmlBlock[] => {
    const id = createId();
    ledger.push({ blockId: id, notionId: block.id, notionType: block.type, reason: "stubbed", raw: block });
    report("notion_block_stubbed", path, why, "warning", id);
    return [{
      id,
      type: "quote",
      props: {},
      children: [],
      content: [
        { type: "text", text: "Unsupported Notion block ", marks: ["italic"] },
        { type: "text", text: block.type, marks: ["code"] },
        { type: "text", text: " — ", marks: ["italic"] },
        { type: "link", href: notionUrl(block.id), content: [{ type: "text", text: "open in Notion", marks: ["italic"] }] },
      ],
    }];
  };

  const convertMany = (list: NotionBlock[], path: Array<string | number>, depth: number): NmlBlock[] =>
    list.flatMap((block, index) => convert(block, [...path, index], depth));

  /** Children of a block that cannot hold them, emitted as following siblings. */
  const flattened = (
    block: NotionBlock,
    path: Array<string | number>,
    depth: number,
    reason: string,
  ): NmlBlock[] => {
    const kids = block.children ?? [];
    if (!kids.length) return [];
    report("children_flattened", path, reason, "warning");
    return convertMany(kids, [...path, "children"], depth);
  };

  const convert = (block: NotionBlock, path: Array<string | number>, depth: number): NmlBlock[] => {
    const type = block.type;
    const payload = payloadOf(block);
    const id = createId();

    if (NAVIGATION_TYPES.has(type)) {
      ledger.push({ blockId: id, notionId: block.id, notionType: type, reason: "dropped", raw: block });
      report("navigation_dropped", path, `<${type}> is derived navigation and was not imported.`, "warning");
      return [];
    }

    if (type === "paragraph") {
      return [
        { id, type: "paragraph", props: {}, children: [], content: inline(richTextAt(payload), [...path, "content"]) },
        ...flattened(block, path, depth, "A paragraph cannot hold children in NML; its children follow it."),
      ];
    }

    if (HEADINGS[type]) {
      if (booleanAt(payload, "is_toggleable")) {
        report("toggle_heading_flattened", path, "A toggleable heading became a plain heading; its content follows it.", "warning");
      }
      return [
        { id, type: "heading", props: { level: HEADINGS[type] }, children: [], content: inline(richTextAt(payload), [...path, "content"]) },
        ...flattened(block, path, depth, "A heading cannot hold children in NML; its children follow it."),
      ];
    }

    if (type === "quote" || type === "callout") {
      let content = inline(richTextAt(payload), [...path, "content"]);
      if (type === "callout") {
        const icon = payload.icon;
        const emoji = typeof icon === "object" && icon !== null && "emoji" in icon && typeof icon.emoji === "string" ? icon.emoji : undefined;
        if (emoji) content = [{ type: "text", text: `${emoji} `, marks: [] }, ...content];
        ledger.push({ blockId: id, notionId: block.id, notionType: type, reason: "degraded", raw: block });
        report("callout_as_quote", path, "A callout became a quote; its colour is not represented.", "warning", id);
      }
      return [
        { id, type: "quote", props: {}, children: [], content },
        ...flattened(block, path, depth, `A ${type} cannot hold children in NML; its children follow it.`),
      ];
    }

    if (LIST_TYPES[type]) {
      const kids = block.children ?? [];
      const nests = depth < NML_LIMITS.maxBlockDepth;
      if (kids.length && !nests) {
        report("depth_limit_flattened", path, `Nesting past ${NML_LIMITS.maxBlockDepth} levels was flattened.`, "warning", id);
      }
      const props = type === "to_do" ? { checked: booleanAt(payload, "checked") } : {};
      const item = {
        id,
        type: LIST_TYPES[type],
        props,
        children: nests ? convertMany(kids, [...path, "children"], depth + 1) : [],
        content: inline(richTextAt(payload), [...path, "content"]),
      } as NmlBlock;
      return nests ? [item] : [item, ...convertMany(kids, [...path, "children"], depth)];
    }

    if (type === "code") {
      const language = nootlesLanguage(stringAt(payload, "language"));
      if (!language.mapped) {
        report("code_language_unmapped", path, `Notion language "${stringAt(payload, "language")}" has no Nootles grammar; the block is plain text.`, "warning", id);
      }
      if (richTextAt(payload, "caption").length) {
        report("code_caption_dropped", path, "A code block caption has no representation in NML.", "warning", id);
      }
      return [{
        id,
        type: "codeBlock",
        props: { language: language.id },
        children: [],
        code: richTextAt(payload).map((item) => item.plain_text).join(""),
      }];
    }

    if (type === "equation") {
      return [{
        id,
        type: "mathBlock",
        props: {},
        children: [],
        rows: [{ id: createId(), latex: stringAt(payload, "expression") ?? "" }],
      }];
    }

    if (type === "divider") return [{ id, type: "divider", props: {}, children: [] }];

    if (MEDIA_TYPES[type]) {
      return media(block, payload, id, path, MEDIA_TYPES[type]);
    }

    if (type === "bookmark" || type === "embed" || type === "link_preview") {
      const url = stringAt(payload, "url") ?? "";
      if (!isSafeUrl(url) || !url) return stub(block, path, `A ${type} without a usable URL was stubbed.`);
      const caption = richTextAt(payload, "caption");
      const label = caption.map((item) => item.plain_text).join("") || url;
      ledger.push({ blockId: id, notionId: block.id, notionType: type, reason: "degraded", raw: block });
      report("preview_as_link", path, `A ${type} became a link; the preview card is not represented.`, "warning", id);
      return [{
        id,
        type: "paragraph",
        props: {},
        children: [],
        content: [{ type: "link", href: url, content: [{ type: "text", text: label, marks: [] }] }],
      }];
    }

    if (type === "table") return table(block, payload, id, path);

    if (type === "column_list" || type === "column") {
      const kids = block.children ?? [];
      if (type === "column_list" && kids.length > 1) {
        report("columns_flattened", path, `${kids.length} columns were flattened into sequence; NML has no column layout.`, "warning");
      }
      return convertMany(kids, [...path, "children"], depth);
    }

    if (type === "synced_block") {
      const from = payload.synced_from;
      if (from === null || from === undefined) return convertMany(block.children ?? [], [...path, "children"], depth);
      return stub(block, path, "A synced copy became a link; only the original carries the content.");
    }

    if (type === "child_page" || type === "link_to_page") {
      return [pageLink(block, payload, id, path, type)];
    }

    if (type === "child_database") {
      return stub(block, path, "Notion databases have no NML representation; the block links to the original.");
    }

    return stub(block, path, `<${type}> is not a block NML can hold.`);
  };

  const media = (
    block: NotionBlock,
    payload: Record<string, unknown>,
    id: string,
    path: Array<string | number>,
    kind: NotionAssetRequest["kind"],
  ): NmlBlock[] => {
    const file = fileAt(payload);
    if (!file || !isSafeUrl(file.url)) {
      return stub(block, path, `A ${block.type} without a usable URL was stubbed.`);
    }
    const caption = richTextAt(payload, "caption");
    if (caption.some((item) => item.annotations && Object.values(item.annotations).some((on) => on === true))) {
      report("caption_flattened", path, "A formatted caption became plain text; NML captions are strings.", "warning", id);
    }
    assets.push({ blockId: id, url: file.url, expiring: file.expiring, kind });
    const captionText = caption.map((item) => item.plain_text).join("");
    const name = stringAt(payload, "name");
    return [{
      id,
      type: kind,
      props: {
        source: { kind: "url", url: file.url },
        ...(captionText ? { caption: captionText } : {}),
        ...(name ? { name } : {}),
      },
      children: [],
    } as NmlBlock];
  };

  const table = (
    block: NotionBlock,
    payload: Record<string, unknown>,
    id: string,
    path: Array<string | number>,
  ): NmlBlock[] => {
    const rowBlocks = (block.children ?? []).filter((child) => child.type === "table_row");
    const width = numberAt(payload, "table_width") ?? rowBlocks.reduce((widest, row) => {
      const cells = payloadOf(row).cells;
      return Math.max(widest, Array.isArray(cells) ? cells.length : 0);
    }, 0);
    if (booleanAt(payload, "has_row_header")) {
      report("row_header_dropped", path, "NML models header rows, not header columns; the first column is now ordinary.", "warning", id);
    }
    const columns = Array.from({ length: width }, () => ({ id: createId() }));
    const rows = rowBlocks.map((row, rowIndex) => {
      const cells = payloadOf(row).cells;
      const source = Array.isArray(cells) ? cells : [];
      return {
        id: createId(),
        cells: columns.map((_, cellIndex) => ({
          id: createId(),
          content: inline(
            Array.isArray(source[cellIndex]) ? richTextAt({ rich_text: source[cellIndex] }) : [],
            [...path, "rows", rowIndex, "cells", cellIndex],
          ),
        })),
      };
    });
    return [{
      id,
      type: "table",
      props: { headerRows: booleanAt(payload, "has_column_header") ? 1 : 0 },
      children: [],
      columns,
      rows,
    }];
  };

  const pageLink = (
    block: NotionBlock,
    payload: Record<string, unknown>,
    id: string,
    path: Array<string | number>,
    type: string,
  ): NmlBlock => {
    const target = type === "child_page" ? block.id : stringAt(payload, "page_id") ?? block.id;
    const title = stringAt(payload, "title") ?? "Untitled";
    const pageId = resolvePage(target);
    const content: NmlInlineContent = pageId
      ? [{ type: "pageRef", id: createId(), pageId, fallbackTitle: title }]
      : [{ type: "link", href: notionUrl(target), content: [{ type: "text", text: title, marks: [] }] }];
    if (!pageId) {
      report("page_outside_import", path, "A linked page outside the imported set became a link to Notion.", "warning", id);
    }
    return { id, type: "paragraph", props: {}, children: [], content };
  };

  return { blocks: convertMany(blocks, ["blocks"], 1), diagnostics, ledger, assets };
}

/** One Notion page as a normalized NML document. */
export function convertPage(
  documentId: string,
  blocks: NotionBlock[],
  options: NotionConvertOptions = {},
): NotionConvertResult & { document: NmlDocument } {
  const result = convertBlocks(blocks, options);
  const document = normalizeDocument({
    schemaVersion: NML_SCHEMA_VERSION,
    documentId,
    blocks: result.blocks,
  });
  return { ...result, document, blocks: document.blocks };
}
