# NML / ProseMirror refactor plan

Status: in progress; steps 1–12 complete, plus step 13's server-side verification prerequisite.
Remaining: step 13's editor-serve rollout, then steps 14–15.

ProseMirror remains the browser editing engine. Canonical ownership moves from a
ProseMirror-shaped Yjs root to a typed, versioned NML AST stored directly in Yjs. Existing
Convex snapshot/update persistence stays initially.

## 1. Freeze foundational decisions — complete

The binding v1 choices are in
[`nml-foundational-decisions.md`](nml-foundational-decisions.md). Reopening one requires an
explicit architecture decision covering migration and compatibility.

## 2. Build the headless NML core — complete

- Implement versioned AST types, runtime schemas, stable IDs, normalization, validation,
  repair, strict serialization, parsing modes, diagnostics, and pure migrations.
- Import custom-domain schemas from their owners rather than duplicating them.
- Add golden fixtures, parser/serializer properties, fuzzing, and Browser/Node parity.

**Gate:** canonical text round-trips preserve semantic equality, IDs, and domain content.

Implemented in `app/lib/nml/`. Schema v1 now has strict Zod runtime schemas, stable IDs,
normalization, structured diagnostics, deterministic duplicate-ID repair, a pure migration
registry, and canonical/import/model parsing modes. Canonical documents use an explicit
`<nt-document id="…" schema-version="1">` envelope. Album, storyboard, location, and
canvas values validate through schemas owned by those domains; temporary custom-domain
`legacyMarkup` is escaped and losslessly serialized.

The golden fixture covers every v1 block and inline kind. Generated properties, malformed
input fuzzing, and independent Node/DOMParser-compatible entry points verify semantic,
ID, and domain round trips. The core is isolated from persistence and does not change the
live BlockNote/ProseMirror authority.

## 3. Define the canonical Yjs encoding — complete

- Add `Y.Map("nml")`, collaborative inline text, addressable tables, `Y.Text` code/math,
  structured domains, canvas scene maps, origins, and semantic change-set observation.
- Restrict canonical shared-type mutation to the NML executor.
- Test AST/Yjs equality, chunking, cross-runtime parity, and multi-client merging.

**Gate:** browser and Node decode the same AST from the same Y.Doc.

Implemented in `app/lib/nml/yjs.ts`. The versioned `nml` root encodes ordered blocks and
children as `Y.Array`, typed property/domain objects as nested shared maps/arrays, prose as
`Y.XmlFragment`/`Y.XmlText`, and code, math, and canvas labels as `Y.Text`. Tables retain
addressable columns, rows, and cells. Canvas scenes use ID-keyed shape/edge maps with
fractional order and independently collaborative labels; geometry and style stay atomic
values where their domain invariants require it.

Encoding and decoding validate schema versions, shared-type shapes, and key whitelists and
fail closed on malformed or newer state. Initialization refuses to overwrite an existing
canonical root; subsequent writes are reserved for the step-4 semantic executor. A
transaction observer emits attributed, state-vector-bounded semantic change summaries.
Round-trip, update chunk reconstruction, independent-runtime decoding, malformed-state,
origin observation, and multi-client text/canvas merge tests enforce the gate. This module
is still headless: no editor, provider, persistence, backend, AI, or MCP path consumes the
canonical root yet.

## 4. Implement the semantic command executor — complete

- Cover structure, props, inline content, tables, code, math, shapes, and edges.
- Support atomic batch validation, temporary IDs, preconditions, idempotency, typed
  conflicts, authorization, and attributed transactions.
- Converge AI operations, slash commands, imports, and future MCP edits on this vocabulary.

**Gate:** fuzzed command sequences and concurrency matrices preserve every invariant.

Implemented in `app/lib/nml/commands.ts`. The headless executor authorizes before reading,
resolves declared temporary IDs, checks state/node preconditions and durable idempotency
receipts, dry-runs and validates the full batch on a cloned Y.Doc, and commits successful
batches as one attributed transaction. Typed conflicts include authorization, stale state,
missing/duplicate entities, incompatible targets, invalid parents/anchors/ranges, dangling
edges, and idempotency-key reuse.

