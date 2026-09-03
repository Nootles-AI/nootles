# NML / ProseMirror refactor plan

Status: planned; not implemented.

ProseMirror remains the browser editing engine. Canonical ownership moves from a
ProseMirror-shaped Yjs root to a typed, versioned NML AST stored directly in Yjs. Existing
Convex snapshot/update persistence stays initially.

## 1. Freeze foundational decisions — complete

The binding v1 choices are in
[`nml-foundational-decisions.md`](nml-foundational-decisions.md). Reopening one requires an
explicit architecture decision covering migration and compatibility.

## 2. Build the headless NML core

- Implement versioned AST types, runtime schemas, stable IDs, normalization, validation,
  repair, strict serialization, parsing modes, diagnostics, and pure migrations.
- Import custom-domain schemas from their owners rather than duplicating them.
- Add golden fixtures, parser/serializer properties, fuzzing, and Browser/Node parity.

**Gate:** canonical text round-trips preserve semantic equality, IDs, and domain content.

## 3. Define the canonical Yjs encoding

- Add `Y.Map("nml")`, collaborative inline text, addressable tables, `Y.Text` code/math,
  structured domains, canvas scene maps, origins, and semantic change-set observation.
- Restrict canonical shared-type mutation to the NML executor.
- Test AST/Yjs equality, chunking, cross-runtime parity, and multi-client merging.

**Gate:** browser and Node decode the same AST from the same Y.Doc.

## 4. Implement the semantic command executor

- Cover structure, props, inline content, tables, code, math, shapes, and edges.
- Support atomic batch validation, temporary IDs, preconditions, idempotency, typed
  conflicts, authorization, and attributed transactions.
- Converge AI operations, slash commands, imports, and future MCP edits on this vocabulary.

**Gate:** fuzzed command sequences and concurrency matrices preserve every invariant.

## 5. Add legacy conversion and shadow NML

- Convert current BlockNote/ProseMirror documents and canvas map/HTML pairs into NML.
- Keep serving legacy truth while maintaining a non-serving shadow NML document.
- Compare structure, IDs, inline semantics, and fully materialized canvas scenes.
- Capture compatibility fixtures from representative stored documents.

**Gate:** the agreed corpus sustains semantic parity and every mismatch class
is understood.

## 6. Build the read-only ProseMirror View Bridge

- Implement the adapter registry, projection-only wrappers, stable-ID attributes,
  incremental indexes, unsupported-node placeholders, drift detection, and safe fallback.
- Project NML into ProseMirror without enabling PM-to-NML edits.

**Gate:** every adapter passes AST -> PM -> AST equality and matches the current view.

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
