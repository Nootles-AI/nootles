import { z } from "zod";

/**
 * The agent's vocabulary, defined once.
 *
 * Only names, descriptions and input schemas live here. The route attaches an
 * `execute` to the tools it can answer itself, and the browser dispatches the
 * rest, so this module has to stay loadable by both — nothing server-only,
 * nothing that reaches for the DOM.
 *
 * Every entry also carries `side`, `mutates` and `surfaces` — metadata the
 * tool table itself can be queried for, rather than something re-derived at
 * each call site. `CLIENT_TOOLS` is now DERIVED from `side` instead of a
 * hand-kept parallel list, so a new client tool can never forget to add
 * itself there. `surfaces` is what lets an MCP adapter (later) offer a
 * filtered subset of this same table without a second tool definition —
 * `CANVAS_TOOLS`, the 13 node-level diagram tools, and the three context
 * tools carry `"mcp"`.
 */
const pageIdArg = z.string().optional().describe("A page id from list_pages. The open page if left out.");
const blockIdArg = z
  .string()
  .describe(
    'The diagram\'s block id — the `at` on its <nt-diagram> stub, or its id in an expanded read.',
  );
/** Said once, because all three context tools take the same thing. */
const contextIdArg = z
  .string()
  .describe(
    'An id from search_context or expand_context, a page id, or a file as "owner/repo:path".',
  );