The vocabulary covers block insert/remove/move, property patches, UTF-16/grapheme-safe
inline replacement and marks, split/join, stable-ID table ranges, code and math text,
atomic custom domains, and per-shape/per-edge canvas edits. Block structure now adds an
ID-keyed registry, LWW placement records, and independent deletion tombstones over the
step-3 tree encoding. This keeps one live parent, makes deletion win over concurrent moves,
and recovers a concurrent child insertion at the document root if its parent disappears.
Legacy step-3 documents are decoded and upgraded lazily on their first structural command.

The gate is covered by command-domain tests, batch rollback and replay tests, authorization
ordering, stale-state and grapheme checks, deterministic command fuzzing, character-level
inline/code replica tests, concurrent move/delete matrices, and parent-deletion recovery.
The executor is exported as the common vocabulary, but existing AI, slash-command, import,
editor, provider, persistence, backend, and MCP paths remain deliberately unwired until
their later migration stages.

## 5. Add legacy conversion and shadow NML — complete

- Convert current BlockNote/ProseMirror documents and canvas map/HTML pairs into NML.
- Keep serving legacy truth while maintaining a non-serving shadow NML document.
- Compare structure, IDs, inline semantics, and fully materialized canvas scenes.
- Capture compatibility fixtures from representative stored documents.

**Gate:** the agreed corpus sustains semantic parity and every mismatch class
is understood.

Implemented in `app/lib/nml/legacy.ts`. `convertLegacyDocument` maps BlockNote block JSON —
the same denormalized tree the AI projection and applier read — directly into the v1 AST,
reading block props rather than the AI HTML grammar, which has drifted from the canonical
tags (`lang`/`language`, `page`/`page-id`, `alt`/`caption`, checklists as `<input>`) and
would lose fidelity. Custom domains decode through their owners (`migrateLegacyCanvas`,
`parseAlbum`/`parseStoryboard`/`parseLocation`), so no second schema exists. `buildLegacyShadow`
encodes the converted AST into a non-serving canonical Y.Doc via the existing writer.
`canvasSceneFromMirror`/`canvasSceneFromMaps` and `compareScenes` reconcile the two canvas
truths (the `<nt-diagram>` block-prop mirror and the per-shape CRDT maps). `compareLegacyToNml`
re-derives structure, IDs, inline semantics, and materialized scenes from the raw legacy tree
on a separate code path and classifies every difference.

The gate is covered by a representative compatibility-fixture corpus (rich text, tables,
code/math, media, canvas HTML, legacy React-Flow canvas JSON, album/storyboard/location,
`notionStub`, and nested-hoist) with golden conversion, per-fixture shadow Yjs round-trip,
per-mismatch-class tests, canvas map/mirror parity, a corpus parity gate, and fuzzing.
Across the corpus every document round-trips through the shadow and sustains semantic
parity; the only comparison mismatch is the understood `unsupported-block` class. The other
understood classes are recorded as conversion diagnostics: minted IDs for BlockNote's
position-only entities (inline embeds, table columns/rows/cells), prose-whitespace
normalization, dropped view-only styles, and non-list children hoisted to siblings. This is
a headless library addition: no editor, provider, persistence, backend, AI, or MCP path
builds or serves the shadow yet.

## 6. Build the read-only ProseMirror View Bridge — complete

- Implement the adapter registry, projection-only wrappers, stable-ID attributes,
  incremental indexes, unsupported-node placeholders, drift detection, and safe fallback.
- Project NML into ProseMirror without enabling PM-to-NML edits.

**Gate:** every adapter passes AST -> PM -> AST equality and matches the current view.

Implemented in `app/lib/nml/view/` and the opt-in `app/components/editor/nml/` browser
host. Every v1 block/inline adapter preserves semantic content and stable IDs. Wrappers
and numbered-list counters are view-only; unsupported adapters retain entire blocks in
inert placeholders. Cached PM subtrees and relative indexes support minimal replacement
transactions with selection mapping. Canvas scenes stay outside PM, and canvas-only
changes notify domain views without a PM transaction. Current domain renderers are reused
through read-only React portals that retain application context.

Local content transactions are rejected, including forged bridge metadata. Explicit drift
checks compare canonical round trips and indexes, rebuild once, then freeze on repeated
drift. Malformed/newer sources and renderer failures retain canonical content and show
safe-state notices. The bridge neither owns nor writes the caller's authorized Y.Doc.

