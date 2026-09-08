# NML / ProseMirror refactor plan

Status: in progress; steps 1–6 complete.

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

## 4. Implement the semantic command executor

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

**Later editing prerequisites:** the existing canonical observer/decoder and snapshot
comparisons still scan whole ASTs; only PM projection and index subtree scans are
incremental. The step-7 typing path must remove upstream full-document work. The existing
executor's mixed-mark/complex-inline path also replaces entire inline fragments and can
overwrite unseen concurrent text. Character-level rich-inline commands must replace that
path before the corresponding collaborative editing gate; the reader cannot repair content
lost upstream.

## 7. Add plain-text editing and acknowledgement

- Translate paragraph, heading, and quote edits into character-level NML commands.
- Classify selection-only, content, view-only, and bridge-origin transactions.
- Add optimistic requests, canonical acknowledgements, echo suppression, reconciliation,
  rejection, and rollback.

**Gate:** typing, reconnect, acknowledgement, and remote-caret cases pass without
full-document work, drift, or selection loss.

## 8. Add selection, awareness, and IME

- Represent durable selections with node IDs and Yjs relative positions.
- Map deleted selections to surviving neighbors and cover node, gap, table, and custom
  domain boundaries.
- Buffer intersecting remote changes during composition; recover text if its node is
  deleted.

**Gate:** supported desktop/mobile composition and remote-edit scenarios pass.

## 9. Add structure and rich content

- Implement split/join, lists, indentation, moves, paste/drop, marks, links, inline math,
  references, tables, code, math, media, and remaining custom blocks.
- Use affected-subtree diffing where direct PM-step translation is not proven safe.

**Gate:** every supported PM action passes PM -> commands -> NML -> PM equality, including
concurrent structure.

## 10. Move canvas onto canonical NML

- Use one atomic PM node whose view subscribes directly to canonical scene maps.
- Route shape/edge gestures through domain commands; keep transient state ephemeral.
- Derive `<nt-diagram>` while retaining/comparing the mirror until every reader migrates.

**Gate:** scene edits require no PM document transaction and preserve AST/Yjs/HTML parity.

## 11. Establish canonical history, review, and recovery

- Implement origin-aware undo grouping across actors and document/canvas commands.
- Integrate AI hunks, checkpoints, rewind, and recoverable orphan/conflict UI.
- Disable independent PM content history; retain view-only local history.

**Gate:** undo/recovery matrices preserve unrelated concurrent work.

## 12. Prepare persistence and cohort migration

- Use the protected schema/migration process for version and migration metadata.
- Build the elected migrator, mixed-version readers, cohort gates, equivalence reports,
  limits, and tested rollback—including NML edits legacy PM cannot represent.

**Gate:** a test cohort migrates, collaborates, reloads, downgrades by policy, and rolls back.

## 13. Switch progressively to NML authority

Roll out through synthetic internal, internal real, new, simple existing, structured,
canvas-heavy, then general documents. Gate cohorts on equivalence, telemetry thresholds,
collaboration tests, rollback exercises, and an older-client compatibility window.

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
