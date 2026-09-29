import { describe, expect, test, vi } from "vitest";
import { MCP_APP_HTML, MCP_APP_MIME, MCP_APP_URI } from "./app";
import { handleMcp, PROTOCOL_VERSIONS, type DocEdit, type DocRead, type DocUndo, type McpBackend } from "./protocol";

const DOC = { docId: "d-1", pageId: "p1", projectId: "j1", title: "Launch plan", projectTitle: "Roadmap", updatedAt: Date.UTC(2026, 8, 28) };

function backend(overrides: Partial<McpBackend> = {}): McpBackend {
  return {
    appUrl: "https://app.nootles.com",
    canWrite: true,
    editDoc: vi.fn(
      async (): Promise<DocEdit> => ({
        status: "applied",
        editId: "e1",
        doc: DOC,
        changes: [
          { kind: "changed", id: "p1", type: "paragraph", text: "Ship it today" },
          { kind: "added", id: "n1", type: "checkListItem", text: "Write docs" },
        ],
        created: { risk: "n1" },
        blockCount: 3,
      }),
    ),
    undoEdit: vi.fn(async (): Promise<DocUndo> => ({ status: "undone", docId: "d-1", pageId: "p1", projectId: "j1", title: "Launch plan" })),
    listProjects: vi.fn(async () => ({ projects: [{ projectId: "j1", title: "Roadmap", pages: 3, served: 2, updatedAt: 1 }], truncated: false })),
    searchDocs: vi.fn(async () => ({
      scanned: 2,
      total: 2,
      hits: [{ docId: "d-1", pageId: "p1", projectId: "j1", title: "Launch plan", projectTitle: "Roadmap", matches: [{ blockId: "p1", type: "paragraph", text: "Ship it" }], more: 0 }],
    })),
    createProject: vi.fn(async () => ({ status: "created" as const, projectId: "j2", projectTitle: "Offsite", pageId: "p9", docId: "d-9", title: "" })),
    createPage: vi.fn(async () => ({ status: "created" as const, projectId: "j1", projectTitle: "Roadmap", pageId: "p8", docId: "d-8", title: "Risks" })),
    rename: vi.fn(async () => ({ status: "renamed" as const, target: "page" as const, id: "d-1", from: "Launch plan", to: "Launch", projectId: "j1", pageId: "p1" })),
    trashPage: vi.fn(async () => ({ status: "trashed" as const, docId: "d-1", title: "Launch plan", projectTitle: "Roadmap" })),
    listDocs: vi.fn(async () => ({ total: 1, docs: [{ ...DOC, snippet: "Ship it", blockCount: 3 }] })),
    readDoc: vi.fn(
      async (): Promise<DocRead> => ({
        status: "ok",
        doc: DOC,
        text: "⟦h1⟧ # Launch plan\n⟦p1⟧ Ship it",
        truncated: false,
        blockCount: 2,
        outline: { blocks: [{ id: "h1", type: "heading", depth: 0, text: "Launch plan", level: 1 }], total: 2, truncated: false },
      }),
    ),
    ...overrides,
  };
}

