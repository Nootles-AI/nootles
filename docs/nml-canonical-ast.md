# Canonical NML AST and Yjs encoding

Status: proposed architecture; not implemented.

This document defines the canonical semantic document model for the Nootles Markup
Language (NML). It separates three things that are easy to conflate:

1. the canonical typed NML abstract syntax tree (AST),
2. its collaborative encoding in Yjs, and
3. its deterministic textual serialization.

The AST is the product document model. Yjs supplies concurrency and persistence. NML
text is the human/model-readable wire and interchange form. No renderer or editor engine
owns the document model.

## Goals

- Make the same document tree usable in the browser, backend, MCP, tests, imports, and
  exports.
- Give every addressable node a stable identity independent of its position.
- Make human and model edits invoke one validated semantic operation vocabulary.
- Preserve intent under concurrent edits without whole-document replacement.
- Make serialization deterministic and lossless.
- Permit multiple view engines without storing a view engine's private representation.
- Preserve Nootles' bounded hierarchy and exact custom-block round trips.
- Support schema evolution through explicit, deterministic migrations.

## Non-goals

- The serialized NML string is not the collaborative CRDT. A single `Y.Text` containing
  markup would make node moves, attributes, and concurrent structural edits fragile.
- The AI's compact projection is not canonical. Collapsed albums, drawing stubs, and
  diagram briefs intentionally discard data.
- The AST does not define caret behavior, DOM behavior, or visual layout.
- This proposal does not make page or shape nesting recursive. The product hierarchy
  remains bounded.

## Layer model

```text
                    Canonical NML AST
                stable nodes, typed fields
                  /         |          \
                 /          |           \
        Yjs encoding   NML serialization  semantic operations
       collaboration     interchange       mutation language
              |                |                  |
        persistence       AI / MCP / files   human + model
```

The following equivalences are required for every supported schema version:

```text
parse(serialize(ast)) ≡ normalize(ast)
serialize(parse(canonicalText)) === canonicalText
decodeYjs(encodeYjs(ast)) ≡ normalize(ast)
```

`≡` means semantic equality, including IDs, node order, typed properties, inline marks,
and child structure.

## Document envelope

The page title, project membership, and navigation position remain page metadata rather
than document nodes.

```ts
type NmlDocument = {
  schemaVersion: number;
  documentId: string;
  blocks: NmlBlock[];
};
```

Rules:

- `schemaVersion` identifies the canonical AST/Yjs schema, not the application version.
- `documentId` is the page's durable document ID.
- `blocks` contains ordered top-level blocks.
- An empty document has `blocks: []`; renderers may display an ephemeral empty paragraph,
  but must not persist one until edited.
- Page title is contextual serialization metadata and must never parse into a block.

## Identity

Every block has a stable `id`.

```ts
type NodeId = string;

type NmlBlockBase<T extends string, P> = {
  id: NodeId;
  type: T;
  props: P;
  children: NmlBlock[];
};
```

Identity rules:

- IDs are opaque, globally unique within the Nootles deployment, and immutable.
- Position is never identity.
- A move preserves the node ID and the identities of its descendants.
- Copying mints new IDs for the complete copied subtree.
- Importing external NML without IDs mints IDs.
- Importing NML with IDs preserves them only when the caller has explicit preserve-ID
  authority and no collision exists. Normal paste and model insertions never choose IDs.
- Model operations use temporary IDs within one atomic batch; the executor resolves them
  to minted IDs.
- Duplicate IDs make a document invalid. Resolution is deterministic: retain the first
  node in document order and re-ID later nodes, recording a repair event.
- IDs must not encode user identity, time, project identity, or ordering.

## Block AST

The initial canonical block union follows the current producible Nootles vocabulary:

