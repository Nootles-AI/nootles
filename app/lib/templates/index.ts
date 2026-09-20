import { toAny } from "@/app/lib/onboarding/preview";
import type { AnyBlock } from "@/app/lib/ai/projection";
import { prd } from "./prd";
import type { ProjectTemplate, TemplatePage } from "./types";

export type { ProjectTemplate, TemplatePage, TemplateRow } from "./types";

export const PROJECT_TEMPLATES: ProjectTemplate[] = [prd];

export const findTemplate = (id: string) => PROJECT_TEMPLATES.find((t) => t.id === id);

/** Every page a template makes, in sidebar order. */
export const pagesOf = (template: ProjectTemplate): TemplatePage[] =>
  template.rows.flatMap((row) => (row.kind === "page" ? [row] : row.pages));

/**
 * A page as the thumbnail renderer reads it, under its own title — which in a
 * real page is the heading above the document rather than a block in it.
 */
export function pagePicture(page: TemplatePage): AnyBlock[] {
  return [
    {
      id: "title",
      type: "heading",
      props: { level: 1 },
      content: [{ type: "text", text: page.title, styles: {} }],
    },
    ...page.blocks.map(toAny),
  ];
}
