import { parseHTML } from "linkedom";
import { parseAlbum } from "@/app/components/editor/album/parse";
import { serializeAlbum } from "@/app/components/editor/album/serialize";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import { parseLocation } from "@/app/components/editor/location/parse";
import { serializeLocation } from "@/app/components/editor/location/serialize";
import { parseStoryboard } from "@/app/components/editor/storyboard/parse";
import { serializeStoryboard } from "@/app/components/editor/storyboard/serialize";
import { normalizeDocument, normalizeInline } from "./normalize";
import {
  NML_SCHEMA_VERSION,
  type NmlBlock,
  type NmlDocument,
  type NmlInlineContent,
  type NmlIssue,
  type NmlMark,
} from "./schema";
import { serializeDocument } from "./serialize";
import { validateDocument } from "./validate";

export type NmlParseMode = "canonical" | "import" | "model";
export type NmlQuarantineEntry = { path: Array<string | number>; markup: string };
export type NmlParseResult = {
  document?: NmlDocument;
  diagnostics: NmlIssue[];
  quarantine: NmlQuarantineEntry[];
};
export type NmlParseOptions = {
  mode?: NmlParseMode;
  createId?: () => string;
  parseHtml?: (html: string) => Document;
};

export class NmlParseError extends Error {
  constructor(readonly diagnostics: NmlIssue[], readonly quarantine: NmlQuarantineEntry[]) {
    super(diagnostics.map((entry) => `${entry.path.join(".")}: ${entry.message}`).join("\n"));
    this.name = "NmlParseError";
  }
}

const blockTags = new Set(["p", "blockquote", "ul", "ol", "details", "table", "hr", "nt-code-block", "nt-math-block", "img", "video", "audio", "nt-file", "nt-diagram", "nt-album", "nt-storyboard", "nt-location"]);
const aliases: Record<string, string> = { paragraph: "p", quote: "blockquote", code: "nt-code-block", math: "nt-math-block", diagram: "nt-diagram", canvas: "nt-diagram", album: "nt-album", gallery: "nt-album", storyboard: "nt-storyboard", location: "nt-location", place: "nt-location" };
const markForTag: Record<string, NmlMark> = { code: "code", strong: "bold", b: "bold", em: "italic", i: "italic", s: "strike", strike: "strike", u: "underline" };

const defaultParseHtml = (html: string): Document => parseHTML(html).document as unknown as Document;
const defaultCreateId = () => {
  const id = globalThis.crypto?.randomUUID?.();
  if (!id) throw new Error("A cryptographically random createId function is required in this runtime.");
  return id;
};

function elements(parent: ParentNode): Element[] {
  return Array.from(parent.childNodes).filter((node): node is Element => node.nodeType === 1);
}

function attr(el: Element, name: string): string | undefined {
  const value = el.getAttribute(name)?.trim();
  return value ? value : undefined;
}

function integer(el: Element, name: string, fallback: number): number {
  const value = Number(el.getAttribute(name));
  return Number.isInteger(value) ? value : fallback;
}

