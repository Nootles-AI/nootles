import { z } from "zod";

/**
 * The agent's vocabulary, defined once.
 *
 * Only names, descriptions and input schemas live here. The route attaches an
 * `execute` to the tools it can answer itself, and the browser dispatches the
 * rest, so this module has to stay loadable by both — nothing server-only,
 * nothing that reaches for the DOM.
 */
/** Said once, because all three repo tools ask for the same two things. */
const repoArg = z
  .string()
  .describe(
    'A repository as "owner/name", exactly as the project\'s linked ' +
      "repositories are named. Only those can be read.",
  );
const refArg = z
  .string()
  .optional()
  .describe("A branch, tag or commit sha. The repository's default branch if left out.");

export const TOOLS = {
  list_pages: {
    description:
      "List the pages in this project. Returns each page's id, title and position.",
    inputSchema: z.object({}),
  },
  read_page: {
    description:
      "Read a page. Returns the page as Nootles HTML, one element per block, " +
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
      "typed or changed since it was last saved. Returns Nootles HTML.",
    inputSchema: z.object({}),
  },
  edit_page: {
    description:
      "Change what a page says. Send Nootles HTML for the blocks you are " +
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
  draw: {
    description:
      "Draw one canvas — a scene, a storyboard shot, a mockup, an " +
      "illustration. A drawing specialist holds the pen, so anything DRAWN " +
      "should come from here rather than from your own paths. Returns a REF " +
      'naming the drawing, which you place by writing <nt-diagram ref="THAT ' +
      'REF"></nt-diagram> in your edit_page HTML — never the drawing itself, ' +
      "which you are not shown and do not need. Nothing touches the page " +
      "until you place it. You may call this several times in parallel — one " +
      "call per storyboard shot.",
    inputSchema: z.object({
      brief: z
        .string()
        .describe(
          "What to draw, as a director would say it: subject and action, " +
            "composition (close on…, wide of…), time of day, mood, and the " +
            "colours or style the board is using — repeat the same style " +
            "words across a board's shots so they read as one film.",
        ),
      w: z
        .number()
        .int()
        .optional()
        .describe(
          "Frame width, with h: the drawing fills this box edge to edge. A " +
            "storyboard shot is 320 wide. Leave both out for a standalone " +
            "drawing — it takes a document-sized frame on its own.",
        ),
      h: z
        .number()
        .int()
        .optional()
        .describe("Frame height. A shot's is the board ratio's: see THE PICTURE."),
      kind: z
        .enum(["scene", "diagram"])
        .optional()
        .describe(
          "scene (the default): a picture — a storyboard shot, a landscape, a " +
            "figure, an illustration; drawn by a vector artist, so expect art, " +
            "not labels. diagram: anything whose WORDS matter — a mockup with " +
            "readable UI text, a labelled figure — where text must land as " +
            "editable text.",
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
  list_repo_files: {
    description:
      "List what is in one of the project's linked GitHub repositories, at a " +
      "path. Leave the path out for the top level. Returns each entry's full " +
      "path and whether it is a file or a directory — one level at a time, so " +
      "walk down to what you want.",
    inputSchema: z.object({
      repo: repoArg,
      path: z
        .string()
        .optional()
        .describe("A directory inside the repo, e.g. \"src/lib\". The top level if left out."),
      ref: refArg,
    }),
  },
  read_repo_file: {
    description:
      "Read a file from one of the project's linked GitHub repositories. " +
      "Returns its text; a very large file comes back truncated and says so, " +
      "and a binary one is refused rather than returned as noise.",
    inputSchema: z.object({
      repo: repoArg,
      path: z
        .string()
        .describe("The file's path from the repo root, e.g. \"src/index.ts\"."),
      ref: refArg,
    }),
  },
  search_repo_code: {
    description:
      "Search the code in this project's linked repositories for a symbol or " +
      "phrase — the fastest way to find where something lives. Returns file " +
      "paths and the lines that matched, not whole files, so read the ones that " +
      "look right. Searches the default branch only.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "What to look for. GitHub code search: a symbol or a quoted phrase " +
            'works, and qualifiers like path:, language: and extension: are allowed.',
        ),
      repo: repoArg
        .optional()
        .describe("Confine the search to one repository. All of them if left out."),
    }),
  },
  read_context_file: {
    description:
      "Read a file the user has added to this project's context — the whole " +
      "extracted text, where the prompt carries only the head. A PDF or Word " +
      "document comes back as plain text; a very large file comes back " +
      "truncated and says so.",
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "The file's exact name, as the project's context files are listed. " +
            "Only those can be read.",
        ),
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