The gate includes all-adapter/corpus round trips, semantic DOM tests, generated structural
batches, three-client plain-text/structure merges, large-page/index checks, and an isolated
Puppeteer comparison against current BlockNote read-only views. No live editor, provider,
persistence, AI, backend, or MCP path mounts this preview. See the
[bridge implementation notes](nml-prosemirror-view-bridge.md) for the browser command.

**Editing prerequisite closed in step 9:** step 7 removed full-document work from the
supported plain-text hot path. Step 9 replaces the executor's mixed-mark/complex-inline
replacement with range-level Y.XmlText deletion, insertion, mark formatting, and link
formatting, so supported rich edits do not replace an entire inline fragment.

## 7. Add plain-text editing and acknowledgement — complete

- Translate paragraph, heading, and quote edits into character-level NML commands.
- Classify selection-only, content, view-only, and bridge-origin transactions.
- Add optimistic requests, canonical acknowledgements, echo suppression, reconciliation,
  rejection, and rollback.

**Gate:** typing, reconnect, acknowledgement, and remote-caret cases pass without
full-document work, drift, or selection loss.

Implemented as the opt-in `PlainTextNmlBridge`/`NmlPlainTextView`. Unmarked paragraph,
heading, and quote replacements translate to stable-ID `replaceInline` commands and mutate
the owning Y.XmlText ranges at character granularity. Selection/metadata-only and
same-document no-op transactions stay local; structural, rich-inline, list, paste, and
drop changes remain rejected by this compatibility host and are enabled only by the
step-9 full bridge. Optimistic requests carry request/transaction
IDs, acknowledge without echo when canonical text matches, reconcile with minimal PM text
diffs when it differs, and roll back to canonical state on authorization, validation, or
stale-state rejection. Diagnostics contain codes and node IDs only.

The hot path uses a local stable-ID Yjs index, incremental observer snapshots, minimal PM
transactions, and a Fenwick-backed position index. Ordinary text input does not decode,
validate, serialize, project, or scan the whole document; full validation remains the
fallback for structural/complex operations and size-limit failures. The gate covers
10,000-block edits, hundreds of deterministic edits, grapheme rejection, request replay,
async rejection/reconnect races, same-block remote-caret mapping, three offline replicas,
concurrent first inserts, structural fallback, and real Chromium typing on desktop/mobile
with all external traffic intercepted.

This remains isolated from production routes, providers, Convex persistence, AI, backend,
and MCP paths. Steps 8–9 extend the separate host with durable selection/awareness, IME,
structure, paste/drop, marks, links, rich inline content, and domain editing.

## 8. Add selection, awareness, and IME — complete

- Represent durable selections with node IDs and Yjs relative positions.
- Map deleted selections to surviving neighbors and cover node, gap, table, and custom
  domain boundaries.
- Buffer intersecting remote changes during composition; recover text if its node is
  deleted.

**Gate:** supported desktop/mobile composition and remote-edit scenarios pass.

Implemented in the isolated view bridge and browser host. Text selections use stable NML
node IDs plus encoded Yjs relative positions and directional affinity; node, gap,
all-document, table-cell, and custom-domain boundaries use stable node IDs and sides.
Canonical changes resolve the durable selection against the new projection. Deleted
targets choose the closest surviving neighbor from prior document order. Awareness carries
a validated, JSON-safe version of the same NML selection and never broadcasts ProseMirror
integer positions or replaces unrelated user-presence fields. Semantic change observation
compares relative order among surviving siblings, so insert/delete index shifts are not
misreported as moves of the composition target.

Browser `compositionstart`/`compositionend` events open and close a provisional plain-text
composition. Interim PM changes stay local and excluded from history; composition end emits
one authorized canonical command. Non-intersecting remote text and unrelated structural
changes project while preserving provisional text. Intersecting text waits for composition
end and resolves through relative positions. If a collaborator deletes the target block,
only the unfinished local insertion enters a visible copyable recovery panel; diagnostics
retain the node ID and status without text content.

The gate covers CJK, Korean, Indic, dead-key, emoji, and autocorrect input; repeated interim
replacements; boundary/intersecting/non-intersecting remote text; unrelated inserts and
target moves; target deletion and recovery; multiple Y.XmlText runs; selection direction,
deletion fallback, awareness validation, and real Chromium desktop/mobile composition.
The browser run intercepts external traffic and uses no Convex deployment, paid API, keys,
or user data. No production route mounts the host.

