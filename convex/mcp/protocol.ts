import { MCP_APP_HTML, MCP_APP_URI, MCP_APP_MIME } from "./app";

/**
 * The MCP server itself: JSON-RPC in, JSON-RPC out, over whatever the HTTP
 * handler hands it. Pure — the backend is injected — so every method, refusal
 * and edge of the wire format is testable without a deployment.
 *
 * Streamable HTTP, stateless: every POST carries one message (or a batch, for
 * the older revisions that allowed them) and gets its answer in the response
 * body. There is no session and no server-initiated stream; nothing here needs
 * one. Tools only read, so nothing an agent does over MCP can change a document
 * or reach a model provider.
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

export type McpBackend = {
  listDocs(args: { query?: string; limit: number }): Promise<DocListing>;
  readDoc(args: { ref: string; focusBlockId?: string; window?: number }): Promise<DocRead>;
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
  "These tools read the connected person's own Nootles pages that are served from the canonical NML document tree.",
  "Call list_docs to see what is available, then read_doc with a docId.",
  "read_doc returns every block tagged ⟦id⟧; ids are stable across reads, so cite blocks by id.",
  "Access is read-only: nothing here can change a document.",
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

export const TOOLS = [LIST_TOOL, READ_TOOL];

const APP_RESOURCE = {
  uri: MCP_APP_URI,
  name: "nootles_documents",
  title: "Nootles documents",
  description: "The card list_docs and read_doc results are shown in.",
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
