import type { SeedBlock } from "@/app/lib/onboarding/types";

/**
 * What a project can be started from.
 *
 * Defined here rather than in Convex because a page's content is blocks, and
 * blocks only mean something where the editor's schema lives. The server is
 * handed the finished documents (see `seed.ts`) and never learns what a
 * template is — so adding one is a file here, not a deploy.
 *
 * One level of folders, because that is all a starting structure needs.
 */
export type TemplatePage = { title: string; blocks: SeedBlock[] };

export type TemplateRow =
  | ({ kind: "page" } & TemplatePage)
  | { kind: "folder"; title: string; pages: TemplatePage[] };

export type ProjectTemplate = {
  id: string;
  name: string;
  description: string;
  /** The sidebar the project opens with, top to bottom. */
  rows: TemplateRow[];
};