## 9. Add structure and rich content — complete

- Implement split/join, lists, indentation, moves, paste/drop, marks, links, inline math,
  references, tables, code, math, media, and remaining custom blocks.
- Use affected-subtree diffing where direct PM-step translation is not proven safe.

**Gate:** every supported PM action passes PM -> commands -> NML -> PM equality, including
concurrent structure.

Implemented as the opt-in `EditableNmlBridge`/`NmlEditableView`, still separate from every
production editor and persistence path. Direct bridge actions cover marked typing, block
split/join, list indentation/outdent, sibling moves, prose/list type conversion, multiline
plain-text paste/drop, five marks, links/unlink, inline math, and page references. Native
ProseMirror changes receive temporary stable identities before a before/after semantic
projection diff compiles only the affected block/domain operations. Canonical receipts map
temporary IDs back without a visible second edit and restore the intended selection.

Rich Y.XmlText edits now operate on character ranges. Marks and link boundaries are Yjs
formatting, including partial links and adjacent equal-URL links, so concurrent text
insertions/deletions are not overwritten by whole-fragment replacement. Durable selection
offsets account for projection-only link wrapper tokens, and rich composition commits one
canonical request while preserving marks, links, and inline atoms.

The semantic vocabulary now includes prose/list and media type changes, row/column table
insert/remove, stable cell edits, and math-row insert/remove. Stable column association plus
deterministic row/column intersection identities keeps tables rectangular when disconnected
replicas concurrently add or remove orthogonal dimensions; an empty derived intersection is
materialized on first edit. CodeMirror emits minimal code ranges, MathLive emits stable-row
commands, media source changes can select audio/video type, and album/storyboard/location
portals emit validated atomic domain replacements. Canvas remains deliberately read-only
until step 10.

The gate covers projection equality after every supported action, native PM ID minting and
copy deduplication, inserted wrappers, partial and adjacent links, inline atoms, rich IME,
rejection rollback/privacy, row/column/table-cell and math-row operations, custom domains,
media conversion, concurrent text/marks/link deletion, split plus concurrent suffix edits,
concurrent moves, and same/orthogonal table-dimension merges. The standalone Chromium run
exercises seven editable workflows on desktop/mobile with all external traffic intercepted,
zero browser errors, and zero paid requests.

## 10. Move canvas onto canonical NML — complete

- Use one atomic PM node whose view subscribes directly to canonical scene maps.
- Route shape/edge gestures through domain commands; keep transient state ephemeral.
- Derive `<nt-diagram>` while retaining/comparing the mirror until every reader migrates.

**Gate:** scene edits require no PM document transaction and preserve AST/Yjs/HTML parity.

Implemented in the opt-in `EditableNmlBridge`/`NmlEditableView`. The canvas remains one
atomic ProseMirror node whose React surface observes its canonical scene `Y.Map` directly.
Committed `SceneOp` results compile to stable-ID canvas metadata, shape, hierarchy, label,
edge, and ordering commands; viewport, tool, hover, selection, caret, and in-flight drag
frames remain local or awareness-only. Canvas focus selects only the PM atom. Authorization
rejection restores the latest canonical scene without applying a PM document transaction.

`<nt-diagram>` is deterministically derived from the canonical scene. The legacy production
mirror remains unchanged until the later reader/cohort migration stages, while three-way
AST/Yjs/HTML tests enforce parity. The gate covers the complete current scene-operation
vocabulary, exact shape/edge order, grapheme-safe collaborative labels, stale-gesture
preservation of unseen fields/shapes/edges, malformed/atomic rollback, and real Chromium
move, label, create/delete, remote-adoption, awareness, and rejection flows on desktop and
mobile. The standalone run now exercises eight workflows with intercepted networking,
zero browser errors, and zero paid requests.

## 11. Establish canonical history, review, and recovery — complete

- Implement origin-aware undo grouping across actors and document/canvas commands.
- Integrate AI hunks, checkpoints, rewind, and recoverable orphan/conflict UI.
- Disable independent PM content history; retain view-only local history.

**Gate:** undo/recovery matrices preserve unrelated concurrent work.