export function parseDocument(source: string, options: NmlParseOptions = {}): NmlParseResult {
  const mode = options.mode ?? "canonical";
  const parseHtml = options.parseHtml ?? defaultParseHtml;
  const createId = options.createId ?? defaultCreateId;
  const diagnostics: NmlIssue[] = [];
  const quarantine: NmlQuarantineEntry[] = [];
  const report = (code: string, path: Array<string | number>, message: string, severity: NmlIssue["severity"] = "warning", nodeId?: string) => {
    diagnostics.push({ code, severity, path, message, ...(nodeId ? { nodeId } : {}) });
  };
  const keep = (el: Element, path: Array<string | number>, message: string) => {
    quarantine.push({ path, markup: el.outerHTML });
    report("unsupported_markup", path, message, "error");
  };
  const idOf = (el: Element, path: Array<string | number>): string => {
    const existing = attr(el, "id");
    if (existing) return existing;
    const id = createId();
    report("minted_id", [...path, "id"], `Missing stable ID was minted as \"${id}\".`, "repair", id);
    return id;
  };

  const inline = (parent: ParentNode, path: Array<string | number>, inherited: NmlMark[] = []): NmlInlineContent => {
    const out: NmlInlineContent = [];
    const nodes = Array.from(parent.childNodes);
    const isBlockElement = (node: ChildNode | undefined) =>
      node?.nodeType === 1 && (blockTags.has((node as Element).tagName.toLowerCase()) || /^h[1-6]$/.test((node as Element).tagName.toLowerCase()));
    nodes.forEach((node, index) => {
      const here = [...path, index];
      if (node.nodeType === 3) {
        let value = node.textContent ?? "";
        if (isBlockElement(nodes[index + 1])) value = value.replace(/\s+$/, "");
        if (isBlockElement(nodes[index - 1])) value = value.replace(/^\s+/, "");
        out.push({ type: "text", text: value, marks: inherited });
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (markForTag[tag]) {
        out.push(...inline(el, here, [...inherited, markForTag[tag]]));
      } else if (tag === "a") {
        const linked = inline(el, [...here, "content"], inherited).filter((item) => item.type === "text");
        out.push({ type: "link", href: el.getAttribute("href") ?? "", content: linked });
      } else if (tag === "nt-math") {
        out.push({ type: "math", id: idOf(el, here), latex: el.textContent ?? "" });
      } else if (tag === "nt-ref") {
        out.push({ type: "pageRef", id: idOf(el, here), pageId: attr(el, "page-id") ?? "", fallbackTitle: el.textContent ?? "" });
      } else if (tag === "br") {
        out.push({ type: "text", text: " ", marks: inherited });
        report("normalized_hard_break", here, "Hard break normalized to a space.", "repair");
      } else if (blockTags.has(tag) || /^h[1-6]$/.test(tag)) {
        return;
      } else if (mode !== "canonical") {
        report("unwrapped_inline", here, `Unsupported inline <${tag}> was unwrapped.`, "repair");
        out.push(...inline(el, here, inherited));
      } else keep(el, here, `Unsupported inline element <${tag}>.`);
    });
    return normalizeInline(out);
  };

  const childBlocks = (parent: ParentNode, path: Array<string | number>): NmlBlock[] => parseBlocks(elements(parent), path);
  const legacyMarkup = (el: Element) => {
    const legacy = elements(el).find((child) => child.tagName.toLowerCase() === "nt-legacy-markup");
    return legacy ? { legacyMarkup: legacy.textContent ?? "" } : {};
  };
  const importedLegacy = (el: Element, canonical: string, path: Array<string | number>) => {
    if (mode === "canonical" || canonical === el.outerHTML) return {};
    report("preserved_legacy_markup", path, "Noncanonical custom-domain markup was retained for migration recovery.", "warning");
    return { legacyMarkup: el.outerHTML };
  };
  const parseBlock = (el: Element, path: Array<string | number>): NmlBlock | NmlBlock[] | undefined => {
    const originalTag = el.tagName.toLowerCase();
    const tag = mode === "canonical" ? originalTag : aliases[originalTag] ?? originalTag;
    if (tag !== originalTag) report("normalized_alias", path, `<${originalTag}> normalized to <${tag}>.`, "repair");
    const id = () => idOf(el, path);
    if (tag === "p" || tag === "blockquote") return { id: id(), type: tag === "p" ? "paragraph" : "quote", props: {}, content: inline(el, [...path, "content"]), children: [] };
    if (/^h[1-6]$/.test(tag)) return { id: id(), type: "heading", props: { level: Number(tag[1]) as 1 | 2 | 3 | 4 | 5 | 6 }, content: inline(el, [...path, "content"]), children: [] };
    if (tag === "ul" || tag === "ol") {
      const kind = el.getAttribute("data-kind");
      return elements(el).filter((item) => item.tagName.toLowerCase() === "li").map((item, index) => {
        const itemPath = [...path, index];
        const type = kind === "check" ? "checkListItem" : tag === "ol" ? "numberedListItem" : "bulletListItem";
        const nested = elements(item).filter((child) => blockTags.has(child.tagName.toLowerCase()) || /^h[1-6]$/.test(child.tagName.toLowerCase()));
        return {
          id: idOf(item, itemPath),
          type,
          props: type === "checkListItem" ? { checked: item.getAttribute("checked") === "true" } : type === "numberedListItem" && index === 0 && el.hasAttribute("start") ? { start: integer(el, "start", 1) } : {},
          content: inline(item, [...itemPath, "content"]),
          children: parseBlocks(nested, [...itemPath, "children"]),
        } as NmlBlock;
      });
    }
    if (tag === "details") {
      const summary = elements(el).find((child) => child.tagName.toLowerCase() === "summary");
      const nested = elements(el).filter((child) => child !== summary);
      return { id: id(), type: "toggleListItem", props: {}, content: summary ? inline(summary, [...path, "content"]) : [], children: parseBlocks(nested, [...path, "children"]) };
    }
    if (tag === "table") {
      const columnEls = Array.from(el.querySelectorAll(":scope > colgroup > col"));
      const rowEls = Array.from(el.querySelectorAll(":scope > tr, :scope > thead > tr, :scope > tbody > tr"));
      const width = columnEls.length || Math.max(0, ...rowEls.map((row) => elements(row).filter((cell) => /^(th|td)$/.test(cell.tagName.toLowerCase())).length));
      const columns = Array.from({ length: width }, (_, index) => ({ id: columnEls[index] ? idOf(columnEls[index], [...path, "columns", index]) : createId() }));
      if (!columnEls.length && width) report("minted_columns", [...path, "columns"], "Stable table column IDs were minted.", "repair");
      const rows = rowEls.map((row, rowIndex) => ({
        id: idOf(row, [...path, "rows", rowIndex]),
        cells: elements(row).filter((cell) => /^(th|td)$/.test(cell.tagName.toLowerCase())).map((cell, cellIndex) => ({ id: idOf(cell, [...path, "rows", rowIndex, "cells", cellIndex]), content: inline(cell, [...path, "rows", rowIndex, "cells", cellIndex, "content"]) })),
      }));
      const leadingHeaders = rowEls.findIndex((row) => elements(row)[0]?.tagName.toLowerCase() !== "th");
      const headerRows = el.hasAttribute("header-rows") ? integer(el, "header-rows", 0) : leadingHeaders < 0 ? rowEls.length : leadingHeaders;
      return { id: id(), type: "table", props: { headerRows }, columns, rows, children: [] };
    }
    if (tag === "nt-code-block") return { id: id(), type: "codeBlock", props: { language: attr(el, "language") ?? "" }, code: el.textContent ?? "", children: [] };
    if (tag === "nt-math-block") return { id: id(), type: "mathBlock", props: {}, rows: elements(el).filter((row) => row.tagName.toLowerCase() === "nt-math-line").map((row, index) => ({ id: idOf(row, [...path, "rows", index]), latex: row.textContent ?? "" })), children: [] };
    if (tag === "hr") return { id: id(), type: "divider", props: {}, children: [] };
    if (tag === "img" || tag === "video" || tag === "audio" || tag === "nt-file") {
      const type = tag === "nt-file" ? "file" : tag === "img" ? "image" : tag;
      const storageId = attr(el, "storage-id");
      const url = attr(el, "src");
      return { id: id(), type, props: { ...(storageId ? { source: { kind: "storage" as const, storageId } } : url ? { source: { kind: "url" as const, url } } : {}), ...(el.hasAttribute("caption") ? { caption: el.getAttribute("caption")! } : {}), ...(el.hasAttribute("name") ? { name: el.getAttribute("name")! } : {}) }, children: [] } as NmlBlock;
    }
    if (tag === "nt-diagram") return { id: id(), type: "canvas", props: {}, scene: parseScene(el.outerHTML, parseHtml), children: [] };
    if (tag === "nt-album") {
      const domain = parseAlbum(el.outerHTML, parseHtml);
      return { id: id(), type: "album", props: {}, domain, ...importedLegacy(el, serializeAlbum(domain), path), ...legacyMarkup(el), children: [] };
    }
    if (tag === "nt-storyboard") {
      const domain = parseStoryboard(el.outerHTML, parseHtml);
      return { id: id(), type: "storyboard", props: {}, domain, ...importedLegacy(el, serializeStoryboard(domain), path), ...legacyMarkup(el), children: [] };
    }
    if (tag === "nt-location") {
      const domain = parseLocation(el.outerHTML, parseHtml);
      return { id: id(), type: "location", props: {}, domain, ...importedLegacy(el, serializeLocation(domain), path), ...legacyMarkup(el), children: [] };
    }
    keep(el, path, `Unsupported block element <${originalTag}>.`);
  };
  const parseBlocks = (input: Element[], path: Array<string | number>): NmlBlock[] => input.flatMap((el, index) => {
    const parsed = parseBlock(el, [...path, index]);
    return parsed ? (Array.isArray(parsed) ? parsed : [parsed]) : [];
  });

  let dom: Document;
  try {
    dom = parseHtml(`<!doctype html><html><body>${source}</body></html>`);
  } catch (error) {
    report("malformed_document", [], error instanceof Error ? error.message : "Document could not be parsed.", "error");
    return { diagnostics, quarantine };
  }
  const root = Array.from(dom.body.children).find((el) => el.tagName.toLowerCase() === "nt-document");
  if (!root) {
    report("missing_document_root", [], "Expected one <nt-document> root.", "error");
    return { diagnostics, quarantine };
  }
  const rootSiblings = Array.from(dom.body.childNodes).filter(
    (node) => node !== root && (node.nodeType === 1 || (node.nodeType === 3 && Boolean(node.textContent?.trim()))),
  );
  rootSiblings.forEach((node, index) => {
    if (node.nodeType === 1) keep(node as Element, ["outsideRoot", index], "Content outside <nt-document> is not part of the document.");
    else report("content_outside_root", ["outsideRoot", index], "Text outside <nt-document> is not allowed.", "error");
  });
  const version = integer(root, "schema-version", 0);
  if (version > NML_SCHEMA_VERSION) {
    report("unsupported_schema_version", ["schemaVersion"], `Schema version ${version} is newer than supported version ${NML_SCHEMA_VERSION}; the document is read-only.`, "error");
    return { diagnostics, quarantine };
  }
  if (version !== NML_SCHEMA_VERSION) {
    report("migration_required", ["schemaVersion"], `Schema version ${version} must be migrated before parsing as v${NML_SCHEMA_VERSION}.`, "error");
    return { diagnostics, quarantine };
  }
  const document = normalizeDocument({ schemaVersion: NML_SCHEMA_VERSION, documentId: attr(root, "id") ?? createId(), blocks: childBlocks(root, ["blocks"]) });
  diagnostics.push(...validateDocument(document));
  if (mode === "canonical" && !diagnostics.some((entry) => entry.severity === "error")) {
    try {
      if (serializeDocument(document) !== source) report("noncanonical_source", [], "Canonical input must exactly equal its deterministic serialization.", "error");
    } catch (error) {
      report("invalid_canonical_source", [], error instanceof Error ? error.message : "Canonical serialization failed.", "error");
    }
  }
  return { document, diagnostics, quarantine };
}

/** Persistence/file verification entry point: either a canonical v1 document or an error. */
export function parseCanonicalDocument(
  source: string,
  options: Omit<NmlParseOptions, "mode"> = {},
): NmlDocument {
  const result = parseDocument(source, { ...options, mode: "canonical" });
  if (!result.document || result.diagnostics.some((entry) => entry.severity === "error")) {
    throw new NmlParseError(result.diagnostics, result.quarantine);
  }
  return result.document;
}
