# MCP: letting an agent read your Nootles pages

**Status:** live for the internal cohort (NT-121). Read-only. Phase 3 of the
[internal-MCP plan](../../agent-wiki/architecture/nml-internal-mcp-plan.md), shipped with the
read-only slice of Phases 5–6 (OAuth, scopes, rate limits, tools) so a real client can connect.

Nootles runs an [MCP](https://modelcontextprotocol.io) server. An agent such as Claude connects to
it, you approve it once in Nootles, and from then on it can list your pages and read them. It
cannot change anything.

## What an agent can and cannot see

| It can | It cannot |
|---|---|
| List **your own** pages that are served from the canonical NML tree | Write, create, move or delete anything |
| Read those pages' live content, with a stable `⟦id⟧` on every block | See pages in a team workspace, even ones you own |
| Open a page by docId, page id, or a Nootles page URL | See pages shared with you by someone else |
| | See a page that is not yet on NML (legacy): it is never listed, and reading it is refused |

"Served" means the page has migrated to NML, the server has verified it on its own, and the
master serve switch is on: `nmlMigration.servedAuthority`, the same gate the editor uses. Opening a
page in Nootles migrates it if its owner is in the cohort.

## Connecting

The server URL is shown in **Settings → Agents** (only for accounts MCP is enabled for). In
production it is:

```
https://brilliant-buffalo-463.convex.site/mcp
```

**Claude (claude.ai or the desktop app).** Settings → Connectors → *Add custom connector* → paste
the URL. Claude opens Nootles; sign in if asked and choose **Allow read access**. Then ask it
things like *"What's in my Launch plan doc on Nootles?"* The tools can be switched on per chat
from the tools menu.

**Claude Code.**

```sh
claude mcp add --transport http nootles https://brilliant-buffalo-463.convex.site/mcp
```

Then run `/mcp` in a session, pick `nootles` → *Authenticate*, and approve in the browser.

**Any other client.** Anything that speaks MCP Streamable HTTP with OAuth 2.1 discovery works: it
finds the authorization server from the `401`, registers itself, and sends you to the consent page.

### Disconnecting

Settings → Agents lists every connected agent with **Disconnect**. It is cut off immediately,
including its refresh token.

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

### The card (MCP App)

Both tools declare an [MCP App](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
(`ui://nootles/documents.html`). Hosts that render apps, such as Claude, show the result as a card
laid out from the "MCP Apps for Claude" Figma kit:
- a list of pages, where clicking a row opens it through the host;
- a page view;
- *Open in Nootles* links;
- *Expand* to fullscreen.

It takes on the host's light or dark theme through the standard style variables. Hosts without
apps, such as Claude Code, just get the text.

## How it works

```
Agent ──POST /mcp (Bearer)──▶ convex/mcp/http.ts ──admitBearer──▶ grant live? switch on? internal owner? budget?
                                   │
                                   ├─ list_docs ─▶ mcp/read.listDocs ─▶ mcp/docs.servedDocs (owned ∧ personal ∧ served)
                                   └─ read_doc  ─▶ mcp/read.readDoc  ─▶ mcp/docs.readMaterial ─▶ Y.Doc ─▶ decodeNmlDocument ─▶ project()
```

- **Where it runs.** Everything is Convex HTTP actions on the deployment's `.site` domain
  (`convex/mcp/`), so a merge to `main` deploys it along with the rest of the backend. Decoding runs
  in a Node action (`mcp/read.ts`), for the same heap reason as `nmlVerify`. linkedom stands in for
  the DOM parser the domain serializers want.
- **Protocol.** MCP Streamable HTTP, stateless: every POST gets its JSON answer in the body, and
  there's no session or server stream (`GET /mcp` → 405). Protocol versions 2024-11-05 through
  2025-11-25.
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
- **Limits.** The `mcpRequest` bucket in `convex/requestLimits.ts` allows 60 calls a minute with a burst of 30, per person, plus the fleet ceiling. Past that the answer is `429` with `Retry-After`. It is enforced under both `observe` and `enforce`; only `RATE_LIMIT_MODE=off` turns it off.
- **Record.** Each `read_doc` writes an `mcp.read` row to the page's project audit log: which page, which grant, and how many blocks, never content.
- **Spend.** No model provider is behind any tool; MCP spends nothing.

Tables (all content-free):
- `mcpState`: the switch.
- `mcpClients`: registered clients. Never-used ones are swept after a day.
- `mcpAuthRequests`: pending consents (10 min).
- `mcpAuthCodes`: single-use, 5 min.
- `mcpGrants`: a person's consent for one client.

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

The deployment needs `APP_URL` (the app's origin, where consent happens; production already has it
for Stripe) and the built-in `CONVEX_SITE_URL`.

## Testing

- `convex/mcp.test.ts`: the whole OAuth flow and every refusal over HTTP against real functions and
  served documents verified by the real verifier.
- `convex/mcp/*.test.ts` and `app/lib/mcp/outline.test.ts`: protocol, tokens and outline.
- `npm run test:mcp:fullstack` (`tests/mcp.fullstack.mjs`): the user's story end to end.
  - The pieces: a throwaway `convex-local-backend`, the official MCP SDK client doing its own
    discovery/registration/PKCE/refresh, a real browser on the real consent page and Settings, and
    the card in a host page speaking the MCP Apps protocol.
  - What it covers: connect, list, read, a collaborator's edit, the card in both themes, token
    expiry and refresh, disconnect, cancel, a stranger refused, and the kill switch.
  - Screenshots land in `tests/.artifacts/mcp/`. It runs in CI's `comments-fullstack` job.

## Not yet

`edit_doc` (Phase 4, through the NML executor with model attribution and rewind), canvas-specific
tools, and anyone outside the internal cohort (which needs the per-hunk review overlay first). See
the plan.
