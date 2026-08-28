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
      expand: z
        .array(z.string())
        .optional()
        .describe(
          "Block ids whose DRAWN pictures should come back shape by shape " +
            'instead of as <nt-diagram drawn="…"> stubs. Only for a block ' +
            "whose shapes you mean to edit by hand — a drawn picture is " +
            "large, and the stub is all you need to keep, move or replace it.",
        ),
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
    inputSchema: z.object({
      expand: z
        .array(z.string())
        .optional()
        .describe("As on read_page: block ids to read drawn pictures in full."),
    }),
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
            "colours the board is using — repeat the same mood and palette " +
            "words across a board's shots so they read as one film. The " +
            "rendering style is not yours to name: the user picks it on a " +
            "card when you call draw.",
        ),
      ratio: z
        .enum(["16:9", "2.39:1", "1.85:1", "4:3", "1:1", "9:16"])
        .optional()
        .describe(
          "For a STORYBOARD SHOT: the board's own ratio, copied from its " +
            '<nt-storyboard ratio="…"> — and nothing else. The shot\'s frame ' +
            "is worked out from it, so a shot never needs w or h. Getting " +
            "this wrong is what makes a picture too big for its shot.",
        ),
      w: z
        .number()
        .int()
        .optional()
        .describe(
          "Frame width, with h: the drawing fills this box edge to edge. Only " +
            "for a drawing that is NOT a storyboard shot and needs a " +
            "particular size; a shot passes ratio instead. Leave all three " +
            "out for a standalone drawing — it takes a document-sized frame.",
        ),
      h: z.number().int().optional().describe("Frame height, with w."),
      kind: z
        .enum(["scene", "diagram"])
        .optional()
        .describe(
          "scene (the default): a picture — a storyboard shot, a landscape, a " +
            "figure, an illustration; drawn by a vector artist, so expect art, " +
            "not labels. diagram: anything whose WORDS matter — a mockup with " +
            "readable UI text, a labelled figure — where text must land as " +
            "editable text. Never diagram for a storyboard shot: a title " +
            "card's lettering is part of the picture.",
        ),
    }),
  },
  album_edit: {
    description:
      "Change an album — reorder it, drop pictures, make one bigger, set its " +
      "columns, add pictures found with find_images. Pictures are named by the " +
      "HANDLE in the first column of the album index, which read_page gives " +
      "you when you expand the album; positions shift as soon as anything " +
      "moves, handles do not. Send every change to one album as ONE call: the " +
      "ops are applied in the order you write them. The user reviews the " +
      "result and may discard it. Prefer this to rewriting the album in " +
      "edit_page, which costs a hundred times as much and can lose pictures.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
      blockId: z
        .string()
        .describe("The album's block id — the `at` on its <nt-album> stub."),
      ops: z
        .array(
          z.union([
            z
              .object({
                op: z.literal("order"),
                items: z
                  .array(z.string())
                  .describe(
                    "Handles, in the order the album should read. Anything you " +
                      "leave out keeps its order behind the ones you name, so a " +
                      "short list promotes rather than deletes.",
                  ),
              })
              .describe("Rearrange. The cheapest way to say a whole new order."),
            z.object({
              op: z.literal("move"),
              item: z.string(),
              to: z.number().int().describe("Its new position, counting from 0."),
            }),
            z.object({ op: z.literal("remove"), items: z.array(z.string()) }),
            z
              .object({
                op: z.literal("span"),
                item: z.string(),
                cols: z
                  .number()
                  .int()
                  .min(1)
                  .max(6)
                  .describe("Columns this one picture is drawn across."),
              })
              .describe(
                "Make one picture bigger. With position, this is the whole of " +
                  "how prominent a picture is — see THE ALBUM in your instructions.",
              ),
            z
              .object({
                op: z.literal("grid"),
                cols: z
                  .number()
                  .int()
                  .min(1)
                  .max(6)
                  .nullable()
                  .optional()
                  .describe("Columns for the whole album; null to let its width decide."),
                width: z
                  .number()
                  .int()
                  .nullable()
                  .optional()
                  .describe("The block's width in pixels; null to track the text column."),
              })
              .describe("The album's own shape."),
            z.object({
              op: z.literal("add"),
              refs: z
                .array(z.string())
                .describe("Refs from find_images, exactly as it returned them."),
              at: z
                .number()
                .int()
                .optional()
                .describe("Where to insert, counting from 0. The end if left out."),
            }),
          ]),
        )
        .min(1),
    }),
  },
  find_images: {
    description:
      "Find photographs on the web to put in an album. Returns a REF per " +
      "picture, with its shape, its dominant colour and what it shows; you add " +
      "them by passing those refs to album_edit's add op, which copies the " +
      "pictures into this document. You are not shown the pictures and do not " +
      "need to be. Search for a LOOK, not a list: one call for \"weathered " +
      "coastal timber, overcast\" beats six for six nouns.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "What the pictures should look like, in words — subject, light, " +
            'mood, palette: "empty brutalist stairwells, hard shadows".',
        ),
      count: z.number().int().min(1).max(12).optional().describe("Up to 12. Five if left out."),
      orientation: z.enum(["landscape", "portrait", "square"]).optional(),
      colour: z
        .string()
        .optional()
        .describe(
          "A colour to bias towards, as a plain word (\"teal\", \"black_and_white\"). " +
            "Use the album's own dominant colours when matching a moodboard.",
        ),
    }),
  },
  look_at: {
    description:
      "Look at up to four of an album's pictures at full size. Almost never " +
      "needed: the album index read_page gives you already says what each " +
      "picture is, what colour it is and how striking it is, and every " +
      "question about palette, spread or arrangement is answerable from that " +
      "alone. Use this only for something a description genuinely cannot " +
      "carry — reading words inside a photograph, or judging a crop.",
    inputSchema: z.object({
      blockId: z.string().describe("The album's block id."),
      items: z
        .array(z.string())
        .min(1)
        .max(4)
        .describe("Handles from the album index, at most four."),
    }),
  },
  find_places: {
    description:
      "Look up real places on Google Maps — cafes, restaurants, hotels, " +
      "anything with an address. Returns each place's name, address, " +
      "coordinates, star rating, how many people rated it, and its " +
      "photographs. This is the ONLY source of a place's rating, photos or " +
      "id: none of that may come from memory. Ask once per place or per kind " +
      "of place; \"cafes near the Ferry Building\" is one call, not ten.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "What to look for, in words, including where: \"cafes near Ferry " +
            "Building, San Francisco\". For a route, ask along it — one call " +
            "per waypoint you care about.",
        ),
      near: z
        .string()
        .optional()
        .describe(
          "\"lat,lng\" to bias the search toward, when the conversation has " +
            "given you one. A bias, not a filter.",
        ),
    }),
  },
  find_songs: {
    description:
      "Look a song up on Spotify or Apple Music. Returns each track's exact " +
      "page URL, title, artist and length. This is the ONLY source of a song's " +
      "URL — you do not know track ids, and one you write from memory is a page " +
      "that does not exist. Ask for one song per call, by name and artist.",
    inputSchema: z.object({
      query: z
        .string()
        .describe(
          "The song, as you would say it out loud: \"After the Storm Kali Uchis\". " +
            "A name and an artist find one track; a mood finds nothing, so decide " +
            "what to play first and then look that up.",
        ),
      service: z
        .enum(["spotify", "apple"])
        .optional()
        .describe(
          "Only when the user asked for one by name. Left out, the best " +
            "available shelf answers.",
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
  // Both for the same reason as `edit_page`: an album's pictures are in the
  // live document, and its pixels are only reachable from a browser at all —
  // a storage URL is a bearer the server has no session to derive.
  "album_edit",
  "look_at",
] as const satisfies readonly ToolName[];

export function isClientTool(name: string): name is (typeof CLIENT_TOOLS)[number] {
  return (CLIENT_TOOLS as readonly string[]).includes(name);
}

