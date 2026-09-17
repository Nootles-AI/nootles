# Phase 2.5 — FULL PARITY on served docs: implementation handoff

**Status:** IN PROGRESS. Substrate piece **B1 (model read projection) is complete and verified**; the
rest is planned and broken into tasks below. This doc is self-contained — you do not need the wiki to
continue — but the authoritative narrative plan lives at
`agent-wiki/architecture/nml-internal-mcp-plan.md` → *Phase 2.5* (note: `agent-wiki` is **not** a git
repo; it is plain files in the workspace).

Branch: `nml-phase-2.5-full-parity`.

---

## The mandate

When a document is *served* (`nmlAuthority.serve === true`), `NmlServedEditor` mounts the NML ProseMirror
view bridge instead of the legacy BlockNote editor. The bar for this phase is **total parity**: on a
served doc, **nothing a user, a collaborator, or a reader can observe may differ from the legacy path** —
same chrome, triggers, outputs, rendering, presence, review/undo, and latency — with **zero net-new paid
API calls**. Anything observable is a defect, not a follow-up.

This is step 14 of `nml-prosemirror-refactor-plan.md` ("move backend, AI, and MCP consumers"), executed
for the internal cohort, widened to every surface (not just AI) and — per an explicit operator decision
(2026-09-17: "everything, incl. multi-client") — including cross-client presence and the
NML→ProseMirror live mirror that the plan previously deferred as external-grade.

## Hard constraints (read before writing code)

- **Paid-API rule (see `CLAUDE.md`, overriding).** Do not cause a live call to any paid model endpoint
  (anything under `app/lib/ai/**` or the `app/api/**` wrappers) without explicit, per-run operator
  approval in the conversation. You may **write** the AI lanes and verify them statically (tsc / lint /
  unit); **live** verification of completion/reformat/chat/draw needs approval. Say so and stop at the
  approved count.
- **Quality bar.** No half-finished slices. `tsc --noEmit` and ESLint must stay green. Verify UI changes
  in-browser before claiming done.
- **Node 22 is required for the toolchain** (see Verification below). Node 20 fails to even boot vitest.

## What the audit actually found (verified, with corrections)

A four-track code audit of `NmlServedEditor` vs. legacy produced the gap list. **Two audit claims were
wrong on inspection — do not act on them:**

- ❌ "All custom domain blocks are read-only on served docs." **False.** `ReadOnlyDomainContent.tsx`
  wires fully editable `EditableCode`, `EditableMath`, `EditableCanvas`, and album/storyboard/location/
  video/audio surfaces through the editable bridge. Code text, math, canvas gestures, and those domains
  **are editable**.
- ❌ "Uploaded media renders 'unavailable' — a live regression." **Not live for migrated docs.** Legacy
  `MediaBlock` stores only `url`; `legacy.ts` (`:225–233`) emits only `{ kind: "url" }`, so migration
  never produces `storage`-kind media. The `resolveStorageUrl` resolver is genuinely unwired in
  `NmlServedEditor`, but has no trigger for a migrated doc — thread it for forward-compat, low priority.