```ts
type NmlBlock =
  | TextBlock
  | HeadingBlock
  | ListItemBlock
  | TableBlock
  | CodeBlock
  | MathBlock
  | DividerBlock
  | MediaBlock
  | CanvasBlock
  | AlbumBlock
  | StoryboardBlock
  | LocationBlock;

type TextBlock = NmlBlockBase<
  "paragraph" | "quote",
  Record<string, never>
> & { content: InlineContent };

type HeadingBlock = NmlBlockBase<"heading", { level: 1 | 2 | 3 | 4 | 5 | 6 }> & {
  content: InlineContent;
};

type ListItemBlock = NmlBlockBase<
  "bulletListItem" | "numberedListItem" | "checkListItem" | "toggleListItem",
  { checked?: boolean; start?: number }
> & { content: InlineContent };

type TableBlock = NmlBlockBase<"table", { headerRows: number }> & {
  rows: TableRow[];
};

type TableRow = { id: NodeId; cells: TableCell[] };
type TableCell = { id: NodeId; content: InlineContent };

type CodeBlock = NmlBlockBase<"codeBlock", { language: string }> & {
  code: string;
};

type MathBlock = NmlBlockBase<"mathBlock", Record<string, never>> & {
  rows: Array<{ id: NodeId; latex: string }>;
};

type DividerBlock = NmlBlockBase<"divider", Record<string, never>>;

type MediaBlock = NmlBlockBase<
  "image" | "video" | "audio" | "file",
  { source?: MediaSource; caption?: string; name?: string }
>;

type MediaSource =
  | { kind: "storage"; storageId: string }
  | { kind: "url"; url: string };

type CanvasBlock = NmlBlockBase<"canvas", CanvasProps>;
type AlbumBlock = NmlBlockBase<"album", AlbumProps>;
type StoryboardBlock = NmlBlockBase<"storyboard", StoryboardProps>;
type LocationBlock = NmlBlockBase<"location", LocationProps>;
```

The concrete custom-block property schemas must be imported from their domain definitions,
not restated independently. Until each custom block is structurally encoded in the AST,
its canonical, uncollapsed inner NML may be retained in a typed `canonicalMarkup` field.
That is a migration bridge, not permission for arbitrary HTML.

### Child rules

- Top-level `blocks` may contain any block type.
- `children` is initially non-empty only on list items and toggles.
- Paragraphs, headings, quotes, tables, code, math, divider, media, canvas, album,
  storyboard, and location blocks reject block children.
- Lists are represented as item nodes, not wrapper nodes. Consecutive compatible items
  serialize under one `<ul>` or `<ol>` wrapper.
- A toggle's child blocks are bounded document children; they do not create a page or
  arbitrary recursive surface.
- Canvas shapes are not `NmlBlock` children. They belong to the canvas domain and retain
  their bounded `Shape -> {rich text, image}` hierarchy.

## Inline AST

Inline content is collaborative at character granularity while retaining semantic embeds.

```ts
type Mark = "bold" | "italic" | "underline" | "strike" | "code";

type InlineContent = InlineNode[];

type InlineNode =
  | { type: "text"; text: string; marks: Mark[] }
  | { type: "link"; href: string; content: TextInline[] }
  | { type: "math"; id: NodeId; latex: string }
  | { type: "pageRef"; id: NodeId; pageId: string; fallbackTitle: string };

type TextInline = { type: "text"; text: string; marks: Mark[] };
```

Resolution rules:

- Adjacent text runs with identical normalized marks merge during normalization.
- Marks are a set serialized in the order `code`, `bold`, `italic`, `strike`,
  `underline`; input order has no meaning.
- Empty text runs are removed.
- Links contain text only. Nested links and non-text embeds inside links are invalid.
- Unsafe URL schemes are rejected, not rewritten.
- A page reference stores its page ID and fallback title. Rendering may resolve a newer
  live title without mutating the document.
- Inline embeds have stable IDs so concurrent deletion/update can resolve by identity.
- Newlines in prose become explicit hard-break inline nodes if the product supports hard
  breaks; until then they normalize to spaces. Code and LaTeX preserve newlines exactly.

## Canonical Yjs encoding

