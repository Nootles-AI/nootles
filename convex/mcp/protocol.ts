import { MCP_APP_HTML, MCP_APP_URI, MCP_APP_MIME } from "./app";

/**
 * The MCP server itself: JSON-RPC in, JSON-RPC out, over whatever the HTTP
 * handler hands it. Pure — the backend is injected — so every method, refusal
 * and edge of the wire format is testable without a deployment.
 *
 * Streamable HTTP, stateless: every POST carries one message (or a batch, for
 * the older revisions that allowed them) and gets its answer in the response
 * body. There is no session and no server-initiated stream; nothing here needs
 * one. No tool reaches a model provider. `edit_doc` and `undo_edit` write, and
 * only through a grant holding `docs:write` (NT-123).
 */

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SERVER_INFO = { name: "nootles", title: "Nootles", version: "1.0.0" };

export type DocListing = {
  total: number;
  docs: Array<{
    docId: string;
    pageId: string;
    projectId: string;
    title: string;
    projectTitle: string;
    updatedAt: number;
    snippet?: string;
    blockCount?: number;
  }>;
};

export type DocRead =
  | {
      status: "ok";
      doc: { docId: string; pageId: string; projectId: string; title: string; projectTitle: string; updatedAt: number };
      text: string;
      truncated: boolean;
      blockCount: number;
      outline: {
        blocks: Array<{ id: string; type: string; depth: number; text: string; level?: number; checked?: boolean; language?: string }>;
        total: number;
        truncated: boolean;
      };
    }
  | { status: "refused"; reason: "not-found" | "not-served" | "too-large" | "corrupt"; detail?: string };

type DocRef = { docId: string; pageId: string; projectId: string; title: string; projectTitle: string };
export type EditChange = { kind: "added" | "changed" | "removed" | "moved"; id: string; type: string; text: string };

export type DocEdit =
  | { status: "applied"; editId: string; doc: DocRef; changes: EditChange[]; created: Record<string, string>; blockCount: number }
  | { status: "replayed"; editId: string; doc: DocRef }
  | { status: "rejected"; code: string; message: string; operationIndex?: number }
  | { status: "refused"; reason: "not-found" | "not-served" | "too-large" | "no-write" | "busy" | "rate-limited"; detail?: string };

export type DocUndo =
  | { status: "undone"; docId: string; pageId: string; projectId: string; title: string }
  | {
      status: "refused";
      reason:
        | "not-found"
        | "not-served"
        | "no-write"
        | "already-undone"
        | "expired"
        | "too-large"
        | "changed-since"
        | "inexact"
        | "busy"
        | "rate-limited";
      ids?: string[];
    };

export type WriteRefusal = "no-write" | "not-found" | "not-served" | "serving-off" | "quota" | "rate-limited";
export type ProjectListing = {
  projects: Array<{ projectId: string; title: string; description?: string; pages: number; served: number; updatedAt: number }>;
  truncated: boolean;
};
export type Created =
  | { status: "created"; projectId: string; projectTitle: string; pageId: string; docId: string; title: string }
  | { status: "refused"; reason: WriteRefusal };
export type Renamed =
  | { status: "renamed"; target: "page" | "project"; id: string; from: string; to: string; projectId: string; pageId?: string }
  | { status: "refused"; reason: WriteRefusal };
export type Trashed =
  | { status: "trashed"; docId: string; title: string; projectTitle: string }
  | { status: "refused"; reason: WriteRefusal };
export type SearchResults = {
  scanned: number;
  total: number;
  hits: Array<{
    docId: string;
    pageId: string;
    projectId: string;
    title: string;
    projectTitle: string;
    matches: Array<{ blockId: string; type: string; text: string }>;
    more: number;
  }>;
};

export type McpBackend = {
  listDocs(args: { query?: string; limit: number }): Promise<DocListing>;
  listProjects(): Promise<ProjectListing>;
  searchDocs(args: { query: string; limit: number }): Promise<SearchResults>;
  createProject(args: { title: string; description?: string; pageTitle?: string }): Promise<Created>;
  createPage(args: { project: string; title?: string }): Promise<Created>;
  rename(args: { target: "page" | "project"; ref: string; title: string }): Promise<Renamed>;
  trashPage(args: { ref: string }): Promise<Trashed>;
  readDoc(args: { ref: string; focusBlockId?: string; window?: number }): Promise<DocRead>;
  editDoc(args: { ref: string; operations: unknown; idempotencyKey?: string }): Promise<DocEdit>;
  undoEdit(args: { editId: string }): Promise<DocUndo>;
  /** Whether this connection was granted `docs:write`. */
  canWrite: boolean;
  /** Where "Open in Nootles" goes; null when the deployment has no app URL. */
  appUrl: string | null;
};

