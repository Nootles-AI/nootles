import { query } from "./_generated/server";

/**
 * What a project can be started from.
 *
 * A template is a list of pages a new project opens with. Titles only: a page's
 * document is a Yjs CRDT assembled in the browser, so nothing on this side can
 * write one — a template that wants content in its pages will need the client to
 * fill them once the project exists.
 *
 * Code rather than a table while there is one, written by us. `projects.create`
 * takes the id and applies it in the transaction that makes the project, so a
 * template is never something the client assembles page by page.
 */
export type Template = {
  id: string;
  name: string;
  description: string;
  /** In order. Empty means the one blank page every project gets. */
  pages: { title: string }[];
};

export const TEMPLATES: Template[] = [
  {
    id: "prd",
    name: "PRD",
    description: "A product requirements document",
    pages: [],
  },
];

export const findTemplate = (id: string) => TEMPLATES.find((t) => t.id === id);

/**
 * The pages a project opens with — a template's own, or the one blank page
 * every project gets. One function, so what the picker previews and what
 * `projects.create` makes cannot come apart.
 */
export const openingPages = (template: Template | null) =>
  template?.pages.length ? template.pages : [{ title: "" }];

/** What the picker draws. Nothing here is per-account, so nothing is checked. */
export const list = query({
  args: {},
  handler: async () =>
    TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      pages: openingPages(template),
    })),
});