**Confirmed-live single-user gaps** (you'd see these solo on a served doc): no slash / `@` / side menus,
no formatting toolbar, no markdown input rules, no empty-block hints; inline math + page mentions are
read-only (page-mention click doesn't navigate); image + code-language editing missing; paste/drop is
plain-text only; thumbnails / `read_page` / AI projection read the migration-frozen legacy root; AI is
entirely absent.

**Multi-client gaps** (bite at wave 2 / a second legacy client): remote cursors break across NML↔legacy;
legacy clients see the frozen `prosemirror` root; rollback reverts visible content to the migration
snapshot.

**Confirmed NOT to differ** (regression-pin only, don't rebuild): code/math/canvas/album/storyboard/
location/video/audio editing, tables, lists, toggles, dividers, split/join/indent/move, keyboard marks,
links, durable selection, IME.

## Task breakdown (the plan of record)

| # | Track | Piece | Paid-API to *test*? | Notes |
|---|---|---|---|---|
| B1 | Substrate | **Model read projection** | No | **DONE — see below** |
| D1 | Substrate | NML applier + `CanvasHost` over served scene | No | Compile `convex/ai/operations.ts` → `executeNmlCommands`; implement `CanvasHost` (`app/lib/ai/canvas/host.ts`) so the 13 canvas planners port unchanged. Pairs with B1; both reused by AI + MCP. **Do next.** |
| B2/B3 | Consumers | NML→HTML serialization + route non-editor readers | No | Route `PagePreview`/`ThumbDiagram`, `read_page` (`clientTools.storedBlocks`), `projection.ts`, `html/serialize.ts`, `albumRead`, `chatHost` through the NML projection, gated on `nmlAuthority.serve`. Blocked by B1 (now unblocked). |
| A2 | Editor | Inline atoms — math + page-mention edit/navigation | No | `browser.ts` `nodeViews.math`/`pageRef` are `contentEditable=false`, no handlers. Needs step-9 inline temp-ID minting. Page-mention click-to-open is the small first slice. |
| A3/A4 | Editor | Image+code editing, rich paste/drop, storage-URL | No | Image source/caption + code language selector as NML commands; rich HTML/file/block paste+drop (`browser.ts` reads only `text/plain`); thread `resolveStorageUrl` (low priority, not a live bug). |
| A5 | Editor | Markdown input rules | No | None exist in `app/lib/nml/view/`. Add PM input rules → NML type/insert commands. Rule→command mapping is unit-testable. |
| A6 | Editor | Chrome: slash/`@` menu, side menu, toolbar, hints | No | Rebuild the BlockNote UI on the bridge; every action → NML command. Largest editor slice. Browser-verified. |
| D2–D6 | AI | AI lanes on NML | **Yes (live)** | completion/reformat on `NmlEditableView`; chat + review overlay on `NmlReviewHistory`; draw + 13 canvas AI tools via `CanvasHost`; categorize + feedback-complete; context spine. Re-establish entitlement/log/paid-API boundaries. Blocked by B1+D1. |
| C1 | Multi-client | Bidirectional awareness-selection translator | No | Translate `NmlAwarenessSelection` (`selection.ts`) ↔ legacy PM-position awareness (`remoteCarets.ts`). Pure translation is unit-testable. |
| C2 | Multi-client | NML→ProseMirror live mirror | No | **Largest piece.** Two-way CRDT bridge so legacy/stale clients read AND write a served doc. Plus queue-draining on `nmlAuthority` flip + rollback snapshot handling. |
| C4 | Multi-client | Verify comments feature; migrate if present | No | Audit *inferred* comments exist — **unverified**. If real, add an NML mark + migration; if not, strike from plan. |
| Z | Gate | Full-parity verification harness | mixed | Surface-by-surface: unit/golden + `next dev` e2e per lane and per chrome affordance + two-client NML↔legacy presence + mirror-convergence test. |

Suggested order: **D1 → B2/B3 → C1 → A5 → A2 → A3/A4 → A6 → D2–D6 (approval) → C2 → C4 → Z.** (Substrate
and pure/unit-testable pieces first; the mirror C2 and AI live-tests last.)

---

## DONE: B1 — model read projection

**Files:**
- `app/lib/nml/model/projection.ts` — `projectNmlDocument(doc, opts)` and the `nmlToAnyBlocks` /
  `nmlBlockToAnyBlock` adapters.
- `app/lib/nml/model/projection.test.ts` — fixture parity test.

**Approach (parity by construction, not a fork):** an NML AST node carries exactly the facts
`app/lib/ai/projection.ts` reads off a BlockNote block, so the adapter maps the AST into the same
denormalized `AnyBlock` shape and hands it to the **one canonical `project()`**. This guarantees the
served read is byte-identical to the legacy read (every ⟦id⟧ tag, every line, the reverse `DocIndex`),
and it is the projection-relevant inverse of `legacy.ts`. It reuses the existing domain serializers
(`serializeScene`/`serializeAlbum`/`serializeStoryboard`/`serializeLocation`) so canvas/album/storyboard/
location read back through the same parsers the legacy projection uses.

**Consumed by:** the AI read lanes (Track D) and the stale non-editor consumers (B2/B3) — one projection,
both consume. When MCP lands, this is Phase 3's `read_doc`.

**Verified:** `projection.test.ts` asserts `projectNmlDocument(convert(fixture))` equals
`project(fixture.blocks)` (text + `DocIndex`) for every fixture in `__fixtures__/legacy/`: rich-text,
table, code-math, media, canvas-html, canvas-legacy-json, domains. `tsc --noEmit` clean, ESLint clean.

**Two inherent parity limits — documented in the module, NOT bugs to "fix" in the projection:**
1. `notionStub` has no NML v1 representation (the converter omits it as an unsupported block), so a
   migrated doc has no stub to project. `edge-cases.json` (the only stub fixture) is held out of strict
   parity. Carrying stubs through would need NML schema support — out of scope for a pure projection.
2. `project()` emits no table-cell text on *either* path, so a table projects as a bare id tag on both.
   Improving table projection is a separate enhancement (would change legacy output too).

---

## Verification recipe (do not skip — Node 20 will waste your time)

```sh
# Node 22 is required; v20 cannot boot vitest ("styleText" not exported from node:util).
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"   # any v22 works
node -v   # expect v22.x

# Unit tests (vitest runs in edge-runtime — NO DOM). Tests that touch canvas/album/
# storyboard/location markup must set a DOMParser global from linkedom; see
# app/lib/nml/model/projection.test.ts for the one-liner.
npx vitest run app/lib/nml/model/projection.test.ts

# Quality gates (project-wide):
npx tsc --noEmit
npx eslint app/lib/nml/model/projection.ts app/lib/nml/model/projection.test.ts
```

Gotchas already hit and handled:
- **Node 20 → toolchain crash.** Use v22.
- **edge-runtime has no `DOMParser`.** Inject linkedom's in the test (top-of-file global assign). The
  domain *parsers* also accept an injectable `parseHtml`, but `projection.ts` uses the global.
- **zsh has no `PIPESTATUS`** — don't rely on it to read a piped command's exit; grep the output instead.
- Browser/e2e harnesses (for the editor-UI tracks A*, C1/C2) need Node 22 + Puppeteer + a throwaway
  local `convex-local-backend`; see the memory notes and existing `tests/*.browser.mjs`.
