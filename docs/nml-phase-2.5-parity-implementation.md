# Phase 2.5 — full parity on served documents

**Status:** implemented and verified locally on `nml-phase-2.5-full-parity` (2026-09-17).
The structural NML parity gates pass. The repeated chat mutation found by the separately approved
live-provider smoke is now suppressed at the client execution boundary; the Recraft lane remains
blocked by account credit. Production deployment and serve-wave expansion are separate operator
actions.

The phase is complete by making the mature editor the served editor instead of rebuilding a
second product surface. When `nmlAuthority.serve` is true, `Editor.tsx` mounts the same BlockNote
schema, extensions, `EditorSurface`, chrome, AI/review integration, awareness, and role handling as
the normal Yjs path. `useNmlLegacyMirror` makes its `prosemirror` fragment a live compatibility view
over canonical NML.

This choice gives the served path parity by construction:

- slash and `@` menus, block side menu and drag/reorder, formatting toolbar, links, hints, markdown
  rules, rich paste/drop, inline math/page references, code/image/media controls, all custom blocks,
  IME, selection, keyboard behavior, and read-only roles are the existing production implementation;
- completion, reformat, chat edits, review/accept/reject, checkpoints, undo, entitlements, logging,
  and request boundaries are the same hooks and extensions, rather than a parallel NML rewrite;
- every client uses y-prosemirror awareness positions, so remote selections and cursors require no
  cross-format translator;
- the canonical `nml` root remains authoritative. BlockNote is a derived view, not a second source of
  truth.

