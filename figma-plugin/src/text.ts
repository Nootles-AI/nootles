/**
 * A Figma text layer as a canvas text: the node's own style, and a label in
 * the grammar `scene/label.ts` reads — styled runs where a range differs from
 * the node, paragraphs where Figma has them, lists where it has those.
 *
 * The node carries the dominant style and a run carries only its difference,
 * so a heading set in one face and one size is a plain label with a plain
 * style, and only the word in bold inside it wears a tag.
 */

import {
  blocksToLabel,
  type LabelBlock,
  type LabelMarks,
  type LabelRun,
} from "@/app/components/editor/canvas/scene/label";
import { safeHref } from "@/app/lib/safeHref";
import { cssColor, round, type Decls } from "./paint";
import { num, obj, paints, type FigNode, type FontName, type Measure, type StyledSegment } from "./model";

const WEIGHTS: [RegExp, number][] = [
  [/\b(thin|hairline)\b/i, 100],
  [/\b(extra\s*light|ultra\s*light)\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(regular|normal|book|roman)\b/i, 400],
  [/\bmedium\b/i, 500],
  [/\b(semi\s*bold|demi\s*bold)\b/i, 600],
  [/\b(extra\s*bold|ultra\s*bold)\b/i, 800],
  [/\b(black|heavy)\b/i, 900],
  [/\bbold\b/i, 700],
];

/** `"Semi Bold Italic"` → 600; the style string is all Figma gives. */
export function weightOf(font: FontName | undefined): number {
  const style = font?.style ?? "";
  for (const [pattern, weight] of WEIGHTS) if (pattern.test(style)) return weight;
  return 400;
}

const italicOf = (font: FontName | undefined) => /italic|oblique/i.test(font?.style ?? "");

const measure = (m: Measure | undefined, pxUnit = "px", pctUnit = "em"): string | undefined => {
  if (!m || m.unit === "AUTO") return undefined;
  if (m.unit === "PIXELS") return `${round(m.value)}${pxUnit}`;
  return `${round(m.value / 100, 3)}${pctUnit}`;
};

const CASE: Record<string, string> = { UPPER: "uppercase", LOWER: "lowercase", TITLE: "capitalize" };
const DECORATION: Record<string, string> = { UNDERLINE: "underline", STRIKETHROUGH: "line-through" };
const H_ALIGN: Record<string, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
const JUSTIFY: Record<string, string> = { LEFT: "flex-start", CENTER: "center", RIGHT: "flex-end" };
const V_ALIGN: Record<string, string> = { TOP: "flex-start", CENTER: "center", BOTTOM: "flex-end" };

const SEGMENT_FIELDS = [
  "fontSize",
  "fontName",
  "fills",
  "textDecoration",
  "textCase",
  "letterSpacing",
  "hyperlink",
  "listOptions",
];

function solidColor(fills: unknown): string | undefined {
  const paint = paints(fills as never).find((p) => p.visible !== false && p.type === "SOLID" && p.color);
  return paint && paint.color ? cssColor(paint.color, paint.opacity ?? 1) : undefined;
}

/** The family as the canvas spells it, with the generic the loader falls back through. */
export function familyDecl(font: FontName | undefined): string | undefined {
  if (!font?.family) return undefined;
  return `"${font.family}", sans-serif`;
}

export type TextResult = { label: string; style: Decls };

