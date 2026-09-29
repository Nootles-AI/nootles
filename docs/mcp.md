# MCP: letting an agent read and edit your Nootles pages

**Status:** live for the internal cohort. Reading shipped in NT-121 (Phase 3 of the
[internal-MCP plan](../../agent-wiki/architecture/nml-internal-mcp-plan.md)). Editing shipped in
NT-123 (Phase 4), along with the write side of Phases 5–7: the `docs:write` scope, undo, and the
edit e2e.

Nootles runs an [MCP](https://modelcontextprotocol.io) server. An agent such as Claude connects to
it, and you approve it once in Nootles. From then on it can list your pages and read them. If you
left **Allow edits** on, it can also edit them. Every edit:

- shows on the page at once;
- is marked as the agent's;
- can be undone, by you or by the agent.

## What an agent can and cannot see

| It can | It cannot |
|---|---|
| List **your own** pages that are served from the canonical NML tree | Touch a page in a team workspace, even one you own |
| Read those pages' live content, with a stable `⟦id⟧` on every block | Touch a page shared with you by someone else |
| Open a page by docId, page id, or a Nootles page URL | Touch a page that is not yet on NML (legacy): it is never listed, and reading or editing it is refused |
| With edit access: change text, add, move and remove blocks, tick to-dos, rewrite tables, code and math | Edit diagrams, albums or storyboards (they read as outlines only) |
| Undo its own edits | Undo over your work: an undo that would take your later edits is refused |

"Served" means the page has migrated to NML, the server has verified it on its own, and the
master serve switch is on: `nmlMigration.servedAuthority`, the same gate the editor uses. Opening a
page in Nootles migrates it if its owner is in the cohort.

## Connecting

The server URL is shown in **Settings → Agents** (only for accounts MCP is enabled for). In
production it is:

```
https://brilliant-buffalo-463.convex.site/mcp
```

**Claude (claude.ai or the desktop app).**

1. Settings → Connectors → *Add custom connector* → paste the URL.
2. Claude opens Nootles. Sign in if asked. **Allow edits** is ticked; untick it for a read-only
   connection. Choose **Allow**.
3. Ask things like *"What's in my Launch plan doc on Nootles?"* or *"Add a risks section to my
   Launch plan."* The tools can be switched on per chat from the tools menu.

Claude asks before each tool call that writes, unless you tell it to always allow.

**Claude Code.**

```sh
claude mcp add --transport http nootles https://brilliant-buffalo-463.convex.site/mcp
```

Then run `/mcp` in a session, pick `nootles` → *Authenticate*, and approve in the browser.

**Any other client.** Anything that speaks MCP Streamable HTTP with OAuth 2.1 discovery works: it
finds the authorization server from the `401`, registers itself, and sends you to the consent page.

### Disconnecting, and read-only connections

Settings → Agents lists every connected agent: whether it can edit, and a **Disconnect** button.
Disconnecting cuts it off immediately, including its refresh token.

A connection made before NT-123, or with **Allow edits** unticked, is read-only. `edit_doc` tells
the agent so. To give it edit access, disconnect and connect again.

## The tools

### `list_docs`

`{ query?: string, limit?: 1–100 (20) }`: your served pages, most recently edited first. Each has
a title, project, last edit, first words (a leading heading that repeats the title is skipped),
block count, docId, and a link into the app. `query` matches title or project name, ignoring case.

### `read_doc`

`{ doc: string, focus_block_id?: string, window?: 0–50 (5) }`: one page as text:

```
# Launch plan
Project: Roadmap · Last edited: 2026-09-29T16:02:11.000Z · docId: 2c4f…
Open in Nootles: https://app.nootles.com/p/…?page=…
8 blocks

⟦h-launch⟧ # Launch plan
⟦p-goal⟧ Ship the MCP connector **this week**.
⟦b-beta⟧ - Private beta with the team
  ⟦c-invite⟧ - [x] Invite testers
…
```

This is the same stable-ID projection every Nootles AI lane reads (`app/lib/ai/projection.ts` via
`app/lib/nml/model/projection.ts`), decoded from the page's canonical NML root on the server. It is
never the legacy ProseMirror root or an HTML reader. Ids survive edits: re-reading after someone
changes the page returns the new content with every untouched block's id unchanged. Diagrams read as
shape outlines; tables, code, math, media and check states are included. For a long page, pass
`focus_block_id` (an id from an earlier read) and `window` to read only the top-level blocks around
it. Past 200,000 characters the text is cut and says how to continue.

`doc` accepts a docId from `list_docs`, a page id, or a page URL (`/p/<projectId>?page=<pageId>`).
A page you don't own reads as not found, the same as an id that doesn't exist.

### `edit_doc`

`{ doc: string, operations: Operation[] (1–100), idempotency_key?: string }` applies the operations
together as **one edit**: all of them or none.

Operations address blocks by the `⟦id⟧` that `read_doc` shows. They are the model operation
vocabulary every Nootles AI lane uses (`convex/ai/operations.ts`):

| Operation | Does |
|---|---|
| `{"kind":"setBlockContent","blockId","content"}` | Replace a block's text |
| `{"kind":"insertBlocks","at","blocks"}` | Add blocks: `at` is `{"at":"after"\|"before","ref":id}`, `{"at":"docStart"}` or `{"at":"docEnd"}` |
| `{"kind":"updateBlockProps","blockId","props"}` | e.g. `{"checked":true}`, `{"level":2}`, `{"language":"ts","code":"…"}` |
| `{"kind":"moveBlock","blockId","to"}` | Move a block |
| `{"kind":"removeBlock","blockId"}` | Remove a block and what is nested in it |
| `{"kind":"setTableRows","blockId","rows","headerRows"?}` | Rewrite a table's cells |
| `{"kind":"setMathRows"}`, `{"kind":"updateMathRow"}` | Rewrite math |

Inline `content` is a plain string or a list of runs: `{"type":"text","text","marks":[…]}`,
`link`, `math`, `pageRef` or `checkbox`. A new block carries a `tempId`; the result maps each
`tempId` to the block's real id, and later operations in the same edit may use a `tempId` as a
`ref`.

Example:

```json
{
  "doc": "2c4f…",
  "operations": [
    { "kind": "setBlockContent", "blockId": "p-goal",
      "content": [{ "type": "text", "text": "Ship MCP edits " }, { "type": "text", "text": "today", "marks": ["bold"] }] },
    { "kind": "insertBlocks", "at": { "at": "after", "ref": "n-two" },
      "blocks": [{ "tempId": "docs", "type": "checkListItem", "content": "Write the edit_doc guide" }] }
  ]
}
```

The result is text like the following, plus an `editId`:

```
Edited "Launch plan" — 2 changes. editId: k57…
- Changed ⟦p-goal⟧ paragraph: Ship MCP edits today
- Added ⟦8f1c…⟧ checkListItem: Write the edit_doc guide

New block ids: docs → 8f1c…
```

**When nothing changes.** If any operation cannot apply (an unknown id, the wrong block type, a
diagram), the whole edit is refused. The error names the failing operation and says nothing was
changed.

**Retries.** Retrying with the same `idempotency_key` never applies the edit twice. Reusing a key
for different operations is refused.

### `undo_edit`

`{ edit_id }` takes one edit back exactly. It is refused, with nothing changed, if the page has
since been edited where that edit touched: undoing would take that work too. Edits stay undoable
for 7 days.

### What you see in Nootles

**On the page.** The edit appears in any open copy of the page with no reload. The page's owner
gets a bar at the foot of the window: *"Claude edited this page · 1 added, 1 changed · Undo ·
Keep"*.

- **Undo** puts back exactly what the agent changed. If you have edited there since, Undo is
  refused ("Changed since — can't undo") and nothing of yours is touched.
- **Keep** stops the page asking. The edit stays undoable from Settings.

⌘Z does not take back an agent's edit. It undoes only your own typing, as with a collaborator's
edits. The agent's edit has its own Undo.

**In Settings → Agents.** *Recent agent edits* lists the last ten: page, agent, counts, when, and
Undo.

### The card (MCP App)

Every tool declares an [MCP App](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
(`ui://nootles/documents.html`). Hosts that render apps, such as Claude, show the result as a card
laid out from the "MCP Apps for Claude" Figma kit:
- a list of pages, where clicking a row opens it through the host;
- a page view;
- an edit's receipt, laid out from the kit's "Confirmation actions" frame: *Edited Launch plan*, the
  page with an *Open in Nootles* button, and the changes as a checked list. An *Undo this edit*
  link calls `undo_edit` through the host;
- *Open in Nootles* links;
- *Expand* to fullscreen.

It takes on the host's light or dark theme through the standard style variables. Hosts without
apps, such as Claude Code, just get the text.

## How it works

```
Agent ──POST /mcp (Bearer)──▶ convex/mcp/http.ts ──admitBearer──▶ grant live? switch on? internal owner? budget?
                                   │
                                   ├─ list_docs ─▶ mcp/read.listDocs ─▶ mcp/docs.servedDocs (owned ∧ personal ∧ served)
                                   ├─ read_doc  ─▶ mcp/read.readDoc  ─▶ mcp/docs.readMaterial ─▶ Y.Doc ─▶ decodeNmlDocument ─▶ project()
                                   ├─ edit_doc  ─▶ mcp/edit.editDoc  ─▶ readMaterial (+seq) ─▶ lib/mcp/edits.prepareEdit ─▶ mcp/docs.commitEdit
                                   └─ undo_edit ─▶ mcp/edit.undoEdit ─▶ mcp/docs.undoMaterial ─▶ lib/mcp/edits.prepareUndo ─▶ mcp/docs.commitUndo
```

**How an edit is made (`app/lib/mcp/edits.ts`, `convex/mcp/edit.ts`).**

1. A Node action rebuilds the page from its stored update log.
2. It runs the operations through Phase 2.5's NML applier (`applyNmlBatch` →
   `executeNmlCommands`). They land as **one attributed transaction**: `actor.kind: "model"`, the
   owner's subject, one `batchId`, and an idempotency key recorded in the document's receipts.
   The executor validates the result before anything is written.
3. The same update also rewrites the ProseMirror compatibility root, through a headless BlockNote
   (`app/lib/nml/serverMirror.ts`). A stale client or a rollback therefore sees the edit at once.
   An open client's own mirror finds its projection already in place and writes nothing.
4. An origin-scoped `Y.UndoManager` captures the inverse at the same moment. It is stored in file
   storage for the undo.
5. `commitEdit` appends the update only if the log is still at the position it was read at. If
   anyone wrote in between, the action rebuilds and tries again, up to 4 times.
6. In the same transaction, `commitEdit` re-checks the grant (live, `docs:write`, switch,
   allowlist) and that the page is owned and served. It records the edit and writes an `mcp.edit`
   audit row.

The provider pushes the update to every open editor. The bridge reconciles it like any other
canonical change.

**How an undo is checked.** Every node the edit touched is fingerprinted before and after. These
are hashes; no content is stored.

- An undo is refused if any touched node has changed since.
- The inverse is applied to the current page. The result must put every touched node back to
  "before" and leave every other node as it is; otherwise nothing is written.
- It works after the log has been compacted, because the inverse carries its own copy of what the
  edit removed.

- **Where it runs.** Everything is Convex HTTP actions on the deployment's `.site` domain
  (`convex/mcp/`), so a merge to `main` deploys it along with the rest of the backend. Decoding runs
  in a Node action (`mcp/read.ts`), for the same heap reason as `nmlVerify`. linkedom stands in for
  the DOM parser the domain serializers want.
- **Protocol.** MCP Streamable HTTP, stateless: every POST gets its JSON answer in the body, and
  there's no session or server stream (`GET /mcp` → 405). Protocol versions 2024-11-05 through
  2025-11-25.
- **Scopes.**
  - `docs:read` lists and reads.
  - `docs:write` edits and undoes, and brings `docs:read` with it.
  - A client that names no scope asks for both. The person decides at consent: unticking
    **Allow edits** grants `docs:read` only.
  - A refresh can never widen a grant.
- **Auth.** OAuth 2.1, with Nootles as its own authorization server:
  - protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414);
  - dynamic client registration (RFC 7591), for public or confidential clients;
  - authorization code with **PKCE S256 required**;
  - `resource` indicators (RFC 8707), `iss` in the redirect (RFC 9207), and revocation (RFC 7009).
  - Consent happens in the app at `/mcp/authorize`, behind the normal Clerk sign-in.
