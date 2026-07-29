import { z } from "zod";

/**
 * The agent's vocabulary, defined once.
 *
 * Only names, descriptions and input schemas live here. The route attaches an
 * `execute` to the tools it can answer itself, and the browser dispatches the
 * rest, so this module has to stay loadable by both — nothing server-only,
 * nothing that reaches for the DOM.
 */
export const TOOLS = {
  list_pages: {
    description:
      "List the pages in this project. Returns each page's id, title and position.",
    inputSchema: z.object({}),
  },
  read_page: {
    description:
      "Read a page. Returns the page as auto-board HTML, one element per block, " +
      "each carrying that block's id. For the page that is open, prefer " +
      "read_open_page — that one is the live document.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
    }),
  },
  open_page: {
    description:
      "Put a page on screen and wait for its document to load. Do this before " +
      "working on a page; it is what makes that page the open one.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
    }),
  },
  read_open_page: {
    description:
      "Read the page that is open, as it stands right now — including anything " +
      "typed or changed since it was last saved. Returns auto-board HTML.",
    inputSchema: z.object({}),
  },
  edit_page: {
    description:
      "Change what a page says. Send auto-board HTML for the blocks you are " +
      "writing: an element WITH an id rewrites that block, an element WITHOUT " +
      "one is a new block, and the ids around it are what decide where it goes. " +
      "Blocks you leave out are left alone, so send the part you are changing " +
      "rather than the whole page. Read the page first — the ids have to be " +
      "ids it actually has. The change is applied and shown to the user, who " +
      "can keep or discard any part of it.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
      html: z
        .string()
        .describe("The blocks as they should read, in the order they should read."),
      replacing: z
        .array(z.string())
        .optional()
        .describe(
          "Ids this rewrite consumes. Any of them your HTML does not keep is " +
            "deleted — this is how four paragraphs become one table.",
        ),
    }),
  },
  search_web: {
    description:
      "Search the web for something the project does not already say. Returns a " +
      "written answer and the pages it came from.",
    inputSchema: z.object({
      query: z.string().describe("A full question, not keywords."),
      maxResults: z.number().int().min(1).max(10).optional(),
    }),
  },
  create_page: {
    description:
      "Add a page to this project. It starts empty — this makes the page, it " +
      "does not write anything on it. Returns the new page's id.",
    inputSchema: z.object({
      title: z.string().describe("The title, as it will read in the sidebar."),
      afterPageId: z
        .string()
        .optional()
        .describe(
          "A page id from list_pages to place this one directly after. Left out, it goes last.",
        ),
    }),
  },
  rename_page: {
    description:
      "Retitle a page. A title is not part of the page's HTML, so this is the " +
      "only way to change one.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
      title: z.string().describe("The new title, replacing the old one outright."),
    }),
  },
  delete_page: {
    description:
      "Delete a page, and with it every diagram, checkpoint and edit ever made " +
      "on it. This cannot be undone, so ask for it only when the user has asked " +
      "for it. They are shown what is about to go and have to allow it before " +
      "anything happens; read the result, because they can refuse.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
    }),
  },
} satisfies Record<string, { description: string; inputSchema: z.ZodType }>;

export type ToolName = keyof typeof TOOLS;

/** One wrong-id sentence for both halves of the tool set, so a model learns it once. */
export const noSuchPage = (pageId: string) =>
  `There is no page with id "${pageId}" in this project. Call list_pages for the ids that exist.`;

/**
 * Tools the browser runs.
 *
 * `read_page` has to turn the stored ProseMirror document back into BlockNote
 * blocks, which needs BlockNote's schema — and our block specs are client
 * components, so a route handler receives them as client references with no
 * node spec and the schema cannot be built there at all (measured: "Cannot read
 * properties of undefined (reading 'node')"). The browser already holds the
 * editor, so the read happens where the write will.
 *
 * The other three could only ever run here: two move or read what is on screen,
 * and `edit_page` runs the applier, which needs the live editor — there is one
 * applier and it is the one a human edit goes through.
 */
export const CLIENT_TOOLS = [
  "read_page",
  "open_page",
  "read_open_page",
  "edit_page",
] as const satisfies readonly ToolName[];

export function isClientTool(name: string): name is (typeof CLIENT_TOOLS)[number] {
  return (CLIENT_TOOLS as readonly string[]).includes(name);
}