export const TOOLS = {
  list_pages: {
    side: "server",
    mutates: false,
    surfaces: ["chat"],
    description:
      "List the pages in this project. Returns each page's id, title and position.",
    inputSchema: z.object({}),
  },
  read_page: {
    side: "client",
    mutates: false,
    surfaces: ["chat"],
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
          "Block ids to read whole. A diagram reads as a stub carrying its " +
            'words and an at="…" address; expanding it gives every shape, ' +
            "style and path, however large. Expand the one you mean to match, " +
            "copy from or edit; a stub is all you need to keep, move or " +
            "replace it.",
        ),
    }),
  },
  open_page: {
    side: "client",
    mutates: false,
    surfaces: ["chat"],
    description:
      "Put a page on screen and wait for its document to load. Do this before " +
      "working on a page; it is what makes that page the open one.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
    }),
  },
  read_open_page: {
    side: "client",
    mutates: false,
    surfaces: ["chat"],
    description:
      "Read the page that is open, as it stands right now — including anything " +
      "typed or changed since it was last saved. Returns Nootles HTML.",
    inputSchema: z.object({
      expand: z
        .array(z.string())
        .optional()
        .describe("As on read_page: block ids to read in full."),
    }),
  },
  edit_page: {
    side: "client",
    mutates: true,
    surfaces: ["chat"],
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
    side: "server",
    mutates: true,
    surfaces: ["chat"],
    description:
      "Draw ONE STORYBOARD SHOT. A drawing specialist holds the pen, and for " +
      "now the pen is only for storyboards: a screen, a mockup, a diagram or " +
      "a standalone illustration is not drawn here — a screen or a diagram " +
      "you write in the canvas grammar with edit_page, shape by shape. " +
      "Returns a REF naming the drawing, which you place by writing " +
      '<nt-diagram ref="THAT REF"></nt-diagram> inside the shot in your ' +
      "edit_page HTML — never the drawing itself, which you are not shown " +
      "and do not need. Nothing touches the page until you place it. Call " +
      "this several times in parallel — one call per shot.",
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
        .describe(
          "The board's own ratio, copied from its <nt-storyboard " +
            'ratio="…">. The shot\'s frame is worked out from it. Getting ' +
            "this wrong is what makes a picture too big for its shot.",
        ),
    }),
  },
  album_edit: {
    side: "client",
    mutates: true,
    surfaces: ["chat"],
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
    side: "server",
    mutates: false,
    surfaces: ["chat"],
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
    side: "client",
    mutates: false,
    surfaces: ["chat"],
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
    side: "server",
    mutates: false,
    surfaces: ["chat"],
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
    side: "server",
    mutates: false,
    surfaces: ["chat"],
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
    side: "server",
    mutates: false,
    surfaces: ["chat"],
    description:
      "Search the web for something the project does not already say. Returns a " +
      "written answer and the pages it came from.",
    inputSchema: z.object({
      query: z.string().describe("A full question, not keywords."),
      maxResults: z.number().int().min(1).max(10).optional(),
    }),
  },
  search_context: {
    side: "server",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "Search this project's context for what it says about something — pages " +
      "by their words as well as their titles, linked code by file path, " +
      "exported names and leading comments, and the code's areas and concerns. " +
      "Returns each match's id, kind, title, a one-line brief and who owns it, " +
      "best first. Use it before asking the user something the project may " +
      "already say.",
    inputSchema: z.object({
      query: z.string().describe("Words the thing would be written in, not a question."),
      limit: z.number().int().min(1).max(10).optional(),
    }),
  },
  expand_context: {
    side: "server",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "What a context item is connected to. A page: the pages it mentions and " +
      "the pages that mention it. A concern: its files and the concerns it works " +
      "with. A file: its concern, what it imports and what imports it. An area " +
      "or repository: what it contains. For following a thread from something " +
      "you have found to what is around it.",
    inputSchema: z.object({ id: contextIdArg }),
  },
  read_context: {
    side: "server",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "A context item's summary and who owns it. For a code file, its whole text " +
      "as well, fetched from GitHub. For a page, read_page is the whole of it.",
    inputSchema: z.object({ id: contextIdArg }),
  },
  create_page: {
    side: "server",
    mutates: true,
    surfaces: ["chat"],
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
    side: "server",
    mutates: true,
    surfaces: ["chat"],
    description:
      "Retitle a page. A title is not part of the page's HTML, so this is the " +
      "only way to change one.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
      title: z.string().describe("The new title, replacing the old one outright."),
    }),
  },
  delete_page: {
    side: "server",
    mutates: true,
    surfaces: ["chat"],
    description:
      "Delete a page, and with it every diagram, checkpoint and edit ever made " +
      "on it. This cannot be undone, so ask for it only when the user has asked " +
      "for it. They are shown what is about to go and have to allow it before " +
      "anything happens; read the result, because they can refuse.",
    inputSchema: z.object({
      pageId: z.string().describe("A page id from list_pages."),
    }),
  },

  // -------------------------------------------------------------------
  // The node-level diagram tools (TOOLS.md §5). All 13 act on the diagram's
  // block id — the `at` on its <nt-diagram> stub — on the open page unless
  // `pageId` says otherwise. Every one goes through the same validate+apply
  // gate `edit_page` does and lands as one reviewable change; the shared
  // executor lives in `app/lib/ai/canvas/execute.ts`.
  // -------------------------------------------------------------------
  get_geometry: {
    side: "client",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "Where everything on a diagram is: every shape's box in canvas pixels " +
      "after layout — x, y, w, h from the top-left, rot in degrees — with its " +
      "kind, name, parent and depth, and the points each connector runs " +
      "through. This is the one place to learn positions: the x/y in the HTML " +
      "are relative to the parent, and inside a flex or grid group they are " +
      "not written at all. Ask before you place, align or measure anything.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z
        .array(z.string())
        .optional()
        .describe("Only these nodes and their descendants. Everything if left out."),
      depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How many levels under a top-level shape to list. All if left out."),
    }),
  },

  get_styles: {
    side: "client",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "What everything on a diagram looks like: each shape's CSS exactly as " +
      "authored, and beside it the same declarations with every var() " +
      "resolved, so you can match a colour without guessing what a token " +
      "stands for. Also the diagram's own tokens — its --custom properties — " +
      "and for a drawn kind the fill and stroke it actually paints with. Use " +
      "it to match a look; use update_styles to change one.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).optional(),
    }),
  },

  get_html: {
    side: "client",
    mutates: false,
    surfaces: ["chat", "mcp"],
    description:
      "The diagram as standard HTML and CSS — divs, inline svg and real flex " +
      "or grid — that pastes into a web page and looks the same; with jsx it " +
      "comes back as a React component. Read-only: it is how a drawing leaves " +
      "for a codebase, not how it is edited. Ask for a few ids to get just " +
      "those shapes.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).optional(),
      jsx: z.boolean().optional(),
    }),
  },

  write_nodes: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Change a few shapes on a diagram without rewriting it. Send <nt-…> " +
      "elements in the canvas grammar. An element WITH an id the diagram has " +
      "rewrites that shape in place — its box, rotation, style, label, and " +
      "for a group the children you list (children you leave out stay). An " +
      "element WITHOUT an id is a new shape, placed after the previous " +
      "element you sent, or where `at` says. An id the diagram does not have " +
      "is a new shape under that id, which is how an <nt-edge> can name one " +
      "you are adding. Delete by listing ids in `removing`. Blocks of prose, " +
      "other diagrams and drawings are not written here — that is edit_page. " +
      "The change is applied and shown to the user, who can keep or discard it.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      html: z
        .string()
        .describe(
          "The elements as they should read, in the order they should read. " +
            "Full elements — a shape you rewrite carries its whole box and " +
            "style as the read gave it.",
        ),
      removing: z
        .array(z.string())
        .optional()
        .describe(
          "Shape and connector ids to delete. Deleting a group deletes what " +
            "is inside it; connectors into a deleted shape go with it.",
        ),
      at: z
        .union([
          z.object({ after: z.string() }),
          z.object({ before: z.string() }),
          z.object({ inside: z.string().nullable() }),
        ])
        .optional()
        .describe(
          "Where new elements go: after or before a shape, inside a group " +
            "(null for the canvas itself). Left out, they go in front of " +
            "everything, at the top level.",
        ),
    }),
  },

  update_styles: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      'Restyle many shapes at once — the cheapest way to say "make these all ' +
      'blue" or "round every card". Each patch names ids and the declarations ' +
      "to set; null removes a declaration. Ids may be shapes, connectors, or " +
      '"diagram" for the surface itself, which is where a token like --brand ' +
      "lives. Geometry is not style: to move or resize, use move or write_nodes.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      patches: z
        .array(
          z.object({
            ids: z.array(z.string()).min(1),
            style: z.record(z.string(), z.string().nullable()),
          }),
        )
        .min(1),
    }),
  },

  set_text: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "The words on one shape or connector, replaced. Plain text; with markup " +
      "the text is read as a label in the canvas grammar (<b>, <span style>, " +
      "<p>, lists, <nt-ref>). A path, image or group holds no words.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      id: z.string(),
      text: z.string(),
      markup: z.boolean().optional(),
    }),
  },

  rename: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "A shape's layers-panel name. Null clears it, so the name follows the " +
      "label again. Never changes what the shape shows.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      id: z.string(),
      name: z.string().nullable(),
    }),
  },

  duplicate: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Copies of shapes, offset 10px like Figma, landed in front of their " +
      "originals — placed by its group's layout instead, inside a flex or " +
      "grid group. Returns the new ids.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
      offset: z.number().optional(),
    }),
  },

  move: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Move shapes by a distance, or put one at a position. Positions are in " +
      "the PARENT's space, as x/y in the HTML are. A child of a flex or grid " +
      "group cannot be moved — its group places it; reorder it instead.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
      dx: z.number().optional(),
      dy: z.number().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }),
  },

  delete: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Remove shapes and connectors from a diagram. A group goes with " +
      "everything in it; connectors into a removed shape go too.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
    }),
  },

  reorder: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Change what is in front: front, back, forward, backward — within the " +
      "shape's own group, as in Figma — or a place in a group: parent (null " +
      "for the canvas) and index counting from the back, 0 being furthest " +
      "back. Putting a shape in another group keeps it where it is on screen " +
      "— unless that group has a layout (flex or grid), which places it by " +
      "flow instead; result.notes says so when it happens.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
      to: z.union([
        z.enum(["front", "back", "forward", "backward"]),
        z.object({ parent: z.string().nullable(), index: z.number().int().min(0) }),
      ]),
    }),
  },

  group: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Wrap shapes in a new group, keeping every one where it is on screen. " +
      "An empty, unlabelled, unrotated rectangle that is the ONLY member " +
      "enclosing every other member becomes the group's own box and paint " +
      "instead of a child, like Figma's frame selection — a labelled rect, a " +
      "rotated one, or two candidates that both qualify all fall back to " +
      "plain grouping, with the candidate(s) kept as ordinary children. With " +
      "op the group is a boolean: union, subtract, intersect, exclude. " +
      "Returns the group's id.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
      name: z.string().optional(),
      op: z.enum(["union", "subtract", "intersect", "exclude"]).optional(),
    }),
  },

  ungroup: {
    side: "client",
    mutates: true,
    surfaces: ["chat", "mcp"],
    description:
      "Dissolve groups, splicing their children into their place with " +
      "positions preserved.",
    inputSchema: z.object({
      pageId: pageIdArg,
      blockId: blockIdArg,
      ids: z.array(z.string()).min(1),
    }),
  },
} satisfies Record<
  string,
  {
    description: string;
    inputSchema: z.ZodType;
    side: "server" | "client";
    mutates: boolean;
    surfaces: readonly ToolSurface[];
  }
