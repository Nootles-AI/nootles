@AGENTS.md

# Nootles — rules for agents

Nootles is an AI-native planning tool that fuses a Notion-style structured document
with a Figma-style canvas. The long-term bet: an ambient LLM reads and edits every part of
the surface through the **same operations a human uses**. Build accordingly — even
pre-AI work must be AI-ready.

## North-star principle

- **One operation vocabulary.** Every mutation (human UI action or future LLM tool call)
  should compile to one typed, validated set of operations against one store. Never build a
  human-only path that the AI couldn't later drive through the same verbs.
- **Editor-first, AI-aware.** The plain editor must be genuinely delightful *before* any AI
  ships, but built with the AI abstractions (operation vocabulary + text projection) in mind
  from day one. Don't bolt AI on later.

## Data model (locked — do not violate)

Bounded, **non-recursive** hierarchy; every node has a stable ID:

```
Project → Page (1:1 with a canvas surface) → Block[text | canvas] → Shape → {rich text, image}
```

- A Block is either a **text block** or a **canvas block**.
- A Shape lives **only** inside a canvas block. It may hold rich text and images, but
  **never** a page or nested blocks. Depth stops at shape → {text, image}. Do not add
  recursion here without an explicit decision.
- Auth is real (Clerk, Google OAuth only) and authorization is centralized in
  `convex/auth.ts` (`ownerId` / `requireOwner` / `readOwned` / `requireOwned`, keyed on the
  Clerk `subject`). Sharing grants roles per project (owner / editor / viewer via share
  links + claims); resolution stays in that one file — never check access anywhere else.

## Product priorities

- **The diagram canvas is the single most important piece.** It must be clean, delightful,
  and best-in-class. Hold it to a higher bar than anything else; polish over shortcuts.
- Light-mode only. Neutral styling — **no blue selection rings / accent colors** on custom
  blocks or canvas. Match Notion/Figma restraint.
- Interactions should feel native (Notion-clean block logic, instant edit-on-insert,
  keyboard copy/cut/paste/delete everywhere).

## Tech stack (locked — don't swap a library without asking)

| Concern | Choice |
|---|---|
| App | Next.js 16 (App Router, heavily customized), React 19, Tailwind 4, light mode |
| Backend / DB | Convex (hosted cloud deployments: dev + prod; see `.env.local` / `.env.prod`) |
| Editor | BlockNote (ProseMirror) + `@convex-dev/prosemirror-sync` |
| Code blocks | CodeMirror 6 (grammars lazy-loaded per language) |
| Math | MathLive (edit) + KaTeX (render) + `@cortex-js/compute-engine` (evaluate) |
| Diagrams | In-house canvas — no library. DOM + SVG renderer, CSS flex/grid auto-layout |

- **Lazy-load heavy libraries** on demand (MathLive, Compute Engine, per-language
  CodeMirror grammars). Don't pull them into the initial bundle.

## Framework: this is NOT stock Next.js

Per `AGENTS.md`: APIs, conventions, and file structure may differ from training data. **Read
the relevant guide in `node_modules/next/dist/docs/` before writing framework code** and heed
deprecation notices. Note `app/` reserves route filenames (e.g. `layout.*`) — name utilities
so they don't collide (that's why the canvas layout helper is `autoLayout.ts`).

## Convex conventions

- Schema tables are owner-scoped with indexes; keep new tables consistent with that.
- `convex/_generated/**` is committed but is codegen — never hand-edit it; it's ESLint-ignored.
- Custom BlockNote block/inline types must not collide with built-in ProseMirror mark names
  (e.g. use `codeBlock`, not `code`, which clashes with the inline code mark).

## React & code patterns

- **No set-state-in-effect for derived values.** Derive from props/query results during
  render (see `Workspace.tsx` effective selection). The only sanctioned effect-set is the
  one-time localStorage layout restore, and it's explicitly commented + lint-scoped.
- **Latest-callback refs must be updated inside an effect**, never during render
  (`react-hooks/refs`). See `MathField`, `CodeMirrorEditor`, `CodeBlock`.
- Keep typing O(1): hold heavy live state locally (CodeMirror text, canvas nodes/edges, math
  rows) and **debounce-persist** it into the store — don't write on every keystroke.

## Persistence pattern

- Documents sync as Yjs CRDTs through Convex (`convex/ydoc.ts` update log + chunked
  snapshots, `app/lib/sync/YConvexProvider.ts`). The legacy prosemirror-sync pipeline
  remains only for docs not yet lazily migrated; its write path freezes per-doc on
  migration.
- A shared diagram's truth is per-shape CRDT maps in the page's Y.Doc
  (`canvas/collab/` — `canvas:<blockId>` → meta/shapes/edges; fractional order keys,
  one-value frames, prev-scene shadow diffs). The `<nt-diagram>` HTML on the block prop
  stays alive as a MIRROR so every HTML reader — thumbnails, `read_page`, copy/paste,
  AI whole-diagram writes — keeps working; external HTML writes diff INTO the maps, so
  even the AI's whole-diagram edits merge per shape.
- Math persists as LaTeX source in a node attribute (debounced), whole-value LWW.
- The canvas HTML round-trip is exact: `serialize(parse(html)) === html`, and
  `materialize(populate(parse(html)))` equals `parse(html)` — both are contracts the AI
  layer edits diagrams through. Keep them that way.

## Working style

- **Elegance and fundamentals over speed.** Clean, minimal, no sloppy or half-finished
  implementations, no speculative abstractions. Match the existing quality bar.
- Verify UI changes in-browser before claiming done; if you can't test it, say so.
- The user often edits in their own synced browser tab — unexpected content changes on a
  page may be them, not a bug. Check before "fixing."
- Keep comments scarce: only explain non-obvious *why*, never narrate *what*.

## Quality gates

Before declaring work done: `tsc --noEmit` clean and ESLint clean. Both are currently green —
keep them that way.

## Roadmap pointer

Phase 0 (foundations) and Phase 1 (delightful editor) are done. Next is **Phase 2 — the AI
substrate**: operation vocabulary + validator/applier, doc→text projection with stable IDs,
context spine (op-log + context sheet + agent threads), suggestion overlay + per-prompt
checkpoints. Then the 6 AI modes, starting with tab completion. Build the apply-pipeline
(preview → per-hunk accept/reject → checkpoint) once so every AI mode inherits it.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