- **Tokens.**
  - Opaque, 256-bit, and stored only as SHA-256.
  - Access tokens last 1 hour. Refresh tokens last 30 days, sliding, and **rotate on every use**.
  - Presenting a rotated-away refresh token, or replaying a spent code, revokes the grant.
  - An MCP token is not a Convex identity: it opens nothing but `/mcp`.
- **Authorization.** Every call re-checks, in one transaction:
  - the grant is live;
  - the MCP switch (`mcpState`) is on;
  - the subject is still in `internalOwners`;
  - the doc is owned by the subject, in a live personal project (`auth.agentOwnsPage`), and served (`nmlMigration.servedAuthority`).
- **Consent.** Only an internal owner can say yes. Operator stand-in sessions are refused.
- **Limits.** The `mcpRequest` bucket in `convex/requestLimits.ts` allows 60 calls a minute with a burst of 30, per person, plus the fleet ceiling. Past that the answer is `429` with `Retry-After`.
  - Edits and agent undos also spend the `mcpEdit` bucket: 20 a minute, a burst of 10. Past that the tool answers "Too many edits".
  - Both are enforced under `observe` and `enforce`; only `RATE_LIMIT_MODE=off` turns them off.
  - The person's own Undo is not limited.
- **Record.** Each call writes one row to the page's project audit log, never content:
  - `read_doc` → `mcp.read`: which page, which grant, how many blocks.
  - `edit_doc` → `mcp.edit`: which page, which grant, which edit, and counts added/changed/removed/moved.
  - An undo → `mcp.undo`: which edit, and whether the agent or the person undid it.
