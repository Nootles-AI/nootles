# Context graph

Status: steps 1 and 2 of the [build order](#build-order) are built for pages and the Context
Sheet — see [What is built](#what-is-built). Everything else is design. A static spike (stages 0
and 1 below, run against this repo, no model calls) is complete and its numbers are in
[Spike results](#spike-results); it changed two decisions and they are marked.

## Decision

Project context becomes **one typed graph per project, stored in Convex**: nodes at four tiers
(source, artifact, part, concern), edges in five families, every node readable at three
resolutions (brief, summary, body). Every source is a connector that emits nodes and edges into
that graph and nothing else: the project's own pages through an internal connector, GitHub first
among the external ones, then Linear, Notion, Google Workspace, Gmail, Figma.

Models never receive the graph. They receive a **budgeted pack** rendered from it, and the chat
agent additionally gets three tools to walk it: `search_context`, `expand_context`,
`read_context`. The autocomplete lane gets no tools; its seed is assembled off the keystroke
path — a precomputed pack, plus a short briefing a second model rewrites when the topic drifts.

Acting is separate. **Integrations** — the tools that file a ticket or comment on a PR — are
orthogonal to context: the agent reads context, then uses them, and every external write passes
one confirmation gateway.

We build this ourselves. Graphiti and Greptile are the two reference designs; we take ideas from
both and code from neither (see [Not doing](#not-doing)).

## What is wrong today

- A source is a table, not a row. `contextSheet`, `projectRepos` and `projectFiles`
  (`convex/schema.ts`) are three unrelated shapes flattened by `convex/ai/context.ts`
  `forPrompt` and rendered by hand twice — `projectNote()` for chat, `contextSeed()` for
  autocomplete. The two renderers have already drifted (repos are absent from the seed).
- The context block is the one unbounded part of a chat request. Every sheet entry, every repo
  summary and 1,500 characters of every file are re-sent on every request.
- There is no retrieval layer: no vector index, no search index, no chunk table. GitHub works
  because GitHub's search API is the index.
- Nothing tracks freshness. No webhooks, crons, cursors or ETags; refresh is a button.
- Notion is an import wizard, not a context source. Nothing links an imported page back to Notion.
- Tokens are per account, context is per project. An editor's agent reads repos under the
  owner's token.
- `opLog.feed` works and no lane reads it.
- Pages are not context. The agent can read them, but nothing links a page to the sources it
  discusses, and autocomplete knows nothing of any page but the one it is in.

## Principles

Each is tied to the evidence that earned it; links are under [Sources](#sources).

1. **Parsed edges first, inferred edges second, model-extracted edges last.** A PR that names a
   ticket is a free, exact edge. Independent benchmarks show model-extracted graphs lose to flat
   hybrid retrieval on fact lookup and miss about a third of answer entities; those findings are
   about extracted graphs and do not apply to parsed ones.
2. **Embed the description, not the artifact.** Queries arrive in plain English, so the index is
   in plain English (Greptile). This is also the translation layer between roles: a designer's
   question and a function meet in a shared description.
3. **The agent loop is the retriever.** Search finds a seed; the agent follows edges from it.
   Greptile moved from a fixed flowchart to a loop for this reason. Cursor's A/B test is the best
   evidence that semantic plus exact search beats either alone.
4. **Rank per query, not per edge.** Weights are computed at query time by personalized PageRank
   seeded from what the user is working on (Aider's repo map), then cut to a token budget by
   binary search. Stored edge weights are inputs to that, never the answer.
5. **Spend lazily.** Eager summarization of a whole graph is the documented expensive mistake
   (GraphRAG; Greptile's bottom-up recursion stalling on large trees; Zep's own ingest costs).
   Structure is free, summaries are written where attention goes.
6. **Less context, chosen well.** Every tested model degrades with input length, and similar
   distractors hurt most. A pack has a budget and meets it.
7. **Stable prefixes.** A pack is byte-identical until its inputs change, so it caches.

## Data model

### Nodes

| Tier | What it is | Examples |
|---|---|---|
| `source` | the root of one connection's content | a repo, a Linear team, a labelled inbox, a Figma file |
| `artifact` | the unit a person would name | a Nootles page, file, ticket, PR, thread, frame, doc, a context-sheet entry |
| `part` | a splittable piece of an artifact | block, canvas shape, function, heading section, message, component, design token |
| `concern` | derived grouping, may span sources | "Notion import", "canvas collab", "billing" |

Concerns nest exactly one level: an **area** contains **concerns**. *(Changed by the spike: no
single clustering resolution recovers both large and small concerns; see below.)* The hierarchy
stays bounded, in keeping with the rest of the data model.

Every node carries:

- `projectId`, `connectionId`, `tier`, `kind`, `externalId`, `parentId`
- `title` — **required**. Parts use the symbol or heading; concerns use a directory-derived
  fallback until named.
- `url` — deep link to the thing in its source
- `owner` — who the thing belongs to in its source, for display: `{ handle, memberId? }`.
  `handle` is the source's own name for the person (GitHub login, Linear user, email address);
  `memberId` is set when that person maps to a project member. A page's owner is its creator,
  a PR's or ticket's its author, a thread's its sender, a source node's the connection's
  `connectedBy`. Parts inherit their artifact's owner; concerns have none unless a person pins
  one. Code files have none until a connector has a cheap, honest answer (CODEOWNERS, not blame).
- `brief` (about 20 tokens), `summary` (about 150 tokens), `summaryOrigin`: `template | model | human`
- `bodyRef` — a storage id, or a provider locator for bodies fetched on demand (code is not stored)
- `contentHash`, `sourceUpdatedAt`, `syncedAt`, `syncError`, `stale`
- `rank` — global PageRank, computed at ingest
- `searchText` — title, brief and symbol names, for the full-text index

### Edges

| Family | Meaning | Produced by |
|---|---|---|
| `contains` | hierarchy | parser |
| `references` | imports, calls, mentions, links; `type` says which | parser, per-framework resolvers |
| `about` | artifact or part belongs to a concern | clustering, similarity, people |
| `same_as` | one thing in two tools (a Figma component and its code) | similarity, people |
| `supersedes` | a newer version replaces an older one | connector |

Every edge carries `from`, `to`, `family`, `type`, `weight`, `origin`: `parsed | inferred |
human`, an `evidence` pointer, and **four timestamps** (from Graphiti): `validAt` / `invalidAt`
for when the fact held in the world, `createdAt` / `expiredAt` for when we learned and retired
it. Edges are retired, never deleted. Contradiction detection is deferred; the fields are not,
because they are painful to retrofit.

`human` outranks `inferred`. A person's correction in the graph view is a constraint on the next
clustering run, not a suggestion.

Code files are updated in place by content hash — git already holds their history. `supersedes`
is for tickets, docs and decisions, where "what did we decide, and is it still true" is the
question.

### Tables (sketch)

```
contextConnections  projectId, provider, sealedToken, scope, cursor, status, connectedBy
contextNodes        (fields above)          by_project_and_tier, by_parent, by_connection_and_externalId
                                            searchIndex on searchText, filter projectId
contextEdges        (fields above)          by_from_and_family, by_to_and_family, by_project_and_family
contextVectors      nodeId, projectId, scope, model, dims, textHash, embedding
                                            vectorIndex, filter projectId + scope
contextPacks        projectId, pageId?, lane, budget, nodeIds, text, inputsHash, builtAt
contextUsage        projectId, nodeId, lane, turnId, how, outcome
```

Context connections never write. Integrations keep their own per-member credentials and their
own log (`integrationCalls`); see [Integrations](#integrations).

`scope` is a composite `"<projectId>:<tier>"` string, because Convex vector filters cannot AND
across fields. Vectors are a separate table because `v.float64()` costs 8 bytes a dimension: at
512 dimensions that is 4 KB a row, and inline vectors would exhaust a query's 16 MiB read budget
in a few thousand nodes.

`contextSheet`, `projectRepos` and `projectFiles` migrate into `contextNodes` as artifacts
(`kind: note | repo | file`). The user's Description and Context fields become two pinned notes
that every pack includes first.

## Connector contract

A connector is three functions and no UI logic:

- `sync(connection, cursor)` → nodes and parsed edges, plus the next cursor
- `split(artifact)` → parts. A generic fallback splits on headings and paragraphs, so any new
  source is usable the day it connects; specialised splitters arrive later.
- `fetchBody(node)` → the body, for nodes whose bodies are not stored

Everything downstream — clustering, ranking, packs, tools, the graph view — is source-agnostic.
Adding Linear must not touch `convex/ai/context.ts`, the prompt builder, the tool list or the
dialog. That is the test of the contract.

Reference resolvers are pluggable per framework. In this repo 23% of all reference edges (727 of
3,189) come from resolving `api.notion.pages.list` to `convex/notion/pages.ts`; without that
resolver the front end and back end of every feature are disconnected.

## Pages as a source

Project pages are nodes in the same graph, through an **internal connector** that implements the
same three functions and reads the page's Y.Doc instead of an API. If pages need a private path,
the contract is wrong; this connector is its first proof.

| Nootles | Graph |
|---|---|
| Page | `artifact`, `kind: page` |
| Text block | `part` |
| Canvas block, shape | `part` — a shape labelled `YConvexProvider` can be `same_as` the code symbol |
| A link, ticket id or URL in a block | `references` edge, parsed |
| Body | not copied: `fetchBody` is `app/lib/ai/projection.ts`, the id-tagged text the agent already reads |

Why pages belong in the graph:

- **The highest-fidelity source.** We own the structure, the stable ids and the change feed
  (`opLog`). No sync lag, no token, no rate limit. Every other source is a mirror.
- **Where cross-source links are authored.** A PRD that names NT-63, links a Figma frame and
  pastes a GitHub URL is three exact edges. Pages are the hub of the graph, and the thing a
  code-only or search-only product does not have.
- **Intent next to behaviour.** Code is the truth for what the system does; pages are the truth
  for what it is meant to do. A spec that disagrees with the code is worth surfacing.

Pages are first-class in **ranking** — the open page seeds every pack, and pages carry authority
on intent — and ordinary in **schema**.

Rules:

- **Provenance gates context.** `opLog` records `human | ai` and `chatTurns` records what is
  still under review. Unreviewed AI-written blocks stay out of context; accepted ones count.
  Otherwise the model's output becomes its own evidence.
- **Digest on idle or close, never per keystroke.** Blocks are hashed; only changed blocks are
  re-described and re-embedded.
- **The open page seeds its pack and is excluded from it**, as Aider excludes files already in
  the chat.
- Trashed pages are excluded.

**The page digest.** One background job per changed page writes the page node's `summary`, its
per-block hashes and its outgoing edges: `references` parsed from links and ids, `about` from
similarity to concerns. It is the page connector's stage 3, and a paid call.

## GitHub pipeline

| Stage | Work | Model calls |
|---|---|---|
| 0 | Tarball → files and symbols (tree-sitter), import and reference edges, content hashes, templated descriptions | none |
| 1 | Areas and concerns from the reference graph plus files that change together in git history; global rank; rollup edges between concerns | none |
| 2 | Name and summarise areas, concerns and the top-ranked files | bounded: about 140 for this repo |
| 3 | Summarise a file or symbol the first time the agent reads it or it ranks into a pack | on demand |

Stages 0 and 1 run for every project. Stages 2 and 3 plus vector storage are the metered part and
the natural basis for a large-context tier.

**Clustering.** Louvain over a combined graph: reference edges dampened by the target's
in-degree (hubs like `schema.ts` and `Icons.tsx` glue less) plus normalised co-change. Two
levels are kept: areas from one pass at resolution 1, concerns by running Louvain again inside
each area, so concerns nest in areas by construction. *(Changed by the spike: label
propagation, the original choice, is rejected.)*

**Updates.** A push gives changed paths. Re-parse only those, compare hashes, mark ancestor
summaries stale. Re-cluster **warm**, starting from the previous labels, never cold: the spike
measures 0.93 agreement with the previous partition warm against 0.73 cold. A concern is
re-summarised only once enough of its members change. Concern ids survive re-clustering; when
one splits, the larger half keeps the id.

Webhooks need the GitHub App. Until it exists, a PAT connection polls the compare API when the
project opens and on idle.

**Where it runs.** Convex Node actions have 512 MB and 10 minutes. The spike held 209 MB parsing
781 files with the TypeScript compiler, so ingest is batched — a few hundred files per action,
state in tables between batches — and never holds a repo in memory. Whether tree-sitter's WASM
build loads in the Convex Node runtime is unverified; the fallback is a worker outside Convex
that writes through an authenticated mutation.

## Retrieval

### Tools (chat lane, and later the MCP surface)

- `search_context(query, tiers?, within?, limit)` → ids with title, kind, source and brief.
  Vector search over descriptions, fused with the full-text index. Exact search inside code
  bodies proxies to GitHub's code search, since bodies are not stored.
- `expand_context(id, families?, limit)` → neighbours with their briefs and edge types.
- `read_context(id, range?)` → the summary, or the body.

These replace `list_repo_files`, `read_repo_file`, `search_repo_code` and `read_context_file`.
They are the same verbs an MCP client will get, per the one-vocabulary rule. Every call writes
`contextUsage`.

### Packs

A lane asks for a pack with a budget; one renderer serves every lane.

1. Seed from the open page's node: its outgoing edges, nodes the agent read during turns on it
   (`contextUsage`), recent edits (`opLog.feed`), and the nodes nearest the section being
   written. The open page itself is excluded from the pack.
2. Personalized PageRank from those seeds; hub nodes are discounted.
3. Pinned notes first, then the area and concern map, then ranked briefs, cut to the budget by
   binary search.
4. Store in `contextPacks` keyed by `inputsHash`. It does not change until its inputs do.

**Chat** gets the pack as the cached prefix, then the tools.

**Autocomplete** has no tools, and at keystroke time it reads a stored seed and nothing else.

### The autocomplete seed

The power of this system is context, so autocomplete has to be informed by it; retrieval per
keystroke is too slow. The seed is therefore assembled **off the keystroke path** and read on it.
It is today's 2,400 characters, prepended to the fill-in-the-middle prompt — that endpoint has
no system prompt (`app/lib/ai/fim.ts`).

| Part | Refreshed | Cost |
|---|---|---|
| Pinned notes | when edited | none |
| Page outline: headings beyond the completion window | on idle | none |
| Glossary and briefs: canonical names and one-line briefs of the nodes nearest the current section | every pause or section change — embed the section, nearest nodes, pack ranking | one embedding call |
| Briefing: about 150 tokens of project facts relevant to what is being written | only when the topic drifts | one small-model call, no tools |

- **The briefing covers what is elsewhere, not the page.** The completion model already sees
  4,000 characters before the caret and 1,000 after; summarising the page back to it adds little.
  What it lacks is the ticket, the function, the decision in another doc.
- **Topic drift is the trigger.** Compare the section's new embedding with the one the last
  briefing was written for; past a threshold, refresh. Calls scale with topic changes — tens
  in a writing session — not with typing.
- **Written as reference material, not instructions.** Fill-in-the-middle models continue
  documents. Short factual lines with exact names get copied; instructions are wasted or leak
  into completions. The seed keeps its HTML-comment form and escaping.
- **Staleness is tolerable.** The topic moves slowly; the completion window covers the fast
  local text.
- **Measured, not assumed.** `suggestionLog` records accept rates, so the briefing ships behind
  a comparison with and without it.
- **Metered.** Ordinary typing triggers paid calls, so the refresh sits behind an entitlement
  and `requestLimits`.

The briefing model and the page digest are the same job seen from two sides: the digest writes
what a page is about into the graph, and the briefing reads what the graph knows back into the
page being written.

### Learning

Log which nodes each turn packed, searched, expanded and read, and whether the turn was accepted
(`chatTurns` already records that). Start with Greptile's filter: demote a node that resembles
at least three that were packed and never used. Training a retriever on these traces, as Cursor
does, comes later and needs the log either way.

## Integrations

Integrations are **orthogonal to context**. Context is what the agent knows; integrations are
what it can do. They share no schema and no code path, and they meet in the agent. *(Reversed:
an earlier draft gave connectors an `actions()` function and made every write target a graph
node. That made us the bottleneck for every new action and tied writing to indexing.)*

- **The model chooses the target.** "File a ticket from this page": the agent reads context,
  sees the project's Linear team, and calls the Linear integration's create-issue tool. When two
  targets are plausible it asks — a prompt rule, not a mechanism. The research supports leaning
  on the loop: tool-use skill, not retrieval machinery, decided the memory benchmarks, and
  Greptile's gain came from replacing a fixed flow with an agent.
- **Integrations are MCP clients** where the vendor hosts a server — Linear at
  `mcp.linear.app/mcp`, GitHub's hosted server. We get their whole tool surface without writing
  actions, and new tools arrive without us.
- **Auth is per member, by OAuth.** A write appears as the person who asked, which settles
  attribution. Context connections stay per project and never write.
- **Reading and writing are independent.** Post to Slack without indexing Slack; index a repo
  no one may write to.

### Three seams

Orthogonal does not mean unaware. Three thin seams, none of which couples the schemas:

1. **Context carries native handles.** A node's brief and `read_context` output include what a
   provider's tools need — `owner/repo`, PR number, Linear team and project ids — from
   `externalId` and `url`. Source nodes are always in the pack, one line each. Without this the
   model searches the provider to rediscover what context already knows.
2. **Writes pass one gateway.** Every integration tool is classed read or write. A write renders
   a preview card — tool, target, acting as, payload — and sends on the person's click; it
   carries an idempotency key so a retried step cannot file twice; it is logged in
   `integrationCalls`. External writes cannot be undone, so checkpoints and ⌘Z do not cover
   them. This is the one place we do not rely on the model's judgement: text inside a ticket, a
   README or an email can try to steer the agent into acting, and the card is the backstop.
3. **Write-back by URL.** When a write returns a URL that a context connector recognises, that
   connector syncs it at once, so the new ticket is a node with an edge from the page before any
   webhook arrives. No action contract; a URL.

### Toolboxes

Vendor servers expose tens of tools each; five integrations would put well over a hundred
definitions in every request. Tools are therefore bucketed into **toolboxes**, one per product,
and a request carries definitions only for what the conversation is using.

- **The Nootles toolbox is always open**: pages, canvas, context, and `open_toolbox`.
- **Every other toolbox is one line in the prompt until opened**: its name, what it covers, the
  verbs it offers, and whether this member has connected it. About 20 tokens each. Discovery
  rests entirely on that line, so it is written with the care of a skill's description.
- **`open_toolbox(name)`** registers that toolbox's tools for the rest of the thread — AI SDK
  `activeTools`, which `app/api/chat/route.ts` already uses — and returns a short usage note plus
  this project's native handles for that provider, read from the graph: the Linear team and
  project ids, the repos. Seam 1 is delivered here, so handles arrive when needed instead of
  riding in every pack.
- **Open stays open.** The open set is stored on the thread, so later turns start with the same
  tool list. Opening changes the front of the request and costs one prompt-cache miss; closing
  would cost another, so nothing closes.
- **Flat, not a tree.** One level is enough while a toolbox stays under about fifteen tools.
  Each toolbox is a curated allowlist of the vendor's tools, not the whole server. A suite
  splits by product — Gmail, Calendar, Docs — not into sub-levels.
- **Opening has no side effects**, so it needs no confirmation. Writes inside still pass the
  gateway.
- **A hint, not a decision.** The open-page note can say the page links three Linear tickets.
  The model decides whether to open the toolbox.

Considered: one fixed `use_tool(toolbox, tool, args)` dispatcher, which never changes the tool
list and so never misses the cache. It gives up typed arguments at the provider, and wrong
arguments on an external write are the costlier failure. One miss per toolbox per thread is the
cheaper price; `aiCalls` will show if that is wrong. On Anthropic models the same behaviour maps
onto deferred tool loading, which keeps the cache — the toolbox layer is ours so that it works
on every provider the chat route supports.

The native tools are a candidate for the same treatment. `app/lib/ai/chat/tools.ts` defines
about thirty, thirteen of them for the canvas, and every request carries all of them. A Canvas
and a Media toolbox would follow the same rule; measure their token cost first.

### Opening a PR is a different class

A comment needs a target and text. A PR needs a branch and a diff. Through GitHub's tools the
agent can open a PR for files it authored — a spec exported to `docs/`, a diagram, a decision
record. Code changes belong to a coding agent; there the right move is an issue written for
that agent, carrying the code pointers from context.

## Embeddings

- One vector per node description, not per chunk. Files, concerns and areas eagerly; symbols
  lazily — identifiers are what full-text search is good at.
- A stage-0 templated description (path, leading comment, exports, concern name) makes a node
  findable before any model has summarised it. The vector is replaced when a summary lands.
- Around 512 dimensions, from a model that supports truncation. `model` and `dims` are on every
  row because changing model means re-embedding everything.
- Always fused with full-text. Anthropic's contextual-retrieval numbers: embeddings alone cut
  retrieval failures 35%, adding keyword search 49%.
- Embeddings also build the graph: `about` and `same_as` edges for content with no links come
  from similarity.

## Convex constraints and cost

| Constraint | Consequence |
|---|---|
| A query scans at most 32,000 documents and 16 MiB | Global rank is computed at ingest in an action; query-time PageRank runs over the seed's neighbourhood only. The graph view loads by tier. |
| Vector search: actions only, 256 results, equality or OR filters | The composite `scope` field. |
| Search is billed on the full index size per query, regardless of filters ($0.10 per 1,000 query-GBs on Professional) | One vector per node, small dimensions, autocomplete never searches. The index sits behind one module so it can move to a per-project namespaced store when the bill says so. |
| Documents are 1 MiB | Bodies live in file storage or at the source. |

The graph itself — adjacency by `by_from_and_family` and `by_to_and_family` — fits Convex
indefinitely, and keeps the view reactive and access checks in `convex/auth.ts`.

## Access

Everyone in a project can read everything a connection brings in, viewers included. For now
everything is public within the project; there is no per-node permission. The control is scoping
at connect time: choose the repos, labels and folders. Connections belong to the project, record
`connectedBy`, and the dialog says plainly that connecting shares the content with every member.
Owners and editors can connect, correct and pin; resolution stays in `convex/auth.ts`.

Ownership is shown, never enforced. Every node displays its `owner`, so a reader knows whose
ticket, page or thread they are looking at, but owning a node grants nothing and hiding it from
others is not possible. If per-node visibility ever arrives, `owner` is the field it keys on.

## Graph view

The design already carries what the view needs: a source logo from the connection's provider, a
required `title`, brief on hover, summary in the panel, body on click through `read_context`,
the node's `owner` (avatar when it maps to a member, the source handle otherwise),
edge family and origin for line styling, `syncedAt` / `stale` / `syncError` for honest state,
and `contextUsage` to show what a turn looked at. Two things exist for the view:

- **Rollup edges between concerns**, precomputed at ingest, so the top level is a small query.
  The same edges feed architecture diagrams, and map closely onto `<nt-diagram>`.
- **Human corrections** — rename, merge, move, pin, exclude — written as `origin: human` edges
  through the same operations the agent uses.

Level of detail follows the tiers: sources and areas, then concerns, then artifacts, then parts.
Layout is computed on the client; saved positions, if ever, live outside these tables.

## Spike results

Stages 0 and 1 against this repo. 781 files, 7.4 MB, 6,534 top-level symbols, 2,462 import
edges, 727 Convex API edges, 232 usable commits. Parsing took 556 ms and git history 244 ms.
Ground truth was 18 concerns written down from the repo's own layout and docs before clustering.

| Method | Concerns | Largest | Recall | Precision | F1 | Seed stability |
|---|---|---|---|---|---|---|
| Label propagation, combined graph | 38 | 348 | 0.77 | 0.51 | — | 0.46 |
| Louvain, references only | 19 | 101 | 0.84 | 0.44 | — | 0.67 |
| Louvain, co-change only | 15 | 229 | 0.92 | 0.33 | — | 0.81 |
| Louvain, combined, resolution 1 | 19 | 143 | 0.87 | 0.41 | 0.49 | 0.79 |
| Louvain, combined, resolution 3 | 39 | 52 | 0.81 | 0.67 | 0.69 | 0.79 |
| Louvain, combined, resolution 6 | 57 | 34 | 0.71 | 0.76 | 0.69 | 0.85 |
| Split inside each area, at most 60 files | 55 | 49 | 0.72 | 0.77 | 0.70 | 0.80 |
| Split inside each area, at most 35 files | 58 | 35 | 0.69 | 0.77 | 0.68 | 0.78 |

What it showed:

- **Structure alone finds the concerns.** At the fine level GitHub, billing and share come out
  at 100% recall; staged demo, album, location, the Figma plugin, `lib/notion`,
  `convex/notion`, `components/notion` and `lib/ai/canvas` each land as a clean cluster.
- **No single resolution works.** Coarse clusters unite a feature's front and back end (Notion:
  97% recall) but bury small concerns (GitHub: 7% precision). Fine clusters isolate the small
  ones and shatter the large (canvas across 10). Hence two levels; splitting inside each area scores as
  well as the best flat resolution and nests for free.
- **Cross-cutting infrastructure is not recovered at either level.** Sync, history and canvas
  collab are touched by everything, so they smear across clusters (sync: 53% recall at 6%
  precision as an area, 47% at 50% as a concern). These are what a person pins by hand, and the
  first job for human corrections.
- **Label propagation is out.** It was the least stable and built one 348-file cluster.
- **Co-change is the stronger signal, references sharpen it.** A repo with no history, or with
  noisy commits, falls back to references. This repo's squash-merged PRs flatter the result.
- **Directory names cover half.** 30 of 58 fine concerns have no directory that fits them; they
  need a model or a person to name them. That bounds stage 2 rather than removing it.
- **Cold re-clustering reshuffles.** Seed stability near 0.8 means two cold runs disagree on
  about a fifth of pairings. Production re-clusters warm (0.93).
- **The pack works.** Seeded on `ContextDialog.tsx` with a 600-token budget it returned
  `convex/ai/context.ts`, `convex/github/repos.ts`, `convex/auth.ts`, `app/api/chat/route.ts`,
  `serverTools.ts`, `prompt.ts` and `questions.ts` — the files this document is about. It also
  let `Icons.tsx` and `globals.css` through, which is why packs discount hubs.
- **Sizing.** Templated descriptions for every file total 22,973 tokens. Vectors at 512
  dimensions: 3.2 MB for files, 30 MB with every symbol. Stage 2 is about 140 model calls (19
  areas, about 40 concerns, the top tenth of files), against 7,315 to summarise every file and
  symbol. The area and concern map is about 100 tokens.

Limits of the spike: one TypeScript repo, parsed with the TypeScript compiler rather than
tree-sitter; ground truth written by the author of the spike; only 139 of 781 files have a
leading comment, so templated descriptions are thin for most files and **semantic entry quality
is untested**. The scripts are in the session scratchpad, not the repo.

## What is built

The first cut: the graph, one budgeted pack for both lanes, the pages connector and the three
tools, with pages, Description and Context as the only sources. Where it departs from the sketch
above, the departure is deliberate:

- **Tables.** `contextNodes`, `contextNodeText` and `contextEdges` (`convex/schema.ts`). A node
  is split in two: the pack reads every node in a project and re-runs whenever one changes, so
  the node keeps only what a pack prints (title, brief, owner) and the churning half — summary,
  search terms, content hash — lives in `contextNodeText`, which carries the full-text index.
  The same reasoning as keeping vectors in their own table. `contextConnections`,
  `contextVectors`, `contextPacks` and `contextUsage` wait for the step that needs them.
- **Pinned notes stay in `contextSheet`.** Description and Context are read straight from the
  sheet and always packed first, so they never need ranking or search, and no migration moved
  them.
- **Owner** is `{ memberId?, handle? }`: a page's is its creator (`pages.createdBy`, falling
  back to the project owner for pages made before it existed), shown by name in tool results.
- **The digest is written by the browser**, behind the sync provider's flush and on first
  sync, the way `pagePreviews` is — reading a Y.Doc as blocks needs BlockNote's schema, which is
  a browser bundle (`app/lib/ai/context/digest.ts`, `convex/context/pages.ts`). It is
  templated, not model-written: brief, section outline and opening, search terms (canvas labels
  included) and the pages it mentions. Page-level only; block and shape parts are not nodes yet.
- **Provenance gating** is a refusal: while a turn that edited the page is streaming or awaiting
  review, its digest is declined and offered again on the next flush or visit.
- **Packs are rendered on read**, by pure functions over one query
  (`app/lib/ai/context/pack.ts`): the chat pack in two halves — the cached project half (notes,
  pages by id, in sidebar order so it stays byte-stable) and the half around the open page
  (pages it mentions, pages mentioning it, recent edits, with briefs) — and the completion seed.
  Ranking is links then recency; PageRank waits for step 5.
- **Tools.** `search_context` (full-text only), `expand_context`, `read_context`, surfaced to
  chat and tagged for MCP. They replace the four repo and file tools.
- **Repositories and files are out of context** until their connectors: they no longer reach
  the prompt, the seed or the tool list, and the context dialog no longer shows them. Their
  tables and backend stay for the connectors. The staged demos C-11 and C-16 read the firmware
  source kept in the project, as they already did wherever no repo was linked.
- **Backfill.** `npx convex run migrations:contextPageNodes` gives every existing page a title
  node; its words arrive with its first digest.

## Build order

1. **Unify and budget.** The tables, the migration of the three existing sources, and one pack
   renderer with a budget replacing `projectNote` and `contextSeed`. No retrieval yet. This
   alone fixes the unbounded prompt.
2. **The pages connector.** Page, block and shape nodes, parsed edges from links and ids,
   provenance gating, digest on idle. The cheapest connector — no auth, no external API, no
   parse worker — so it proves the contract before GitHub stresses it.
3. **GitHub stages 0 and 1.** Batched ingest, resolvers, areas and concerns, rank, rollups,
   polling updates.
4. **The three tools**, the full-text index and vectors over templated descriptions. Build the
   evaluation set here.
5. **Stages 2 and 3**, usage logging, PageRank packs, then the autocomplete seed: glossary and
   briefs first, the briefing behind an accept-rate comparison.
6. **Graph view** and human corrections.
7. **Linear**, to prove the contract on an external structured source.
8. **Gmail**, the first unstructured source, porting Graphiti's extract → resolve → invalidate
   steps as its splitter.

**In parallel: integrations.** They depend on none of the steps above. Build the write gateway
— classification, preview card, idempotency, log — and `open_toolbox`, then attach Linear's MCP server, then
GitHub's. Write-back by URL lights up as each context connector lands.

**Evaluation.** Before step 4 ships, write 60 to 90 real questions across roles, each with the
nodes a good answer needs, and score retrieval by whether those nodes are found. Scoring is
static except for embedding the questions, which is a paid call and needs the operator's
approval per run, as does any ingest that embeds or summarises.

## Open questions

- Does tree-sitter's WASM build run in a Convex Node action, and what does a 10× larger repo
  cost in memory per batch?
- Does a general embedding model suffice, given we embed English descriptions, or does a
  code-tuned one earn its price? The evaluation set decides.
- How thin can a templated description be and still be found by a cross-role question?
- Clustering for repos with no useful history, and for monorepos where an area is a package.
- Identity: mapping one person across GitHub, Linear and Gmail. No one has published a method;
  the floor is an email-keyed join plus manual mapping. This is what fills `owner.memberId`;
  until it resolves, the handle is shown.
- What a large-context tier meters: nodes, vector storage, or stage-2 and stage-3 calls.
- The briefing's drift threshold, and how the seed's 2,400 characters split across its four
  parts. `ttfbMs` is already in the ledger, so raising the cap is measurable.
- Does the briefing raise the accept rate enough to pay for itself?
- Should Description and Context become a pinned page rather than a separate concept?
- How much weight AI-written page content carries once a person has accepted it.
- Whether any write ever skips the preview card — a comment on a ticket the person just
  opened, say — and who decides.
- Whether a vendor's MCP server can be limited to the teams and repos a project uses. Linear's
  OAuth grant is workspace-wide, so today the card is the only bound.
- What one cache miss per opened toolbox costs in practice, and whether the native tools
  should be bucketed too.

## Not doing

- **A graph database.** Two indexed tables are an adjacency list; one or two hops are index reads.
- **Graphiti as a dependency.** It is Python on Neo4j, FalkorDB or Neptune, and its value is a
  model-driven extraction pipeline that code does not need. Its open issue asking for
  deterministic ingest has had no reply since March 2026, and Zep replaced model steps with
  classical ones to survive its own ingest costs. We take its four timestamps, its evidence
  trail and its no-model query path now, and port its extraction steps when email arrives.
- **Eager community summaries** in the GraphRAG style.
- **Contradiction detection**, for now.
- **Retrieval on the autocomplete hot path.** Retrieval informs autocomplete, asynchronously.
- **A model call per keystroke, or a summary of the page in its own seed.**
- **A private path for pages.** They are a connector like any other.
- **External writes without a person's confirmation.**
- **Code-change PRs.** That is a coding agent's job; Nootles hands it a well-written issue.
- **Actions on connectors, or write targets as graph nodes.** Considered and reversed: it makes
  us the bottleneck for every action and ties writing to indexing.
- **Per-node permissions.**

## Sources

- Greptile: [semantic code search](https://www.greptile.com/blog/semantic), [graph context](https://www.greptile.com/docs/how-greptile-works/graph-based-codebase-context), [v3 agent loop](https://www.greptile.com/blog/greptile-v3-agentic-code-review), [learned filter](https://www.greptile.com/blog/make-llms-shut-up), [architecture](https://www.greptile.com/docs/system-architecture)
- Aider: [repo map](https://aider.chat/2023/10/22/repomap.html), [`repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)
- Cursor: [semantic search A/B](https://cursor.com/blog/semsearch), [indexing](https://cursor.com/blog/secure-codebase-indexing)
- Sourcegraph: [autocomplete lifecycle](https://sourcegraph.com/blog/the-lifecycle-of-a-code-ai-completion), [context engineering](https://sourcegraph.com/blog/context-engineering)
- Graphiti: [repo](https://github.com/getzep/graphiti), [paper](https://arxiv.org/html/2501.13956), [issue 1299](https://github.com/getzep/graphiti/issues/1299), [Zep scaling](https://blog.getzep.com/scaling-agent-memory-zep-30x/)
- Graph versus flat: [RAG vs GraphRAG](https://arxiv.org/html/2502.11371v3), [GraphRAG-Bench](https://arxiv.org/html/2506.05690v1), [HippoRAG 2](https://arxiv.org/html/2502.14802v2), [LocAgent](https://arxiv.org/abs/2503.09089)
- Anthropic: [contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval), [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Context rot](https://www.trychroma.com/research/context-rot) · [Unblocked's context engine](https://getunblocked.com/blog/how-a-context-engine-actually-works-and-why-you-need-to-care-now/)
- Integrations: [Linear MCP server](https://linear.app/docs/mcp), [Linear actor authorization](https://linear.app/developers/oauth-actor-authorization)
- Convex: [limits](https://docs.convex.dev/production/state/limits), [vector search](https://docs.convex.dev/search/vector-search), [actions](https://docs.convex.dev/functions/actions), [pricing](https://www.convex.dev/pricing)
