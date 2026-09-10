import { isSafeUrl } from "@/app/lib/nml/validate";
import type { NmlInlineContent, NmlIssue, NmlMark, NmlText } from "@/app/lib/nml/schema";
import { notionUrl, type NotionRichText } from "./types";

export type NotionInlineContext = {
  createId: () => string;
  /** Notion page id → Nootles page id, for pages inside the same import set. */
  resolvePage: (notionPageId: string) => string | undefined;
  report: (
    code: string,
    path: Array<string | number>,
    message: string,
    severity?: NmlIssue["severity"],
  ) => void;
};

function marksOf(item: NotionRichText): NmlMark[] {
  const a = item.annotations ?? {};
  const marks: NmlMark[] = [];
  if (a.code) marks.push("code");
  if (a.bold) marks.push("bold");
  if (a.italic) marks.push("italic");
  if (a.strikethrough) marks.push("strike");
  if (a.underline) marks.push("underline");
  return marks;
}

function textRun(text: string, marks: NmlMark[]): NmlText {
  return { type: "text", text, marks };
}

/**
 * Notion rich text into NML inline content.
 *
 * Two of NML's rules do real work here. Colour has no representation and is
 * dropped on purpose — five marks, neutral styling. And a link may hold only
 * text (`schema.ts:41`), so an equation carrying an href keeps the equation and
 * loses the link rather than the other way round.
 */
export function convertRichText(
  items: NotionRichText[],
  ctx: NotionInlineContext,
  path: Array<string | number>,
): NmlInlineContent {
  const out: NmlInlineContent = [];
  let colouredAt: number | undefined;

  items.forEach((item, index) => {
    const here = [...path, index];
    const marks = marksOf(item);
    const colour = item.annotations?.color;
    if (colour && colour !== "default" && colouredAt === undefined) colouredAt = index;

    if (item.equation?.expression !== undefined) {
      if (item.href) {
        ctx.report("link_around_equation", here, "A link wrapping an equation was dropped; the equation is kept.", "repair");
      }
      out.push({ type: "math", id: ctx.createId(), latex: item.equation.expression });
      return;
    }

    if (item.mention) {
      out.push(...convertMention(item, marks, ctx, here));
      return;
    }

    const content = item.text?.content ?? item.plain_text;
    const href = item.text?.link?.url ?? item.href ?? undefined;
    if (!href) {
      out.push(textRun(content, marks));
      return;
    }
    if (!isSafeUrl(href)) {
      ctx.report("unsafe_link_dropped", here, `Link to an unsupported URL scheme was flattened to text.`, "repair");
      out.push(textRun(content, marks));
      return;
    }
    out.push({ type: "link", href, content: [textRun(content, marks)] });
  });

  if (colouredAt !== undefined) {
    ctx.report(
      "colour_dropped",
      [...path, colouredAt],
      "Notion text colour has no representation in NML and was dropped.",
      "warning",
    );
  }
  return out;
}

function convertMention(
  item: NotionRichText,
  marks: NmlMark[],
  ctx: NotionInlineContext,
  path: Array<string | number>,
): NmlInlineContent {
  const mention = item.mention;
  const label = item.plain_text || "Untitled";
  if (!mention) return [textRun(label, marks)];

  if (mention.type === "page") {
    const pageId = ctx.resolvePage(mention.page.id);
    if (pageId) {
      return [{ type: "pageRef", id: ctx.createId(), pageId, fallbackTitle: label }];
    }
    ctx.report(
      "mention_outside_import",
      path,
      "A page mention outside the imported set became a link to Notion.",
      "warning",
    );
    return [{ type: "link", href: notionUrl(mention.page.id), content: [textRun(label, marks)] }];
  }

  if (mention.type === "database") {
    ctx.report("mention_database", path, "A database mention became a link to Notion.", "warning");
    return [{ type: "link", href: notionUrl(mention.database.id), content: [textRun(label, marks)] }];
  }

  if (mention.type === "link_preview") {
    const href = mention.link_preview.url;
    if (isSafeUrl(href)) return [{ type: "link", href, content: [textRun(label, marks)] }];
  }

  // A user, a date, a template mention: the text of it is all that survives.
  ctx.report(
    "mention_flattened",
    path,
    `A ${mention.type} mention was flattened to its text.`,
    "warning",
  );
  return [textRun(label, marks)];
}
