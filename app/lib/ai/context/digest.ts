import { labelText } from "@/app/components/editor/canvas/scene/label";
import { migrateLegacyCanvas } from "@/app/components/editor/canvas/scene/migrate";
import { isGroup, type SceneNode } from "@/app/components/editor/canvas/scene/types";
import { DIGEST_LIMITS, type PageDigest } from "@/convex/context/shape";
import type { AnyBlock } from "../projection";

/**
 * A page as its node in the context graph: a one-line brief, a templated
 * summary, the words a search should find it by, and the pages it mentions.
 *
 * Templated, not written by a model — structure is free and a model call per
 * page edit is not. A model-written summary can replace the template later,
 * where attention goes; the node already says which kind it holds.
 */
export function digestPage(blocks: readonly AnyBlock[]): PageDigest {
  const headings: string[] = [];
  const prose: string[] = [];
  const labels: string[] = [];
  const mentions: string[] = [];

  const walk = (list: readonly AnyBlock[]) => {
    for (const block of list) {
      if (block.type === "canvas") {
        labels.push(...canvasLabels(String(block.props.data ?? "")));
      } else {
        const text = words(block, mentions);
        if (text) (block.type === "heading" ? headings : prose).push(text);
      }
      if (block.children?.length) walk(block.children);
    }
  };
  walk(blocks);

  const brief = clip(prose[0] ?? headings[0] ?? labels[0] ?? "", 140);
  const outline = headings.length ? `Sections: ${headings.slice(0, 12).join(" · ")}` : "";
  const opening = prose.join(" ");
  const summary = clip(
    [outline, opening].filter(Boolean).join("\n"),
    DIGEST_LIMITS.summary,
  );
  const terms = [...headings, ...prose, ...labels]
    .join("\n")
    .slice(0, DIGEST_LIMITS.terms);
  const unique = [...new Set(mentions)].slice(0, DIGEST_LIMITS.mentions);

  const digest = { brief, summary, terms, mentions: unique };
  return { ...digest, contentHash: hash(JSON.stringify(digest)) };
}

/**
 * A block's words, whatever holds them — inline runs, table cells, a code
 * block's source — collecting the pages it mentions on the way. Walks the
 * content generically rather than per block type, so a block type added later
 * is searchable without this knowing about it.
 */
function words(block: AnyBlock, mentions: string[]): string {
  if (block.type === "codeBlock") return String(block.props.code ?? "").trim();
  if (block.type === "mathBlock") return String(block.props.source ?? "").trim();
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const item = value as { type?: unknown; text?: unknown; props?: Record<string, unknown> };
    if (item.type === "text" && typeof item.text === "string") out.push(item.text);
    else if (item.type === "pageMention") {
      const pageId = String(item.props?.pageId ?? "");
      if (pageId) mentions.push(pageId);
      out.push(String(item.props?.title ?? ""));
    } else {
      for (const [key, child] of Object.entries(item)) {
        if (key !== "props" && key !== "styles") visit(child);
      }
    }
  };
  visit(block.content);
  return out.join("").replace(/\s+/g, " ").trim();
}

function canvasLabels(data: string): string[] {
  const out: string[] = [];
  const walk = (nodes: readonly SceneNode[]) => {
    for (const node of nodes) {
      const text = labelText(node.label).replace(/\s+/g, " ").trim();
      if (text) out.push(text);
      if (isGroup(node)) walk(node.children);
    }
  };
  walk(migrateLegacyCanvas(data).nodes);
  return out;
}

/** At most `max` characters, cut at a word where one is near. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/** cyrb53: a fast, well-spread string fingerprint. Change detection, not security. */
function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