const call = (id: number, method: string, params?: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP protocol", () => {
  test("initialize negotiates a supported version, else offers the latest", async () => {
    const ok = (await handleMcp(call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} }), backend())) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: Record<string, unknown>; instructions: string };
    };
    expect(ok.result.protocolVersion).toBe("2025-06-18");
    expect(ok.result.serverInfo.name).toBe("nootles");
    expect(ok.result.capabilities).toHaveProperty("tools");
    expect(ok.result.capabilities).toHaveProperty("resources");
    expect(ok.result.instructions).toMatch(/edit_doc/);
    expect(ok.result.instructions).toMatch(/undo/);
    const future = (await handleMcp(call(2, "initialize", { protocolVersion: "2099-01-01" }), backend())) as { result: { protocolVersion: string } };
    expect(future.result.protocolVersion).toBe(PROTOCOL_VERSIONS[0]);
  });

  test("notifications and client responses get no answer", async () => {
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, backend())).toBeNull();
    expect(await handleMcp({ jsonrpc: "2.0", id: 9, result: {} }, backend())).toBeNull();
    expect(await handleMcp([{ jsonrpc: "2.0", method: "notifications/initialized" }], backend())).toBeNull();
  });

  test("malformed messages, unknown methods and empty batches are JSON-RPC errors", async () => {
    expect(await handleMcp({ hello: 1 }, backend())).toMatchObject({ id: null, error: { code: -32600 } });
    expect(await handleMcp({ jsonrpc: "2.0", id: 3, method: 5 }, backend())).toMatchObject({ id: 3, error: { code: -32600 } });
    expect(await handleMcp(call(4, "prompts/list"), backend())).toMatchObject({ id: 4, error: { code: -32601 } });
    expect(await handleMcp([], backend())).toMatchObject({ error: { code: -32600 } });
  });

  test("a batch answers each request in order and skips its notifications", async () => {
    const answers = (await handleMcp(
      [call(1, "ping"), { jsonrpc: "2.0", method: "notifications/initialized" }, call(2, "tools/list")],
      backend(),
    )) as Array<{ id: number }>;
    expect(answers.map((a) => a.id)).toEqual([1, 2]);
  });

  test("read tools are read-only, write tools say they write, all closed-world on the app resource", async () => {
    const { result } = (await handleMcp(call(1, "tools/list"), backend())) as {
      result: { tools: Array<{ name: string; annotations: Record<string, boolean>; _meta: { ui: { resourceUri: string } } }> };
    };
    expect(result.tools.map((t) => [t.name, t.annotations.readOnlyHint, t.annotations.destructiveHint])).toEqual([
      ["list_docs", true, false],
      ["read_doc", true, false],
      ["search_docs", true, false],
      ["list_projects", true, false],
      ["edit_doc", false, true],
      ["undo_edit", false, true],
      ["create_project", false, false],
      ["create_page", false, false],
      ["rename", false, false],
      ["trash_page", false, true],
    ]);
    for (const tool of result.tools) {
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool._meta.ui.resourceUri).toBe(MCP_APP_URI);
    }
  });

  test("the app resource is listed and served as an MCP App", async () => {
    const list = (await handleMcp(call(1, "resources/list"), backend())) as { result: { resources: Array<{ uri: string; mimeType: string }> } };
    expect(list.result.resources).toEqual([expect.objectContaining({ uri: MCP_APP_URI, mimeType: MCP_APP_MIME })]);
    const read = (await handleMcp(call(2, "resources/read", { uri: MCP_APP_URI }), backend())) as {
      result: { contents: Array<{ text: string; mimeType: string; _meta: unknown }> };
    };
    expect(read.result.contents[0].mimeType).toBe("text/html;profile=mcp-app");
    expect(read.result.contents[0].text).toBe(MCP_APP_HTML);
    expect(read.result.contents[0]._meta).toEqual({ ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [] } } });
    expect(await handleMcp(call(3, "resources/read", { uri: "ui://other" }), backend())).toMatchObject({ error: { code: -32602 } });
  });

  test("list_docs clamps its limit, passes the query, and answers text plus structured docs with links", async () => {
    const b = backend();
    const { result } = (await handleMcp(call(1, "tools/call", { name: "list_docs", arguments: { query: "  plan ", limit: 1000 } }), b)) as {
      result: { content: Array<{ text: string }>; structuredContent: { kind: string; docs: Array<{ url: string }> } };
    };
    expect(b.listDocs).toHaveBeenCalledWith({ query: "plan", limit: 100 });
    expect(result.content[0].text).toContain("Launch plan");
    expect(result.content[0].text).toContain("docId: d-1");
    expect(result.content[0].text).toContain("Ship it");
    expect(result.structuredContent.kind).toBe("docList");
    expect(result.structuredContent.docs[0].url).toBe("https://app.nootles.com/p/j1?page=p1");
  });

  test("list_docs says plainly when nothing is served", async () => {
    const b = backend({ listDocs: async () => ({ total: 0, docs: [] }) });
    const { result } = (await handleMcp(call(1, "tools/call", { name: "list_docs", arguments: {} }), b)) as {
      result: { content: Array<{ text: string }> };
    };
    expect(result.content[0].text).toMatch(/No documents are served/);
  });

  test("read_doc returns the stable-ID text under a header, and a card payload", async () => {
    const b = backend();
    const { result } = (await handleMcp(
      call(1, "tools/call", { name: "read_doc", arguments: { doc: "d-1", focus_block_id: "p1", window: 2 } }),
      b,
    )) as { result: { content: Array<{ text: string }>; structuredContent: { kind: string; doc: { url: string } }; isError?: boolean } };
    expect(b.readDoc).toHaveBeenCalledWith({ ref: "d-1", focusBlockId: "p1", window: 2 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/^# Launch plan\n/);
    expect(result.content[0].text).toContain("⟦p1⟧ Ship it");
    expect(result.content[0].text).toContain("Open in Nootles: https://app.nootles.com/p/j1?page=p1");
    expect(result.structuredContent.kind).toBe("doc");
  });

  test("read_doc refusals are tool errors that say what to do, never protocol errors", async () => {
    for (const reason of ["not-found", "not-served", "too-large", "corrupt"] as const) {
      const b = backend({ readDoc: async () => ({ status: "refused", reason }) });
      const answer = (await handleMcp(call(1, "tools/call", { name: "read_doc", arguments: { doc: "x" } }), b)) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content[0].text.length).toBeGreaterThan(10);
    }
  });

  test("read_doc without a doc, unknown tools and non-object arguments are invalid params", async () => {
    expect(await handleMcp(call(1, "tools/call", { name: "read_doc", arguments: {} }), backend())).toMatchObject({ error: { code: -32602 } });
    expect(await handleMcp(call(2, "tools/call", { name: "edit_doc", arguments: {} }), backend())).toMatchObject({ error: { code: -32602 } });
    expect(await handleMcp(call(4, "tools/call", { name: "undo_edit", arguments: {} }), backend())).toMatchObject({ error: { code: -32602 } });
    expect(await handleMcp(call(5, "tools/call", { name: "delete_doc", arguments: {} }), backend())).toMatchObject({ error: { code: -32602 } });
    expect(await handleMcp(call(3, "tools/call", { name: "list_docs", arguments: [1] }), backend())).toMatchObject({ error: { code: -32602 } });
  });

  test("a backend failure is an internal error that leaks nothing", async () => {
    const b = backend({ readDoc: async () => Promise.reject(new Error("secret page text")) });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const answer = (await handleMcp(call(1, "tools/call", { name: "read_doc", arguments: { doc: "d" } }), b)) as { error: { message: string } };
    expect(answer.error.message).toBe("Internal error");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret page text");
    spy.mockRestore();
  });

  test("edit_doc passes the operations through and reports every change, the new ids and the editId", async () => {
    const b = backend();
    const operations = [{ kind: "setBlockContent", blockId: "p1", content: "Ship it today" }];
    const { result } = (await handleMcp(
      call(1, "tools/call", { name: "edit_doc", arguments: { doc: "d-1", operations, idempotency_key: "k1" } }),
      b,
    )) as { result: { content: Array<{ text: string }>; structuredContent: { kind: string; editId: string; doc: { url: string } }; isError?: boolean } };
    expect(b.editDoc).toHaveBeenCalledWith({ ref: "d-1", operations, idempotencyKey: "k1" });
    expect(result.isError).toBeUndefined();
    const text = result.content[0].text;
    expect(text).toContain('Edited "Launch plan" — 2 changes. editId: e1');
    expect(text).toContain("- Changed ⟦p1⟧ paragraph: Ship it today");
    expect(text).toContain("- Added ⟦n1⟧ checkListItem: Write docs");
    expect(text).toContain("risk → n1");
    expect(result.structuredContent).toMatchObject({ kind: "edit", editId: "e1", doc: { url: "https://app.nootles.com/p/j1?page=p1" } });
  });

  test("a read-only connection is told how to get edit access, and the backend is never asked", async () => {
    const b = backend({ canWrite: false });
    for (const [name, args] of [["edit_doc", { doc: "d-1", operations: [] }], ["undo_edit", { edit_id: "e1" }]] as const) {
      const { result } = (await handleMcp(call(1, "tools/call", { name, arguments: args }), b)) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/can only read.*Allow edits/);
    }
    expect(b.editDoc).not.toHaveBeenCalled();
    expect(b.undoEdit).not.toHaveBeenCalled();
  });

  test("a rejected edit names the operation and says nothing changed; a refused one says why", async () => {
    const rejected = backend({ editDoc: async () => ({ status: "rejected", code: "missing_node", message: "Block x does not exist", operationIndex: 2 }) });
    const r = (await handleMcp(call(1, "tools/call", { name: "edit_doc", arguments: { doc: "d", operations: [] } }), rejected)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(r.result).toMatchObject({ isError: true });
    expect(r.result.content[0].text).toBe("Nothing was changed: Block x does not exist (operation 2). [missing_node]");
    for (const reason of ["not-found", "not-served", "too-large", "no-write", "busy", "rate-limited"] as const) {
      const b = backend({ editDoc: async () => ({ status: "refused", reason }) });
      const answer = (await handleMcp(call(1, "tools/call", { name: "edit_doc", arguments: { doc: "d", operations: [] } }), b)) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(answer.result.isError).toBe(true);
      expect(answer.result.content[0].text.length).toBeGreaterThan(20);
    }
  });

  test("a replayed edit changes nothing and says so", async () => {
    const b = backend({ editDoc: async () => ({ status: "replayed", editId: "e1", doc: DOC }) });
    const { result } = (await handleMcp(call(1, "tools/call", { name: "edit_doc", arguments: { doc: "d", operations: [] } }), b)) as {
      result: { content: Array<{ text: string }>; structuredContent: { replayed: boolean } };
    };
    expect(result.content[0].text).toMatch(/already made \(editId: e1\)/);
    expect(result.structuredContent.replayed).toBe(true);
  });

  test("undo_edit undoes by id, and a refusal names the blocks in the way", async () => {
    const b = backend();
    const ok = (await handleMcp(call(1, "tools/call", { name: "undo_edit", arguments: { edit_id: " e1 " } }), b)) as {
      result: { content: Array<{ text: string }>; structuredContent: { kind: string; doc: { url: string } } };
    };
    expect(b.undoEdit).toHaveBeenCalledWith({ editId: "e1" });
    expect(ok.result.content[0].text).toMatch(/^Undone\./);
    expect(ok.result.structuredContent).toMatchObject({ kind: "undo", doc: { url: "https://app.nootles.com/p/j1?page=p1" } });
    const refused = backend({ undoEdit: async () => ({ status: "refused", reason: "changed-since", ids: ["p1"] }) });
    const no = (await handleMcp(call(2, "tools/call", { name: "undo_edit", arguments: { edit_id: "e1" } }), refused)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(no.result.isError).toBe(true);
    expect(no.result.content[0].text).toMatch(/edited since.*⟦p1⟧/);
  });

  test("search_docs passes the query and names each hit's page and blocks", async () => {
    const b = backend();
    const { result } = (await handleMcp(call(1, "tools/call", { name: "search_docs", arguments: { query: " ship ", limit: 99 } }), b)) as {
      result: { content: Array<{ text: string }>; structuredContent: { kind: string; hits: Array<{ url: string }> } };
    };
    expect(b.searchDocs).toHaveBeenCalledWith({ query: "ship", limit: 50 });
    expect(result.content[0].text).toContain('"ship" is on 1 page:');
    expect(result.content[0].text).toContain("⟦p1⟧ Ship it");
    expect(result.structuredContent).toMatchObject({ kind: "search", hits: [{ url: "https://app.nootles.com/p/j1?page=p1" }] });
    expect(await handleMcp(call(2, "tools/call", { name: "search_docs", arguments: {} }), b)).toMatchObject({ error: { code: -32602 } });
  });

  test("list_projects lists projects with their ids and counts", async () => {
    const { result } = (await handleMcp(call(1, "tools/call", { name: "list_projects", arguments: {} }), backend())) as {
      result: { content: Array<{ text: string }>; structuredContent: { kind: string } };
    };
    expect(result.content[0].text).toContain("1. Roadmap — 3 pages (2 readable here) · projectId: j1");
    expect(result.structuredContent.kind).toBe("projectList");
  });

  test("create_page makes the page, then fills it through edit_doc on the new docId", async () => {
    const b = backend();
    const operations = [{ kind: "insertBlocks", at: { at: "docStart" }, blocks: [{ tempId: "a", type: "heading", content: "Risks" }] }];
    const { result } = (await handleMcp(call(1, "tools/call", { name: "create_page", arguments: { project: "Roadmap", title: "Risks", operations } }), b)) as {
      result: { content: Array<{ text: string }>; structuredContent: { kind: string; what: string; doc: { url: string } } };
    };
    expect(b.createPage).toHaveBeenCalledWith({ project: "Roadmap", title: "Risks" });
    expect(b.editDoc).toHaveBeenCalledWith({ ref: "d-8", operations });
    expect(result.content[0].text).toContain('Created page "Risks" in "Roadmap". docId: d-8');
    expect(result.content[0].text).toContain("Filled it in (editId: e1):");
    expect(result.structuredContent).toMatchObject({ kind: "created", what: "page", doc: { url: "https://app.nootles.com/p/j1?page=p8" } });
  });

  test("a page whose filling fails is still reported created, as an error that says so", async () => {
    const b = backend({ editDoc: async () => ({ status: "rejected", code: "missing_node", message: "Block x does not exist" }) });
    const { result } = (await handleMcp(call(1, "tools/call", { name: "create_page", arguments: { project: "j1", operations: [{ kind: "removeBlock", blockId: "x" }] } }), b)) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Created page[\s\S]*filling it failed: Block x does not exist/);
  });

  test("create_project, rename and trash_page answer plainly; every write refuses a read-only connection first", async () => {
    const b = backend();
    const made = (await handleMcp(call(1, "tools/call", { name: "create_project", arguments: { title: "Offsite" } }), b)) as { result: { content: Array<{ text: string }> } };
    expect(made.result.content[0].text).toContain('Created project "Offsite" with a blank page. docId: d-9');
    const renamed = (await handleMcp(call(2, "tools/call", { name: "rename", arguments: { target: "page", ref: "d-1", title: "Launch" } }), b)) as { result: { content: Array<{ text: string }> } };
    expect(renamed.result.content[0].text).toBe('Renamed the page "Launch plan" to "Launch".');
    const trashed = (await handleMcp(call(3, "tools/call", { name: "trash_page", arguments: { doc: "d-1" } }), b)) as { result: { content: Array<{ text: string }> } };
    expect(trashed.result.content[0].text).toMatch(/Moved "Launch plan".*Trash/);
    const ro = backend({ canWrite: false });
    for (const [name, args] of [["create_project", { title: "x" }], ["create_page", { project: "j1" }], ["rename", { target: "page", ref: "d", title: "x" }], ["trash_page", { doc: "d" }]] as const) {
      const r = (await handleMcp(call(4, "tools/call", { name, arguments: args }), ro)) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(r.result.isError, name).toBe(true);
      expect(r.result.content[0].text).toMatch(/can only read/);
    }
    expect([ro.createProject, ro.createPage, ro.rename, ro.trashPage].every((f) => (f as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
    for (const reason of ["no-write", "not-found", "not-served", "serving-off", "quota", "rate-limited"] as const) {
      const r = (await handleMcp(call(5, "tools/call", { name: "trash_page", arguments: { doc: "d" } }), backend({ trashPage: async () => ({ status: "refused", reason }) }))) as {
        result: { isError: boolean; content: Array<{ text: string }> };
      };
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text.length).toBeGreaterThan(20);
    }
  });
});