>;

/** In the chat deployment: "server" answers inside the route, "client" ends
 *  the step and runs in the browser. */
export type ToolSurface = "chat" | "mcp";

export type ToolSpec = {
  description: string;
  inputSchema: z.ZodType;
  side: "server" | "client";
  /** Changes the document or the project. A read tool is always false. */
  mutates: boolean;
  /** Agent surfaces allowed to offer it — an MCP adapter loops `TOOLS`
   *  filtered by `"mcp"`. */
  surfaces: readonly ToolSurface[];
};

export type ToolName = keyof typeof TOOLS;

/** One wrong-id sentence for both halves of the tool set, so a model learns it once. */
export const noSuchPage = (pageId: string) =>
  `There is no page with id "${pageId}" in this project. Call list_pages for the ids that exist.`;

/**
 * Tools the browser runs — every entry whose `side` is `"client"`.
 *
 * `read_page` has to turn the stored ProseMirror document back into BlockNote
 * blocks, which needs BlockNote's schema — and our block specs are client
 * components, so a route handler receives them as client references with no
 * node spec and the schema cannot be built there at all (measured: "Cannot read
 * properties of undefined (reading 'node')"). The browser already holds the
 * editor, so the read happens where the write will.
 *
 * `edit_page`, `album_edit` and `look_at` could only ever run here too: two
 * move or read what is on screen, and `edit_page` runs the applier, which
 * needs the live editor — there is one applier and it is the one a human
 * edit goes through. The 13 node-level diagram tools join them for the same
 * reason `edit_page` is client-side: they act on the live `SceneStore` or the
 * live editor, neither of which a route handler has.
 *
 * Derived from `side` rather than hand-kept, so a tool's own table entry is
 * the only place that decides which side it runs on.
 */
export type ClientToolName = {
  [K in ToolName]: (typeof TOOLS)[K]["side"] extends "client" ? K : never;
}[ToolName];

export const CLIENT_TOOLS: readonly ClientToolName[] = (Object.keys(TOOLS) as ToolName[]).filter(
  (name) => TOOLS[name].side === "client",
) as ClientToolName[];

export function isClientTool(name: string): name is ClientToolName {
  return (CLIENT_TOOLS as readonly string[]).includes(name);
}

/**
 * The 13 node-level diagram tools (TOOLS.md §5) — every `write_nodes`-and-
 * beyond tool that acts on a diagram by shape id rather than rewriting the
 * whole block. `app/lib/ai/canvas/execute.ts`'s `runCanvasTool` is the one
 * executor behind all 13; `clientTools.ts` registers each name against it.
 */
export const CANVAS_TOOLS = [
  "get_geometry",
  "get_styles",
  "get_html",
  "write_nodes",
  "update_styles",
  "set_text",
  "rename",
  "duplicate",
  "move",
  "delete",
  "reorder",
  "group",
  "ungroup",
] as const satisfies readonly ClientToolName[];

export type CanvasToolName = (typeof CANVAS_TOOLS)[number];