The canonical root is a `Y.Map` named `nml`:

```text
Y.Map("nml")
├── schemaVersion: number
├── documentId: string
└── blocks: Y.Array<Y.Map<NmlBlock>>
```

Each block is encoded as:

```text
Y.Map
├── id: string
├── type: string
├── props: Y.Map
├── content: Y.XmlFragment or absent
├── children: Y.Array<Y.Map>
└── domain content: typed shared values
```

Encoding rules:

- Ordered collections use `Y.Array`.
- Scalar property bags use `Y.Map` with an explicit whitelist per node type.
- Collaborative prose uses `Y.XmlFragment`/`Y.XmlText` with formatting attributes, or a
  dedicated equivalent whose mapping is specified once. It must not be stored as an array
  of whole immutable strings.
- Code and LaTeX use `Y.Text`.
- Table rows and cells are addressable `Y.Map` nodes in `Y.Array`s.
- Unknown keys are not silently retained in canonical state. A newer schema must either
  be understood, preserved in a versioned extension container, or rejected as unsupported.
- The AST decoder must never depend on insertion clocks, Yjs client IDs, or internal item
  identifiers. Those are collaboration mechanics, not product identity.
- One semantic command executes in one Yjs transaction with a structured origin.

### Transaction origin

```ts
type NmlTransactionOrigin = {
  version: 1;
  transactionId: string;
  actor: {
    userId: string;
    kind: "human" | "model" | "system";
    clientId?: string;
  };
  command: string;
  requestId?: string;
  batchId?: string;
};
```

Origins drive attribution, audit, coherent undo, idempotency, and feedback. They are not
authorization evidence; authorization is checked before the transaction begins.

## Semantic operation model

All mutations target stable IDs and compile to Yjs transactions. The minimum vocabulary is:

- `insertNodes(parentId, anchor, nodes)`
- `removeNodes(nodeIds)`
- `moveNodes(nodeIds, destination)`
- `setNodeProps(nodeId, patch)`
- `replaceInline(nodeId, range, content)`
- `setInlineMarks(nodeId, range, marks)`
- `splitTextBlock(nodeId, offset)`
- `joinTextBlocks(leftId, rightId)`
- `replaceTableRange(tableId, range, cells)`
- `setCode(nodeId, range, text)`
- `setMathRow(nodeId, rowId, latex)`

High-level commands such as slash commands compile into this vocabulary. Import adapters
and model-friendly `edit_page` HTML compile into it as well. No adapter writes Yjs shared
types directly outside the canonical executor.

### Atomicity and preconditions

- A batch validates completely before mutation.
- Shape validation, authorization, node existence, parent compatibility, and content
  compatibility are preconditions.
- References to nodes deleted before execution return a typed conflict.
- A move whose anchor was concurrently deleted resolves against the anchor's surviving
  predecessor/successor captured by a relative position; if neither survives, it appends
  to the intended parent.
- Repeating an operation with the same idempotency key returns the original result.
- Partial application is forbidden unless the operation explicitly defines independent
  hunks and returns a result for every hunk.

## Concurrent resolution rules

Yjs determines causality and deterministic CRDT ordering. NML adds semantic resolution:

### Text

- Concurrent inserts at one position both survive in Yjs order.
- Deletion removes only content observed by the deleting transaction; concurrent unseen
  insertion survives.
- Marks apply to the resolved Yjs range and do not imply replacement of its text.
- Replacing a whole text field must compile to a character-level diff, not delete-all and
  insert-all, unless the caller explicitly requests destructive replacement.

### Properties

- Independent property keys merge.
- Concurrent writes to the same scalar property use Yjs' deterministic last-writer result.
- Product-critical enumerations are validated after merge; invalid values are repaired to
  the most recent valid value or the schema default and logged.
- Composite values that require atomic consistency must occupy one shared value or change
  through a domain-specific command.

### Structure