Implemented in `app/lib/nml/view/history.ts`, wired into the opt-in editable bridge/host. The
durable undo unit is a canonical Yjs transaction. `NmlHistory` wraps a `Y.UndoManager` over the
whole canonical `Y.Doc`, gated on the attributed `NmlTransactionOrigin` every command carries:
only the local human's own edits are linearly undoable, so a collaborator's edits (which arrive
through the provider, not as an NML origin) and model/system batches stay *view-only* — which is
exactly what makes undo preserve unrelated concurrent work (the gate). It scopes the doc rather
than the `nml` root, because NML edits mutate deeply-nested shared types whose parents, not the
root, appear in `changedParentTypes`; `captureTransaction` is the precise gate. Typing (the
`plain-text-edit` command) coalesces within the frozen 750ms window; every other command
(splits, moves, marks, paste, canvas gestures, domain edits) and IME (already one committed
transaction) is a discrete step. An undo/redo is itself a new canonical transaction, so it
reconciles into every bridge through the same `observeNmlChanges` path a remote edit uses — undo
propagates to every view and client with no dedicated apply path. ProseMirror's own content
history stays disabled (bridge transactions already carry `addToHistory: false`).

`NmlReviewHistory` gives model/system batches a separate rewind timeline (each batch is one
committed transaction, so one rewind unit). Rewind is a CRDT-level reversal, **not** a semantic
re-issue of inverse commands: it re-adds a batch's exact deleted structs, which is what lets it
*restore content a batch deleted* (the structure layer's deletion tombstones refuse re-inserting
a removed id) while Yjs rebasing keeps an unrelated collaborator's concurrent edits intact.
`nmlCheckpoint`/`checkpointBlock` capture a content-free snapshot for the recovery affordance;
the existing composition-recovery panel remains the copyable orphan surface (CRDT undo/rewind add
no new silent-drop path — an orphaned child recovers at the document root per step 4). The gate
is covered by `app/lib/nml/view/history.test.ts` (grouping windows, view-only model/other-human
edits, undo/redo/rewind as canonical transactions, deleted-content restoration, and the
two-`Y.Doc` concurrent-preservation matrix for both timelines) and a real Chromium workflow in
`tests/nml-view.browser.mjs` (human undo/redo + model rewind each preserving the other, zero
browser errors, zero paid requests). The full AI hunk review — arbitrary non-newest hunk
reject/accept and semantic restore of a snapshot — rides with step 14, where the AI actually
produces NML; step 11 establishes the machinery it plugs into. No production route mounts the
host yet.

## 12. Prepare persistence and cohort migration — complete

- Use the protected schema/migration process for version and migration metadata.
- Build the elected migrator, mixed-version readers, cohort gates, equivalence reports,
  limits, and tested rollback—including NML edits legacy PM cannot represent.

**Gate:** a test cohort migrates, collaborates, reloads, downgrades by policy, and rolls back.

Implemented as the headless engine `app/lib/nml/persistence.ts` plus the Convex surface
`convex/nmlMigration.ts` and two schema tables (`nmlDocState`, `nmlCohorts`). The engine
converts a stored page — BlockNote blocks plus its live canvas maps, both already carried by
the page's Y.Doc — into the canonical NML root and returns the single Yjs update that *adds*
that root beside the existing `prosemirror` root and `canvas:*` maps. Nothing changes which
root the editor reads; the legacy ProseMirror root stays the served truth until step 13. The
NML root rides the same chunked update log, snapshot/compaction, and provider as ordinary
edits — the migration append reuses the extracted `ydoc.appendYUpdate`, so there is no second
sync channel.

Migration is gated: it re-derives structure, IDs, inline semantics, and materialized canvas
scenes from the raw legacy tree (`compareLegacyToNml`), checks per-shape-map vs converted-scene
parity, and enforces the four v1 size limits through `validateDocument`; any failure rejects
and writes nothing. The Convex `electMigration` mutation is the elected writer — first writer
per document wins and a second migrator stands down, so browsers may all preview but never
race a duplicate root — and refuses a root that failed equivalence or limits. Cohort gates
scope eligibility by project (owner-opted) or single document (writer-opted). `nmlState`
exposes the declared schema/encoding versions so a mixed-version reader falls back to
read-only on a newer root rather than downgrade-writing it, and the decoder fails closed on
an unsupported version. Rollback returns authority to legacy and records whether the root had
diverged; because the NML root is permanent (Yjs roots never disappear), a rollback loses no
NML-only edit the legacy tree cannot represent — the downgrade is explicit, never silently
lossy, and `detectNmlDivergence` classifies the case.

