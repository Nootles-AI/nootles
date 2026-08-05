import type { AnyBlock } from "@/app/lib/ai/projection";
import type { SeedBlock, Template } from "./types";

/**
 * Pictures of a template's page, in the shape the page renderer reads.
 *
 * Two screens draw one — the sign-in door and first run — and they are seen
 * back to back, so the page is built here rather than twice. Built from the
 * template in both cases, so the promise made before anybody signs in cannot
 * drift away from the project that arrives afterwards.
 */

/**
 * The page's own name, as the heading a picture of that page has to open with.
 *
 * Drawn rather than seeded. A real page wears its title in the chrome above the
 * document, so a template that also seeded one as a block would hand every new
 * project its title twice; the miniature has no chrome to wear it in, and a
 * page picture with no title on it does not read as a page.
 */
function titleBlock(template: Template): AnyBlock {
  return {
    id: "ex-title",
    type: "heading",
    props: { level: 1 },
    content: [{ type: "text", text: template.pages[0].title, styles: {} }],
  };
}

/** The block the slash hint lives in is empty by design; an empty paragraph in
    a picture of a page is just a gap nobody can read as anything. */
const isGap = (block: SeedBlock) => block.id === "nt-hint-slash";

/** The seeded diagram's markup — the first canvas block on the first page. */
export function seedDiagramHtml(template: Template): string {
  const block = template.pages[0].blocks.find((b) => b.type === "canvas");
  return String((block?.props as { data?: string } | undefined)?.data ?? "");
}

/** The line that introduces the seeded diagram — the block just above it. */
export function seedDiagramInvite(template: Template): string {
  const blocks = template.pages[0].blocks;
  const at = blocks.findIndex((b) => b.type === "canvas");
  const before = at > 0 ? blocks[at - 1] : undefined;
  return typeof before?.content === "string" ? before.content : "";
}

/**
 * A template block in the shape the page renderer reads.
 *
 * Seeds are written with plain strings for their text, because that is how a
 * template stays legible to whoever edits it; the renderer wants the inline
 * array a real document holds.
 */
function toAny(block: SeedBlock, i: number): AnyBlock {
  return {
    id: block.id ?? `seed-${i}`,
    type: String(block.type ?? "paragraph"),
    props: (block.props ?? {}) as Record<string, unknown>,
    content:
      typeof block.content === "string"
        ? [{ type: "text", text: block.content, styles: {} }]
        : block.content,
  };
}

/** The page down to the line the write demo is about to finish. */
export function openingOf(template: Template): AnyBlock[] {
  const blocks = template.pages[0].blocks;
  const at = blocks.findIndex((b) => b.id === template.script.write.blockId);
  return [
    titleBlock(template),
    ...blocks
      .slice(0, at === -1 ? 2 : at)
      .filter((b) => !isGap(b))
      .map(toAny),
  ];
}

/**
 * A short, finished version of the template's page.
 *
 * Not the document that gets seeded, and deliberately so: the seed is a
 * starting point, while this has to answer "what is a Nootles page" in one
 * glance. So it takes the real opening, jumps to the diagram, and ends on the
 * code, maths or table that kind of document reaches for.
 */
export function examplePage(template: Template): AnyBlock[] {
  const blocks = template.pages[0].blocks;
  // The canvas is seeded into the page; the invite line and the heading above
  // it are the two blocks just before it.
  const at = blocks.findIndex((b) => b.type === "canvas") - 1;
  const lead = blocks.filter((b) => !isGap(b))[0];
  const opening = [lead, ...(at > 0 ? [blocks[at - 1], blocks[at]] : [])];
  const { heading, block } = template.showcase;

  return [
    titleBlock(template),
    ...opening.map(toAny),
    { id: "ex-diagram", type: "canvas", props: { data: seedDiagramHtml(template) } },
    {
      id: "ex-heading",
      type: "heading",
      props: { level: 2 },
      content: [{ type: "text", text: heading, styles: {} }],
    },
    {
      id: "ex-showcase",
      type: block.type,
      props: block.props ?? {},
      content: block.content,
    },
  ];
}

/**
 * The height the diagram declares for itself, so its box is the size of the
 * drawing rather than a number chosen for a thumbnail.
 *
 * `ScenePreview` fits its content to whatever box it is given: too short and
 * the drawing shrinks away from its own labels, too late and it resizes after
 * the page has settled. Handing it the authored height makes the fit an
 * identity and both problems stop existing.
 */
export function declaredHeight(html: string): number | undefined {
  const found = /<nt-diagram[^>]*\bh="(\d+(?:\.\d+)?)"/i.exec(html);
  return found ? Number(found[1]) : undefined;
}