- Concurrent insertions both survive.
- A node may have exactly one parent. Moves are encoded through a move primitive or
  indirection that cannot leave duplicate live copies.
- Delete wins over a concurrent move of the same observed node; moving a node already
  absent produces a conflict rather than recreating it.
- Concurrent moves of the same node resolve deterministically to one destination and emit
  a conflict/audit event for product visibility.
- Removing a parent removes the observed subtree. Concurrent insertion into that subtree
  must either survive in a recovery container or be reported as orphaned; silently losing
  it is forbidden. The initial implementation should use a hidden recovery root and expose
  recovery through history.
- Schema normalization must be deterministic and idempotent on every client.

### Tables

- Rows and cells have IDs; row insertion and deletion merge structurally.
- Column operations are table-wide semantic commands, not independent array mutations in
  every row.
- Concurrent column changes are ordered through stable column IDs, which should be added
  before collaborative structural table editing ships.
- A rectangular selection is view state, never document state.

### Custom blocks and canvas

- Whole-string custom markup is a temporary compatibility boundary. Concurrent writes to
  that string are whole-value conflicts.
- Canvas remains per-shape/per-edge CRDT data and must not regress to a whole-diagram
  scalar. The canonical NML serializer materializes the exact `<nt-diagram>` form from
  those maps.
- The canvas block ID and shape IDs remain stable across serialization.
- Albums/storyboards/locations need domain-specific shared structures before promising
  fine-grained concurrent edits within them.

## Canonical serialization

The existing NML tags remain the starting syntax:

- `<p>`, `<h1>`–`<h6>`, `<blockquote>`, `<ul>`, `<ol>`, `<li>`, `<details>`
- `<table>`, `<tr>`, `<th>`, `<td>`
- `<nt-code-block>`, `<nt-math-block>`, `<nt-math-line>`
- `<img>`, `<video>`, `<audio>`, `<nt-file>`
- `<nt-diagram>`, `<nt-album>`, `<nt-storyboard>`, `<nt-location>`
- `<strong>`, `<em>`, `<u>`, `<s>`, `<code>`, `<a>`, `<nt-math>`, `<nt-ref>`

Canonical output rules:

- Emit canonical tag names only; aliases are accepted input but never emitted.
- Emit lowercase tags and attribute names.
- Emit attributes in a fixed schema-defined order, with `id` first.
- Omit properties equal to their canonical default.
- Escape prose and attributes; preserve code and LaTeX through an explicit raw-text
  encoding that cannot terminate its containing element.
- Normalize prose whitespace; preserve code and LaTeX whitespace.
- Serialize consecutive compatible list items under one list wrapper.
- Serialize marks in canonical nesting order.
- Use `\n` line endings and one final newline for complete documents.
- Never emit token-saving stubs in canonical mode.
- Never emit ephemeral selection, presence, loading, or review state.
- URLs serialize only after scheme validation and canonical escaping.

Parsing modes:

1. `canonical`: strict; rejects aliases, unknown constructs, duplicate IDs, and noncanonical
   ordering. Used for verification.
2. `import`: accepts aliases and common HTML variations, normalizes them, sanitizes unsafe
   content, and returns diagnostics.
3. `model`: accepts the documented model conveniences and returns diagnostics plus typed
   operations relative to a known document. It must never be used to decode persistence.

## Validation and repair

Validation returns structured issues with node ID, path, code, severity, and proposed
repair. It never silently drops user content.

```ts
type NmlIssue = {
  code: string;
  severity: "error" | "repair" | "warning";
  nodeId?: string;
  path: Array<string | number>;
  message: string;
};
```

- Errors prevent a local command from committing.
- Repairs are deterministic responses to already-merged remote state.
- Repair transactions use `actor.kind = "system"`, reference the triggering update, and
  are idempotent.
- Unsupported newer schema versions are read-only. Older clients must not normalize data
  they do not understand.
- Invalid content is retained in a recoverable quarantine payload when safe rendering is
  impossible.

## Versioning and migrations