The gate is covered by `app/lib/nml/persistence.test.ts` (delta-only root addition, ProseMirror
root byte-stability, idempotent re-migration, block-count and depth limit rejection,
mixed-version read and newer-version read-only, canvas map/scene parity and drift rejection,
and rollback divergence), `convex/nmlMigration.test.ts` under real auth (cohort gate,
owner-vs-guest cohort management, first-writer-wins election, equivalence/limit refusal,
`nmlState` versions, two-editor collaboration then reload with both roots intact, and rollback
metadata), and a standalone Chromium run `tests/nml-migration.browser.mjs` exercising migration,
native-DOMParser canvas parity, real two-Y.Doc collaboration and reload, newer-version
read-only, and rollback divergence with zero browser errors and zero paid requests. No
production route, provider, AI, backend, or MCP path serves the NML root yet.

## 13. Switch progressively to NML authority — server-side verification prerequisite complete

Roll out through synthetic internal, internal real, new, simple existing, structured,
canvas-heavy, then general documents. Gate cohorts on equivalence, telemetry thresholds,
collaboration tests, rollback exercises, and an older-client compatibility window.

- **Before serving any migrated root, verify the migrator's claim server-side — done.** Step 12's
  `electMigration` trusts the elected client's `equivalenceOk`/`limitOk` and the update bytes,
  because the DOM-dependent conversion cannot run inside Convex. Before authority moves to the
  root, the backend now re-asserts it independently. `verifyStoredNmlRoot` (`app/lib/nml/verify.ts`)
  reconstructs the document from the stored `nml` root and re-runs decode + `validateDocument`,
  re-checking schema version, encoding version, and the four v1 limits — all DOM-free. It is split
  out of `persistence.ts` so it imports only the decoder/validator/schema, keeping `linkedom` and
  the BlockNote converter out of the Convex bundle (proven by a real self-hosted push and an
  esbuild dependency check).

  It runs in a **Node action** (`convex/nmlVerify.ts`), not a mutation: reconstructing and
  decoding a document near the v1 size limits costs well over a hundred megabytes of heap, which
  a query/mutation isolate cannot hold — a max-size document OOM'd the isolate during the browser
  e2e. A cheap isolate query (`verifyMaterial`) hands the raw update bytes to the action; the
  action records the verdict through `recordVerification`. `electMigration` schedules it
  automatically, and the new `nmlAuthority` query grants "serve NML" only when a document is
  migrated, in the cohort, server-verified, and at versions this deployment understands; a
  pending or failed check, a rollback, a cohort drop, or a newer root all keep authority with
  legacy. Covered by `verify.test.ts`, new `nmlMigration.test.ts` authority cases (including a
  dishonest over-limit client refused server-side), and a full local-backend browser e2e
  (`tests/nml-authority.browser.mjs`).

- **Remaining:** switch the production editor to mount the NML tree for a verified cohort doc and
  stop writing the legacy root — the progressive per-cohort rollout, which touches the paid AI
  hot paths and is its own gated change.

**Gate:** all supported human edits commit NML commands; NML is the cohort's sole tree.

## 14. Move backend, AI, and MCP consumers

- Generate model NML from the AST; compile partial edits into semantic commands.
- Move readers to the headless core and add an authorized, attributed executor.
- Preserve review, entitlement, logging, confirmation, and paid-API safety boundaries.
- Add MCP only after authentication, scopes, limits, and review policy are approved.

**Gate:** remote commands update open editors without rebuild, echo, or selection loss.

## 15. Retire legacy representations

Remove the ProseMirror-shaped root and live `<nt-diagram>` mirror only after every reader
and document migrates, compatibility/rollback windows close, and bridge telemetry meets
agreed thresholds. Retirement is a separate reversible operational phase.

## Continuous constraints

- Never persist ProseMirror JSON or positions as competing truth.
- Never let adapters or node views mutate Yjs directly.
- Never silently discard invalid, unsupported, or concurrent content.
- Keep typing and canvas hot paths incremental.
- Log metadata/timings, never content or raw Yjs updates.
- Update the agent wiki after every implementation or design change.
- Use static verification by default; paid API calls require explicit per-run approval.