export function convertText(node: FigNode): TextResult {
  const segments: StyledSegment[] = node.getStyledTextSegments
    ? node.getStyledTextSegments(SEGMENT_FIELDS)
    : [
        {
          characters: node.characters ?? "",
          start: 0,
          end: (node.characters ?? "").length,
          fontSize: num(node.fontSize),
          fontName: obj(node.fontName as FontName | symbol | undefined),
          fills: paints(node.fills),
          textDecoration: obj(node.textDecoration as never) as StyledSegment["textDecoration"],
          textCase: obj(node.textCase as never) as StyledSegment["textCase"],
        },
      ];

  // The node's own style is the first segment's — the dominant one, nearly
  // always the whole layer's — so a run needs a span only where it differs.
  const lead = segments[0];
  const font = obj(node.fontName as FontName | symbol | undefined) ?? lead?.fontName;
  const size = num(node.fontSize) ?? lead?.fontSize;
  const weight = weightOf(font);
  const italic = italicOf(font);
  const color = solidColor(node.fills) ?? solidColor(lead?.fills);

  const style: Decls = {};
  const family = familyDecl(font);
  if (family) style["font-family"] = family;
  if (size !== undefined) style["font-size"] = `${round(size)}px`;
  if (weight !== 400) style["font-weight"] = String(weight);
  if (italic) style["font-style"] = "italic";
  if (color) style.color = color;
  const lineHeight = measure(obj(node.lineHeight as Measure | symbol | undefined), "px", "");
  if (lineHeight !== undefined) style["line-height"] = lineHeight;
  const spacing = measure(obj(node.letterSpacing as Measure | symbol | undefined));
  if (spacing !== undefined && spacing !== "0px") style["letter-spacing"] = spacing;
  const transform = CASE[String(obj(node.textCase as never) ?? lead?.textCase ?? "")];
  if (transform) style["text-transform"] = transform;
  const decoration = DECORATION[String(obj(node.textDecoration as never) ?? "")];
  if (decoration) style["text-decoration"] = decoration;

  const align = node.textAlignHorizontal ?? "LEFT";
  style["text-align"] = H_ALIGN[align] ?? "left";
  style.display = "grid";
  style["align-items"] = V_ALIGN[node.textAlignVertical ?? "TOP"] ?? "flex-start";
  if (JUSTIFY[align]) style["justify-content"] = JUSTIFY[align];

  switch (node.textAutoResize) {
    case "WIDTH_AND_HEIGHT":
      style.width = "max-content";
      style.height = "auto";
      break;
    case "HEIGHT":
      style.height = "auto";
      break;
    case "TRUNCATE":
      if (node.maxLines) style["-webkit-line-clamp"] = String(node.maxLines);
      break;
  }

  // Runs and blocks. A segment can span a paragraph break, so each is cut at
  // its newlines and the pieces go to the paragraphs they belong to.
  const blocks: LabelBlock[] = [];
  let current: LabelBlock = { kind: "p", runs: [] };
  blocks.push(current);
  const listOf = (segment: StyledSegment): "ul" | "ol" | undefined =>
    segment.listOptions?.type === "ORDERED" ? "ol" : segment.listOptions?.type === "UNORDERED" ? "ul" : undefined;

  for (const segment of segments) {
    const marks = marksOf(segment, { font, size, weight, italic, color });
    const list = listOf(segment);
    const pieces = segment.characters.split("\n");
    pieces.forEach((text, i) => {
      if (i > 0) {
        current = { kind: "p", runs: [] };
        blocks.push(current);
      }
      if (list) {
        current.kind = "li";
        current.list = list;
      }
      if (text) current.runs.push({ kind: "text", text, marks } as LabelRun);
    });
  }

  // Figma's paragraph spacing, on every paragraph but the last.
  const gap = node.paragraphSpacing ?? 0;
  if (gap > 0 && blocks.length > 1) {
    blocks.forEach((block, i) => {
      if (i < blocks.length - 1) block.style = { ...(block.style ?? {}), "margin-bottom": `${round(gap)}px` };
    });
  }
  // A trailing newline leaves an empty last paragraph nobody wrote.
  while (blocks.length > 1 && blocks[blocks.length - 1].runs.length === 0) blocks.pop();

  return { label: blocksToLabel(blocks), style };
}

type Lead = {
  font: FontName | undefined;
  size: number | undefined;
  weight: number;
  italic: boolean;
  color: string | undefined;
};

/** What a segment wears that the node does not. */
function marksOf(segment: StyledSegment, lead: Lead): LabelMarks {
  const marks: LabelMarks = {};
  const style: Record<string, string> = {};
  const weight = weightOf(segment.fontName);
  // The bold tag says 700 and nothing finer, on both sides of the round trip:
  // a bold word in a lighter text is the tag, and every other weight keeps
  // its number.
  if (lead.weight < 700 && weight === 700) marks.bold = true;
  else if (weight !== lead.weight) style["font-weight"] = String(weight);
  const italic = italicOf(segment.fontName);
  if (italic && !lead.italic) marks.italic = true;
  else if (!italic && lead.italic) style["font-style"] = "normal";
  if (segment.textDecoration === "UNDERLINE") marks.underline = true;
  if (segment.textDecoration === "STRIKETHROUGH") marks.strike = true;
  if (segment.fontSize !== undefined && segment.fontSize !== lead.size) style["font-size"] = `${round(segment.fontSize)}px`;
  if (segment.fontName?.family && segment.fontName.family !== lead.font?.family) {
    style["font-family"] = familyDecl(segment.fontName)!;
  }
  const color = solidColor(segment.fills);
  if (color && color !== lead.color) style.color = color;
  const transform = CASE[segment.textCase ?? ""];
  if (transform) style["text-transform"] = transform;
  if (segment.hyperlink?.type === "URL") {
    const href = safeHref(segment.hyperlink.value);
    if (href) marks.href = href;
  }
  if (Object.keys(style).length) marks.style = style;
  return marks;
}