- Every document declares its schema version in the Yjs root.
- Migrations are pure `vN AST -> vN+1 AST` transformations with fixtures.
- Only one elected backend migrator writes a durable document migration. Browsers may
  preview migrations but must not race to persist them.
- Migration preserves IDs unless the old representation lacked an independently
  addressable entity.
- A migration is one attributed Yjs transaction and records before/after schema versions.
- Rolling deployment requires readers for the previous version until all live clients can
  understand the new one.
- Downgrade behavior is explicit: read-only, lossless passthrough, or supported reverse
  migration. Silent lossy downgrade is forbidden.

## Persistence and history

- Convex continues to persist Yjs snapshots plus ordered update chunks.
- Snapshots are compaction artifacts, not user-visible versions.
- Semantic transaction metadata forms the audit/operation log.
- Named versions and AI checkpoints reference a Yjs state vector and, where required, a
  packed full AST for bounded restoration time.
- Restoration is a new semantic transaction against current state, not replacement of the
  stored update history.
- History views group by transaction origin and batch ID.

## Security

- Authorization is resolved before reading or mutating the document.
- Owner/editor/viewer remains the project permission model.
- Stand-in operator sessions remain read-only.
- Imported/model NML is untrusted input: sanitize URLs, reject scripts/event attributes,
  cap depth/size, and validate every property.
- Yjs updates are not trusted merely because they decode. The backend must associate them
  with an authenticated document channel and enforce size/rate limits.
- MCP tokens identify the invoking user and client; transaction metadata identifies the
  model actor but does not replace user authorization.

## Performance requirements

- Typing must remain O(1) relative to document size on the hot path.
- A text edit must not serialize or validate the entire document synchronously.
- Indexes from node ID to shared node/view position update incrementally.
- Canonical full serialization is on-demand and may be streamed for large pages.
- Yjs updates remain below backend value limits and use existing chunking/compaction.
- Renderers subscribe to affected node projections rather than the whole AST where
  practical.

## Test obligations

- AST parser/serializer property tests and golden fixtures for every node type.
- Yjs encode/decode equality tests.
- Two- and three-client concurrency matrices for text, marks, moves, delete/edit, and
  parent deletion/child insertion.
- Schema migration fixtures across every supported version.
- Fuzz tests for malformed NML and arbitrary valid semantic-operation sequences.
- Cross-runtime parity tests in browser and Node.
- Compatibility fixtures for every existing stored BlockNote/ProseMirror document.
- Exact canvas, album, storyboard, and location round-trip tests.
- Large-document and chunked-update tests.

## Adoption sequence

1. Freeze and type the lossless NML AST independently of storage.
2. Add canonical serializer/parser tests around current documents.
3. Define the Yjs encoding and build bidirectional converters in isolation.
4. Mirror current documents into an NML Y.Doc and compare continuously without serving it.
5. Introduce the ProseMirror View Bridge described in
   [`nml-prosemirror-view-bridge.md`](nml-prosemirror-view-bridge.md).
6. Migrate one document cohort with rollback and equivalence checks.
7. Move MCP and backend readers to canonical NML.
8. Retire the ProseMirror-shaped persisted root only after all clients and legacy documents
   are migrated.

## Open decisions

- `Y.XmlFragment` versus a purpose-built inline `Y.Array` encoding for inline content.
- The move primitive needed to guarantee single-parent identity under concurrent moves.
- Whether orphaned concurrent inserts enter a recovery root or revive their nearest
  surviving ancestor.
- Whether table columns receive stable IDs in schema version 1.
- Whether code and math rows need independently addressable inline marks or annotations.
- When albums, storyboards, and locations graduate from canonical-markup compatibility
  fields to fully structured CRDT domains.
- Whether canvas shape text shares the document inline AST or remains canvas-domain rich
  text with an explicit conversion boundary.
- Retention and user experience for named versions, checkpoints, and recovery content.
- Maximum supported document depth, node count, inline length, and custom-block payload.