- **Spend.** No model provider is behind any tool; MCP spends nothing.

Tables (all content-free):
- `mcpState`: the switch.
- `mcpClients`: registered clients. Never-used ones are swept after a day.
- `mcpAuthRequests`: pending consents (10 min).
- `mcpAuthCodes`: single-use, 5 min.
- `mcpGrants`: a person's consent for one client, with its scope.
- `mcpEdits`: one row per agent edit:
  - ids, counts and before/after fingerprints (never content);
  - a file-storage pointer to the inverse. The inverse is deleted when the edit is undone, or
    after 7 days by the hourly `mcp/docs:expireInverses`.

The hourly cron `mcp/oauth:sweep` cleans them up.

## Operating it

All `convex run` commands take `--prod` for production. On production each is a change that needs
the operator's explicit go-ahead.

| Want to | Run |
|---|---|
| Turn MCP on / off (every token refused on its next call) | `npx convex run mcp/oauth:setMcpEnabled '{"enabled":false}'` |
| See the switch and every grant | `npx convex run mcp/oauth:mcpStatus` |
| Revoke one grant / everything one person holds | `npx convex run mcp/oauth:revokeGrants '{"grantId":"…"}'` / `'{"subject":"…"}'` |
| Take a person out entirely (their tokens stop at once) | `npx convex run nmlMigration:removeInternalOwner '{"subject":"…"}'` |
| Hide every document (serving off) | `npx convex run nmlMigration:setNmlServe '{"enabled":false}'` |
| See every edit | `mcpEdits` in the dashboard, or the project's audit log (`mcp.edit` / `mcp.undo`) |