type Id = string | number;
type Request = { jsonrpc: "2.0"; id?: Id; method: string; params?: Record<string, unknown> };
export type Response =
  | { jsonrpc: "2.0"; id: Id | null; result: unknown }
  | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string; data?: unknown } };

export const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const INSTRUCTIONS = [
  "Nootles is a planning tool whose pages mix structured text with diagrams.",
  "These tools work on the connected person's own Nootles pages that are served from the canonical NML document tree.",
  "Call list_docs (or search_docs, or list_projects) to see what is available, then read_doc with a docId.",
  "read_doc returns every block tagged ⟦id⟧; ids are stable across reads, so cite and edit blocks by id.",
  "edit_doc changes a page through typed operations on those ids; read the page first, keep each edit to one coherent change, and tell the person what you changed.",
  "create_project and create_page make new pages, ready to read and edit at once (create_page can fill the page in the same call); rename renames a page or project; trash_page moves a page to the app's Trash, where the person can restore it.",
  "Every edit shows on the page at once, is attributed to you, and can be undone by the person or with undo_edit.",
].join(" ");

const LIST_TOOL = {
  name: "list_docs",
  title: "List Nootles documents",
  description:
    "List the Nootles documents you can read: the connected person's own pages that are served from the canonical NML tree, " +
    "most recently edited first. Pages not yet on NML are not listed. Each entry has a title, project, last edit, " +
    "first words and the docId to pass to read_doc.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Only documents whose title or project contains this text (case-insensitive)." },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many documents to return." },
    },
    additionalProperties: false,
  },
  annotations: { title: "List Nootles documents", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const READ_TOOL = {
  name: "read_doc",
  title: "Read a Nootles document",
  description:
    "Read one Nootles document's live content as text. Every block is tagged ⟦id⟧ and keeps that id across reads, so blocks " +
    "can be cited exactly. Headings, lists, check items, tables, code, math, media and diagrams (as shape outlines) are included. " +
    "`doc` accepts a docId from list_docs, a page id, or a Nootles page URL. For a long document, pass focus_block_id and window " +
    "to read only the top-level blocks around one block.",
  inputSchema: {
    type: "object",
    properties: {
      doc: { type: "string", description: "A docId from list_docs, a page id, or a Nootles page URL." },
      focus_block_id: { type: "string", description: "Read only the region around this block." },
      window: { type: "integer", minimum: 0, maximum: 50, default: 5, description: "Top-level blocks either side of focus_block_id." },
    },
    required: ["doc"],
    additionalProperties: false,
  },
  annotations: { title: "Read a Nootles document", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const RUNS = {
  description:
    'Inline content: a plain string, or a list of runs — {"type":"text","text":"…","marks":["bold"|"italic"|"underline"|"strike"|"code"]}, ' +
    '{"type":"link","href":"https://…","content":[text runs]}, {"type":"math","latex":"…"}, {"type":"pageRef","pageId":"…","title":"…"}, ' +
    '{"type":"checkbox","checked":true}.',
  anyOf: [{ type: "string" }, { type: "array", items: { type: "object" } }],
};

const POSITION = {
  type: "object",
  description: 'Where: {"at":"after","ref":"<id>"}, {"at":"before","ref":"<id>"}, {"at":"docStart"} or {"at":"docEnd"}.',
  properties: { at: { type: "string", enum: ["after", "before", "docStart", "docEnd"] }, ref: { type: "string" } },
  required: ["at"],
};

const NEW_BLOCK = {
  type: "object",
  description:
    "A block to create. tempId is any name you choose; the result maps it to the block's real id, and later operations in the " +
    "same edit may use it as a ref. Types: paragraph, heading (props.level 1–3), bulletListItem, numberedListItem, checkListItem " +
    "(props.checked), toggleListItem, quote, codeBlock (props.language, props.code), mathBlock, table (rows), divider, image/video/audio/file " +
    "(props.url, props.caption). children nests list items under this one.",
  properties: {
    tempId: { type: "string" },
    type: { type: "string" },
    props: { type: "object" },
    content: RUNS,
    rows: { type: "array", description: "Table cells: rows of cells, each cell inline content.", items: { type: "array" } },
    headerRows: { type: "integer", minimum: 0 },
    children: { type: "array", items: { type: "object" } },
  },
  required: ["tempId", "type"],
};

const EDIT_TOOL = {
  name: "edit_doc",
  title: "Edit a Nootles document",
  description:
    "Change one Nootles document with a list of operations, applied together as one edit: all of them or none. Address blocks by the " +
    "⟦id⟧ read_doc shows; read the document first. The edit appears at once in any open copy of the page, is marked as yours, and " +
    "the person can undo it (so can you, with undo_edit and the editId this returns). Operations:\n" +
    '- {"kind":"setBlockContent","blockId","content"} — replace a block\'s text.\n' +
    '- {"kind":"insertBlocks","at":position,"blocks":[new blocks]} — add blocks.\n' +
    '- {"kind":"updateBlockProps","blockId","props"} — e.g. {"checked":true}, {"level":2}, {"language":"ts","code":"…"}.\n' +
    '- {"kind":"moveBlock","blockId","to":position} and {"kind":"removeBlock","blockId"}.\n' +
    '- {"kind":"setTableRows","blockId","rows","headerRows"?}, {"kind":"setMathRows","blockId","rows":["latex",…]}, ' +
    '{"kind":"updateMathRow","blockId","rowIndex","latex"}.\n' +
    "Diagrams, albums and storyboards are read-only here. If an operation cannot apply (a missing id, a wrong block type) nothing " +
    "changes and the error says which operation failed.",
  inputSchema: {
    type: "object",
    properties: {
      doc: { type: "string", description: "A docId from list_docs, a page id, or a Nootles page URL." },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        description: "Applied in order, as one edit.",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["insertBlocks", "setBlockContent", "updateBlockProps", "moveBlock", "removeBlock", "setTableRows", "setMathRows", "updateMathRow"],
            },
            blockId: { type: "string" },
            at: POSITION,
            to: POSITION,
            blocks: { type: "array", items: NEW_BLOCK },
            content: RUNS,
            props: { type: "object" },
            rows: { type: "array" },
            headerRows: { type: "integer", minimum: 0 },
            rowIndex: { type: "integer", minimum: 0 },
            latex: { type: "string" },
          },
          required: ["kind"],
        },
      },
      idempotency_key: {
        type: "string",
        description: "Optional. Retrying with the same key never applies the edit twice.",
      },
    },
    required: ["doc", "operations"],
    additionalProperties: false,
  },
  annotations: { title: "Edit a Nootles document", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const UNDO_TOOL = {
  name: "undo_edit",
  title: "Undo a Nootles edit",
  description:
    "Take back one edit_doc edit exactly, by the editId it returned. Refused, with nothing changed, if the person has since edited " +
    "what that edit touched — undoing would take their work too. Edits stay undoable for 7 days.",
  inputSchema: {
    type: "object",
    properties: { edit_id: { type: "string", description: "The editId an edit_doc result gave." } },
    required: ["edit_id"],
    additionalProperties: false,
  },
  annotations: { title: "Undo a Nootles edit", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const SEARCH_TOOL = {
  name: "search_docs",
  title: "Search Nootles documents",
  description:
    "Find text across the connected person's served Nootles pages: titles and every block (headings, lists, tables, code, diagram labels), " +
    "case-insensitive. Each hit names the page (docId) and the matching blocks by ⟦id⟧, so read_doc with focus_block_id can open right there.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, description: "Words to find." },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many pages to return." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { title: "Search Nootles documents", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const PROJECTS_TOOL = {
  name: "list_projects",
  title: "List Nootles projects",
  description:
    "List the connected person's own Nootles projects (personal, not team workspaces), most recently active first, with how many pages each has " +
    "and how many of those can be read here. Use a projectId or exact project title with create_page or rename.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List Nootles projects", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const CREATE_PROJECT_TOOL = {
  name: "create_project",
  title: "Create a Nootles project",
  description:
    "Create a new personal project with one blank page, as Nootles' own New project does. Returns the page's docId: fill it with edit_doc, " +
    "or add more pages with create_page. Counts against the person's plan's project limit.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, description: "The project's name." },
      description: { type: "string", description: "Optional: what the project is about. Nootles' own AI reads it as the project's context." },
      page_title: { type: "string", description: "Optional title for its first page." },
    },
    required: ["title"],
    additionalProperties: false,
  },
  annotations: { title: "Create a Nootles project", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const CREATE_PAGE_TOOL = {
  name: "create_page",
  title: "Create a Nootles page",
  description:
    "Create a new page at the end of one of the person's projects, ready to read and edit at once. Pass `operations` (the same list edit_doc takes, " +
    'usually one {"kind":"insertBlocks","at":{"at":"docStart"},"blocks":[…]}) to fill it in the same call; the new page starts with one empty ' +
    "paragraph, which insertBlocks at docStart writes above.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "A projectId from list_projects, or the project's exact title." },
      title: { type: "string", description: "The page's title." },
      operations: { type: "array", maxItems: 100, description: "Optional: edit_doc operations to fill the page with.", items: { type: "object" } },
    },
    required: ["project"],
    additionalProperties: false,
  },
  annotations: { title: "Create a Nootles page", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const RENAME_TOOL = {
  name: "rename",
  title: "Rename a Nootles page or project",
  description: "Rename one of the person's pages (by docId, page id or URL) or projects (by projectId or exact title).",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["page", "project"] },
      ref: { type: "string", description: "Which page or project." },
      title: { type: "string", description: "The new name." },
    },
    required: ["target", "ref", "title"],
    additionalProperties: false,
  },
  annotations: { title: "Rename a Nootles page or project", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

const TRASH_TOOL = {
  name: "trash_page",
  title: "Move a Nootles page to the trash",
  description:
    "Move one of the person's pages to Nootles' Trash — the sidebar's Delete. It disappears everywhere, and the person can restore it from the Trash " +
    "until it is purged. Confirm with the person before calling this.",
  inputSchema: {
    type: "object",
    properties: { doc: { type: "string", description: "A docId, page id or page URL." } },
    required: ["doc"],
    additionalProperties: false,
  },
  annotations: { title: "Move a Nootles page to the trash", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  _meta: { ui: { resourceUri: MCP_APP_URI } },
};

export const TOOLS = [LIST_TOOL, READ_TOOL, SEARCH_TOOL, PROJECTS_TOOL, EDIT_TOOL, UNDO_TOOL, CREATE_PROJECT_TOOL, CREATE_PAGE_TOOL, RENAME_TOOL, TRASH_TOOL];

const APP_RESOURCE = {
  uri: MCP_APP_URI,
  name: "nootles_documents",
  title: "Nootles documents",
  description: "The card Nootles tool results are shown in.",
  mimeType: MCP_APP_MIME,
};

function pageUrl(appUrl: string | null, doc: { projectId: string; pageId: string }): string | null {
  if (!appUrl) return null;
  return `${appUrl.replace(/\/$/, "")}/p/${encodeURIComponent(doc.projectId)}?page=${encodeURIComponent(doc.pageId)}`;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

function toolError(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

const REFUSALS: Record<Extract<DocRead, { status: "refused" }>["reason"], string> = {
  "not-found": "No document you own matches that reference. Use list_docs to find a docId.",
  "not-served":
    "That document is not served from the canonical NML tree yet, so it cannot be read over MCP. Opening it in Nootles migrates it; try again once it has been verified.",
  "too-large": "That document is too large to read in one request.",
  corrupt: "That document could not be decoded. Nothing was read.",
};

async function listDocs(args: Record<string, unknown>, backend: McpBackend) {
  const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined;
  const rawLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 20;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit)));
  const listing = await backend.listDocs({ query, limit });
  const docs = listing.docs.map((d) => ({ ...d, url: pageUrl(backend.appUrl, d) }));
  const lines = [
    listing.total === 0
      ? query
        ? `No served documents match "${query}".`
        : "No documents are served over MCP yet. A page becomes readable once it has migrated to the canonical NML tree."
      : `${docs.length} of ${listing.total} served document${listing.total === 1 ? "" : "s"}${query ? ` matching "${query}"` : ""}, most recently edited first:`,
    "",
    ...docs.flatMap((d, i) => [
      `${i + 1}. ${d.title || "Untitled"} — project "${d.projectTitle || "Untitled"}", edited ${day(d.updatedAt)}`,
      `   docId: ${d.docId}`,
      ...(d.snippet ? [`   ${d.snippet}`] : []),
    ]),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n").trimEnd() }],
    structuredContent: { kind: "docList", query: query ?? null, total: listing.total, docs, appUrl: backend.appUrl },
  };
}

async function readDoc(args: Record<string, unknown>, backend: McpBackend) {
  if (typeof args.doc !== "string" || !args.doc.trim()) return null;
  const focusBlockId = typeof args.focus_block_id === "string" && args.focus_block_id ? args.focus_block_id : undefined;
  const window = typeof args.window === "number" && Number.isFinite(args.window) ? args.window : undefined;
  const read = await backend.readDoc({ ref: args.doc, focusBlockId, window });
  if (read.status === "refused") return toolError(REFUSALS[read.reason]);
  const url = pageUrl(backend.appUrl, read.doc);
  const header = [
    `# ${read.doc.title || "Untitled"}`,
    `Project: ${read.doc.projectTitle || "Untitled"} · Last edited: ${new Date(read.doc.updatedAt).toISOString()} · docId: ${read.doc.docId}`,
    ...(url ? [`Open in Nootles: ${url}`] : []),
    `${read.blockCount} blocks${focusBlockId ? ` · showing the region around ⟦${focusBlockId}⟧` : ""}`,
    "",
  ];
  const footer = read.truncated
    ? ["", "[Truncated. Pass focus_block_id (an ⟦id⟧ near where you stopped) and window to read further.]"]
    : [];
  return {
    content: [{ type: "text", text: [...header, read.text, ...footer].join("\n") }],
    structuredContent: {
      kind: "doc",
      doc: { ...read.doc, url },
      blockCount: read.blockCount,
      truncated: read.truncated,
      outline: read.outline,
    },
  };
}

const READ_ONLY =
  "This connection can only read. To let it edit, disconnect Nootles in your MCP client (or in Nootles Settings → Agents), " +
  "connect again, and leave “Allow edits” on.";

const EDIT_REFUSALS: Record<Extract<DocEdit, { status: "refused" }>["reason"], string> = {
  ...REFUSALS,
  "no-write": READ_ONLY,
  busy: "The page kept changing while the edit was being made, so nothing was changed. Read it again and retry.",
  "rate-limited": "Too many edits in a short time, so nothing was changed. Wait a little, then retry.",
};

const VERB: Record<EditChange["kind"], string> = { added: "Added", changed: "Changed", removed: "Removed", moved: "Moved" };

async function editDoc(args: Record<string, unknown>, backend: McpBackend) {
  if (typeof args.doc !== "string" || !args.doc.trim()) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const idempotencyKey = typeof args.idempotency_key === "string" && args.idempotency_key ? args.idempotency_key.slice(0, 200) : undefined;
  const edit = await backend.editDoc({ ref: args.doc, operations: args.operations, idempotencyKey });
  if (edit.status === "refused") {
    const wait = edit.reason === "rate-limited" && edit.detail ? ` (about ${edit.detail}s)` : "";
    return toolError(EDIT_REFUSALS[edit.reason] + wait);
  }
  if (edit.status === "rejected") {
    const where = edit.operationIndex !== undefined ? ` (operation ${edit.operationIndex})` : "";
    return toolError(`Nothing was changed: ${edit.message}${where}. [${edit.code}]`);
  }
  const url = pageUrl(backend.appUrl, edit.doc);
  if (edit.status === "replayed") {
    return {
      content: [{ type: "text", text: `That edit was already made (editId: ${edit.editId}); nothing new was changed.` }],
      structuredContent: { kind: "edit", replayed: true, editId: edit.editId, doc: { ...edit.doc, url }, changes: [], created: {} },
    };
  }
  const created = Object.entries(edit.created);
  const lines = [
    `Edited "${edit.doc.title || "Untitled"}" — ${edit.changes.length} change${edit.changes.length === 1 ? "" : "s"}. editId: ${edit.editId}`,
    ...edit.changes.map((c) => `- ${VERB[c.kind]} ⟦${c.id}⟧ ${c.type}${c.text ? `: ${c.text}` : ""}`),
    ...(created.length ? ["", `New block ids: ${created.map(([temp, id]) => `${temp} → ${id}`).join(", ")}`] : []),
    "",
    "The person sees this on the page and can undo it; so can you, with undo_edit.",
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "edit",
      editId: edit.editId,
      doc: { ...edit.doc, url },
      changes: edit.changes,
      created: edit.created,
      blockCount: edit.blockCount,
    },
  };
}

const UNDO_REFUSALS: Record<Extract<DocUndo, { status: "refused" }>["reason"], string> = {
  "not-found": "No edit of yours has that editId.",
  "not-served": REFUSALS["not-served"],
  "no-write": READ_ONLY,
  "already-undone": "That edit was already undone.",
  expired: "That edit is too old to undo; edits stay undoable for 7 days.",
  "too-large": REFUSALS["too-large"],
  "changed-since": "Nothing was changed: the page has been edited since, where this edit touched, and undoing it would take that work too. Make a new edit instead.",
  inexact: "Nothing was changed: this edit can no longer be taken back exactly. Make a new edit instead.",
  busy: "The page kept changing while undoing, so nothing was changed. Try again.",
  "rate-limited": "Too many edits in a short time, so nothing was changed. Wait a little, then retry.",
};

async function undoEdit(args: Record<string, unknown>, backend: McpBackend) {
  if (typeof args.edit_id !== "string" || !args.edit_id.trim()) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const undo = await backend.undoEdit({ editId: args.edit_id.trim() });
  if (undo.status === "refused") {
    const ids = undo.ids?.length ? ` Blocks: ${undo.ids.map((id) => `⟦${id}⟧`).join(", ")}.` : "";
    return toolError(UNDO_REFUSALS[undo.reason] + ids);
  }
  const url = pageUrl(backend.appUrl, undo);
  return {
    content: [{ type: "text", text: `Undone. "${undo.title || "Untitled"}" is back to how it was before that edit.` }],
    structuredContent: { kind: "undo", editId: args.edit_id.trim(), doc: { docId: undo.docId, pageId: undo.pageId, projectId: undo.projectId, title: undo.title, url } },
  };
}

const WRITE_REFUSALS: Record<WriteRefusal, string> = {
  "no-write": READ_ONLY,
  "not-found": "No project or page of yours matches that. Use list_projects or list_docs to find it.",
  "not-served": REFUSALS["not-served"],
  "serving-off": "Serving pages over MCP is turned off right now, so nothing was created.",
  quota: "The person's plan has no room for another project. Nothing was created.",
  "rate-limited": "Too many changes in a short time, so nothing was changed. Wait a little, then retry.",
};

async function searchDocs(args: Record<string, unknown>, backend: McpBackend) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return null;
  const rawLimit = typeof args.limit === "number" && Number.isFinite(args.limit) ? args.limit : 10;
  const found = await backend.searchDocs({ query, limit: Math.max(1, Math.min(50, Math.floor(rawLimit))) });
  const hits = found.hits.map((h) => ({ ...h, url: pageUrl(backend.appUrl, h) }));
  const partial = found.scanned < found.total ? ` (searched the ${found.scanned} most recently edited of ${found.total} pages)` : "";
  const lines = [
    hits.length ? `"${query}" is on ${hits.length} page${hits.length === 1 ? "" : "s"}${partial}:` : `"${query}" is on none of your pages${partial}.`,
    "",
    ...hits.flatMap((h, i) => [
      `${i + 1}. ${h.title || "Untitled"} — project "${h.projectTitle || "Untitled"}" · docId: ${h.docId}`,
      ...h.matches.map((m) => `   ⟦${m.blockId}⟧ ${m.text}`),
      ...(h.more ? [`   …and ${h.more} more block${h.more === 1 ? "" : "s"}`] : []),
    ]),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n").trimEnd() }],
    structuredContent: { kind: "search", query, scanned: found.scanned, total: found.total, hits, appUrl: backend.appUrl },
  };
}

async function listProjects(backend: McpBackend) {
  const listing = await backend.listProjects();
  const projects = listing.projects.map((p) => ({ ...p, url: backend.appUrl ? `${backend.appUrl.replace(/\/$/, "")}/p/${encodeURIComponent(p.projectId)}` : null }));
  const lines = [
    projects.length ? `${projects.length} project${projects.length === 1 ? "" : "s"}, most recently active first:` : "No personal projects yet. create_project makes one.",
    "",
    ...projects.map((p, i) => `${i + 1}. ${p.title || "Untitled"} — ${p.pages} page${p.pages === 1 ? "" : "s"} (${p.served} readable here) · projectId: ${p.projectId}`),
    ...(listing.truncated ? ["", "Only the first 100 projects are listed."] : []),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n").trimEnd() }],
    structuredContent: { kind: "projectList", projects, appUrl: backend.appUrl },
  };
}

function createdResult(made: Extract<Created, { status: "created" }>, what: "project" | "page", backend: McpBackend, edit?: DocEdit) {
  const url = pageUrl(backend.appUrl, made);
  const filled = edit?.status === "applied" ? edit : null;
  const lines = [
    what === "project"
      ? `Created project "${made.projectTitle}" with a blank page. docId: ${made.docId}`
      : `Created page "${made.title || "Untitled"}" in "${made.projectTitle}". docId: ${made.docId}`,
    ...(url ? [`Open in Nootles: ${url}`] : []),
    ...(filled
      ? ["", `Filled it in (editId: ${filled.editId}):`, ...filled.changes.map((c) => `- ${VERB[c.kind]} ⟦${c.id}⟧ ${c.type}${c.text ? `: ${c.text}` : ""}`)]
      : []),
    ...(edit && edit.status !== "applied" && edit.status !== "replayed"
      ? ["", `The page was created, but filling it failed: ${edit.status === "rejected" ? edit.message : EDIT_REFUSALS[edit.reason]}. It is blank; retry with edit_doc.`]
      : []),
  ];
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    structuredContent: {
      kind: "created",
      what,
      doc: { docId: made.docId, pageId: made.pageId, projectId: made.projectId, title: made.title, projectTitle: made.projectTitle, url },
      changes: filled?.changes ?? [],
      editId: filled?.editId ?? null,
    },
    ...(edit && edit.status !== "applied" && edit.status !== "replayed" ? { isError: true } : {}),
  };
}

async function createProject(args: Record<string, unknown>, backend: McpBackend) {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const made = await backend.createProject({
    title,
    description: typeof args.description === "string" ? args.description : undefined,
    pageTitle: typeof args.page_title === "string" ? args.page_title : undefined,
  });
  if (made.status === "refused") return toolError(WRITE_REFUSALS[made.reason]);
  return createdResult(made, "project", backend);
}

async function createPage(args: Record<string, unknown>, backend: McpBackend) {
  const project = typeof args.project === "string" ? args.project.trim() : "";
  if (!project) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const made = await backend.createPage({ project, title: typeof args.title === "string" ? args.title : undefined });
  if (made.status === "refused") return toolError(WRITE_REFUSALS[made.reason]);
  const operations = Array.isArray(args.operations) && args.operations.length ? args.operations : null;
  const edit = operations ? await backend.editDoc({ ref: made.docId, operations }) : undefined;
  return createdResult(made, "page", backend, edit);
}

async function renameTarget(args: Record<string, unknown>, backend: McpBackend) {
  const target = args.target === "page" || args.target === "project" ? args.target : null;
  const ref = typeof args.ref === "string" ? args.ref.trim() : "";
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!target || !ref || !title) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const done = await backend.rename({ target, ref, title });
  if (done.status === "refused") return toolError(WRITE_REFUSALS[done.reason]);
  const url = done.target === "page" && done.pageId ? pageUrl(backend.appUrl, { projectId: done.projectId, pageId: done.pageId }) : null;
  return {
    content: [{ type: "text", text: `Renamed the ${done.target} "${done.from || "Untitled"}" to "${done.to}".` }],
    structuredContent: { kind: "renamed", target: done.target, from: done.from, to: done.to, doc: { title: done.to, url, projectId: done.projectId } },
  };
}

async function trashPage(args: Record<string, unknown>, backend: McpBackend) {
  const ref = typeof args.doc === "string" ? args.doc.trim() : "";
  if (!ref) return null;
  if (!backend.canWrite) return toolError(READ_ONLY);
  const done = await backend.trashPage({ ref });
  if (done.status === "refused") return toolError(WRITE_REFUSALS[done.reason]);
  return {
    content: [{ type: "text", text: `Moved "${done.title || "Untitled"}" (project "${done.projectTitle}") to the Trash. The person can restore it from Nootles' Trash.` }],
    structuredContent: { kind: "trashed", doc: { docId: done.docId, title: done.title, projectTitle: done.projectTitle, url: null } },
  };
}

function negotiate(requested: unknown): string {
  return typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : PROTOCOL_VERSIONS[0];
}

async function dispatch(request: Request, backend: McpBackend): Promise<unknown> {
  const params = request.params ?? {};
  switch (request.method) {
    case "initialize":
      return {
        protocolVersion: negotiate(params.protocolVersion),
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [MCP_APP_MIME] } },
        },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "resources/list":
      return { resources: [APP_RESOURCE] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "resources/read": {
      if (params.uri !== MCP_APP_URI) throw new RpcError(INVALID_PARAMS, `Unknown resource: ${String(params.uri)}`);
      return {
        contents: [
          {
            uri: MCP_APP_URI,
            mimeType: MCP_APP_MIME,
            text: MCP_APP_HTML,
            _meta: { ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } },
          },
        ],
      };
    }
    case "tools/call": {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new RpcError(INVALID_PARAMS, "arguments must be an object");
      }
      if (params.name === LIST_TOOL.name) return await listDocs(args, backend);
      if (params.name === READ_TOOL.name) {
        const result = await readDoc(args, backend);
        if (!result) throw new RpcError(INVALID_PARAMS, "read_doc needs `doc`: a docId, page id or page URL.");
        return result;
      }
      if (params.name === EDIT_TOOL.name) {
        const result = await editDoc(args, backend);
        if (!result) throw new RpcError(INVALID_PARAMS, "edit_doc needs `doc`: a docId, page id or page URL.");
        return result;
      }
      if (params.name === UNDO_TOOL.name) {
        const result = await undoEdit(args, backend);
        if (!result) throw new RpcError(INVALID_PARAMS, "undo_edit needs `edit_id`: the editId an edit_doc result gave.");
        return result;
      }
      if (params.name === PROJECTS_TOOL.name) return await listProjects(backend);
      const more: Record<string, [(a: Record<string, unknown>, b: McpBackend) => Promise<unknown>, string]> = {
        [SEARCH_TOOL.name]: [searchDocs, "search_docs needs a `query`."],
        [CREATE_PROJECT_TOOL.name]: [createProject, "create_project needs a `title`."],
        [CREATE_PAGE_TOOL.name]: [createPage, "create_page needs a `project`: a projectId or exact title."],
        [RENAME_TOOL.name]: [renameTarget, "rename needs `target` (page or project), `ref` and `title`."],
        [TRASH_TOOL.name]: [trashPage, "trash_page needs `doc`: a docId, page id or page URL."],
      };
      const handler = typeof params.name === "string" ? more[params.name] : undefined;
      if (handler) {
        const result = await handler[0](args, backend);
        if (!result) throw new RpcError(INVALID_PARAMS, handler[1]);
        return result;
      }
      throw new RpcError(INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${request.method}`);
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function isRequest(message: unknown): message is Request {
  if (typeof message !== "object" || message === null) return false;
  const m = message as Record<string, unknown>;
  const idOk = m.id === undefined || typeof m.id === "string" || typeof m.id === "number";
  const paramsOk = m.params === undefined || (typeof m.params === "object" && m.params !== null);
  return m.jsonrpc === "2.0" && typeof m.method === "string" && idOk && paramsOk;
}

/** One message's answer, or null for a notification (or a client's response), which gets none. */
async function answer(message: unknown, backend: McpBackend): Promise<Response | null> {
  if (!isRequest(message)) {
    // A client's response to a server request: there are none, so nothing to match.
    if (typeof message === "object" && message !== null && ("result" in message || "error" in message)) return null;
    const id = (message as { id?: unknown } | null)?.id;
    return {
      jsonrpc: "2.0",
      id: typeof id === "string" || typeof id === "number" ? id : null,
      error: { code: INVALID_REQUEST, message: "Invalid JSON-RPC request" },
    };
  }
  if (message.id === undefined) return null;
  try {
    return { jsonrpc: "2.0", id: message.id, result: await dispatch(message, backend) };
  } catch (error) {
    if (error instanceof RpcError) return { jsonrpc: "2.0", id: message.id, error: { code: error.code, message: error.message } };
    // Internal failures carry no detail: the message could name what failed to read.
    console.error(`mcp: ${message.method} failed: ${error instanceof Error ? error.name : "unknown"}`);
    return { jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Internal error" } };
  }
}

/**
 * A POST body's answer: one response, an array of them for a batch, or null
 * when every message was a notification (the transport then answers 202).
 */
export async function handleMcp(body: unknown, backend: McpBackend): Promise<Response | Response[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return { jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Empty batch" } };
    const answers = (await Promise.all(body.map((m) => answer(m, backend)))).filter((a): a is Response => a !== null);
    return answers.length ? answers : null;
  }
  return await answer(body, backend);
}