The implementation was first verified without providers. A later, explicitly approved and bounded
live-provider smoke is recorded under [Verification](#verification); it made no production writes.

## Canonical compatibility mirror

`app/lib/nml/mirror.ts`, `mirrorBlockNote.ts`, and `useNmlLegacyMirror.ts` provide the live bridge.

- On mount, canonical NML is projected into the BlockNote fragment before the editor is shown.
- BlockNote transactions are converted back to NML and compiled into semantic commands. They land as
  one authorized, attributed canonical batch; transactions made inside an AI apply boundary retain
  `actor.kind: "model"`.
- Canonical human/model/system commands immediately reproject into the open BlockNote editor and into
  stale clients bound to `prosemirror`.
- Hidden NML identities for inline atoms, table rows/columns/cells, and math rows survive round trips.
- Storage-backed media resolves through Convex while retaining its canonical storage identity.
- Mirror-origin transactions are ignored, preventing feedback loops. Queued writes drain after an
  authority flip/unmount, and the continuously current compatibility root makes rollback show the
  latest content instead of the migration snapshot.
- Canvas block props and the existing per-shape canvas maps continue to use their mature collaboration
  adapter. Canonical scene projection and legacy canvas adoption remain deterministic.

The previous native `NmlServedEditor` remains as a low-level bridge/debug surface and retains its own
editing tests, but it is no longer the production parity mount.

## MCP/AI substrate delivered by this phase

The parity surface does not depend on these adapters, but MCP phases 3–4 can use them directly without
touching BlockNote:

- `app/lib/nml/model/projection.ts`: canonical NML to the existing model `project()` grammar, including
  table content, domains, canvas scenes, media, and Notion stubs.
- `app/lib/nml/model/html.ts`: NML-derived Nootles HTML through the canonical legacy serializer, with
  storage URL resolution.
- `app/lib/nml/model/apply.ts`: the complete `convex/ai/operations.ts` vocabulary compiled to semantic
  NML commands, including stable temporary IDs, tables, math, media, special domains, and canvas
  scene diffs.
- `app/lib/nml/model/canvasHost.ts`: a `CanvasHost` over canonical scenes, so all 13 existing diagram
  planners can run unchanged.

Authority-aware readers now prefer NML in `PagePreview`, `clientTools.storedBlocks`, and AI snapshots.
The live mirror also keeps compatibility readers that still consume BlockNote/HTML current.

NML v1 now carries `notionStub` as a real typed block (`notionType`, `notionId`, `href`, `raw`) through
legacy conversion, parse/serialize, Yjs, model projection, HTML, the applier, and both view paths. The
earlier “unsupported stub” exception is closed.

The comments/annotations audit found no document-comment product feature to migrate. “Threads” in this
repository are AI chat threads; BlockNote exposes dependency-level comment APIs, but the app neither
configures nor persists them.

## Native bridge improvements retained

Although production parity uses the compatibility surface, the native bridge was also completed for
the concrete gaps found during the audit:

- headings, quote, bullet, numbered, checkbox, and fenced-code markdown shortcuts;
- inline-to-inline block type changes preserve rich marks, links, and atoms;
- inline/code translation in both directions;
- storage-backed media resolution and Notion-stub rendering.

## Verification

The phase is covered at four levels:

1. Unit/golden tests cover operation compilation, `CanvasHost`, model projection, NML-derived HTML,
   every markdown shortcut, rich inline preservation, Notion stubs, storage media, mirror convergence,
   stable hidden IDs, attribution, queue drain, and direct canonical/legacy interleavings.
2. `tests/nml-parity-mirror.browser.mjs` uses a real BlockNote editor and Y.XmlFragment to exercise
   typing → NML, markdown, inline atoms, code/image properties, rich HTML paste, and direct canonical
   commands → the live surface.
3. `tests/nml-served-editor.browser.mjs` mounts the real `Editor` against a throwaway local Convex
   backend. It observes legacy first mount, client migration, server verification, reactive authority
   flip, the full served BlockNote surface, a second client, and a typed edit persisted in canonical
   NML. All AI routes are intercepted; the normal completion attempt is stubbed with an empty stream.
4. `tests/nml-ai-live-provider.mjs` is an explicit-opt-in provider smoke (`NML_ALLOW_PAID_AI=1`) with
   a cumulative fetch ceiling and resumable ledger. It feeds the same generated operation through the
   legacy and NML canvas hosts, applies document edits to canonical NML with model attribution, and
   retains sanitized artifacts. `tests/nml-ai-live-visual.browser.mjs` then mounts the saved canvases
   in the real renderer with all non-origin network disabled.

### Bounded live-provider result (2026-09-17)

The approved ceiling was ten provider HTTP attempts: at most one Mistral, eight OpenRouter (including
tool-loop steps/retries), and one Recraft. The run used synthetic text and a locally generated two-tile
contact sheet, touched no production system, and consumed exactly that envelope: Mistral 1,
OpenRouter 8, Recraft 1.

- **Completion passed:** Codestral streamed `release manager approval`; the exact bytes were applied
  to canonical NML and the transaction retained `actor.kind: "model"`.
- **Reformat passed:** Gemini returned a table and bullet-list candidate; the table compiled through
  the unchanged HTML operation compiler and changed the canonical paragraph to a table.
- **Diagram passed:** Muse produced a canonical two-node Draft → Approved scene with one labelled
  edge. Parse/serialize round-trip, NML insertion, real-Chromium paint, labels, and connector passed.
- **Chat document/canvas application passed:** with the production system prompt and tool schemas,
  Muse called `read_open_page`, `edit_page`, `set_text`, and `move`. The document edit compiled into
  NML; the canvas calls produced byte-identical legacy-host and NML-host scenes; model attribution,
  label, and +20/+10 geometry passed. The provider then emitted an additional `move` call instead of
  settling. This happens above the unchanged legacy/NML appliers, so it is not evidence of refactor
  divergence. A follow-up guard in `chat/toolReplay.ts` now recognizes an exact completed mutation
  in the current user turn from the persisted transcript and returns a no-change result before the
  duplicate reaches `runClientTool`. Reads, different arguments, later user turns, failed calls, and
  `edit_page`'s explicit same-content transient retry remain allowed. This deterministic fix is unit-
  and browser-regression-tested; the paid provider was not called again.
- **Album indexing passed:** Gemini returned both required handles with bounded non-empty alt text;
  the descriptions matched the two visible synthetic tiles.
- **Vector generation was not exercised end to end:** the single Recraft request returned
  `400 not_enough_credits` before an SVG existed. The SVG importer/canonical path remains covered by
  offline tests, but the live vector lane is not certified by this run.

No second Recraft attempt or provider call beyond the approved cumulative ceiling was made.

The existing real-Chromium native-view and BlockNote markdown suites remain green. Final branch results:
109 Vitest files / 1,481 tests passed (one intentional file/test skip), `tsc --noEmit` clean, ESLint
zero errors (six pre-existing warnings), webpack production build successful, and `git diff --check`
clean. A default Turbopack build attempt held its lock without output or source/network activity for
more than four minutes and was interrupted; it is inconclusive, not counted as a successful gate.