The deployment needs `APP_URL` (the app's origin, where consent happens; production already has it
for Stripe) and the built-in `CONVEX_SITE_URL`.

## Testing

- `convex/mcp.test.ts`: the whole OAuth flow and every refusal over HTTP against real functions and
  served documents verified by the real verifier.
- `convex/mcp/*.test.ts` and `app/lib/mcp/outline.test.ts`: protocol, tokens and outline.
- `app/lib/mcp/edits.test.ts`: edits and undo against real BlockNote and real Yjs. It covers:
  - both roots moving together;
  - a stale client's mirror writing nothing;
  - undo after compaction;
  - undo keeping a person's later edit elsewhere, and being refused over one in the same place.
- `npm run test:mcp:fullstack` (`tests/mcp.fullstack.mjs`): the user's story end to end.
  - The pieces: a throwaway `convex-local-backend`, the official MCP SDK client doing its own
    discovery/registration/PKCE/refresh, a real browser on the real consent page and Settings, and
    the card in a host page speaking the MCP Apps protocol.
  - What it covers: connect, list, read, a collaborator's edit, the card in both themes, token
    expiry and refresh, disconnect, cancel, a stranger refused, and the kill switch.
  - For editing, with the **real `Editor`** open on the page:
    - Claude's edit appears live, and the page's bar offers Undo;
    - a retry changes nothing;
    - the card's receipt, and Undo from the card;
    - Undo from the page;
    - Undo refused after Aryan types there, then Keep;
    - a read-only connection, a legacy page and a stranger's page refused;
    - Settings listing the edits.
  - Screenshots land in `tests/.artifacts/mcp/`. It runs in CI's `comments-fullstack` job.

## Not yet

- Canvas-specific tools. Diagrams, albums and storyboards are read-only over MCP.
- A per-hunk review overlay for agent edits. Today an edit lands at once and is undone as a whole.
- Anyone outside the internal cohort, which needs that overlay first.

See the plan.
