# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user today is the builder, using Nootles for their own planning. A broader
audience is deliberately undecided until the AI substrate proves itself — do not design
for a hypothetical team or market segment.

## Product Purpose

Nootles is an AI-native planning tool that fuses a Notion-style structured document with a
Figma-style canvas on one surface. The core job is general-purpose thinking: any project or
idea where mixing structured notes with freeform diagrams helps — not domain-specific.
Success means it becomes the owner's daily-driver, replacing Notion/Figma for their own
planning; quality for one user is the bar.

## Positioning

One operation vocabulary: every mutation — human UI action or LLM tool call — compiles to
the same typed, validated operations against one store. The ambient LLM reads and edits
every part of the surface through the same verbs a human uses, so there is never a
human-only path the AI can't drive. The canvas round-trip is exact
(`serialize(parse(html)) === html`) and is the contract the AI layer edits diagrams through.

## Operating Context

- Single-user v0; owner scoping centralized in `convex/auth.ts` so real auth stays a
  one-file swap. Clerk sign-in and share routes already exist in the app.
- The owner often has the same page open in multiple synced browser tabs; unexpected
  content changes may be their own edits.
- Documents mix rich text blocks, code blocks (CodeMirror), math (MathLive/KaTeX), and
  in-house canvas blocks with shapes and edges.

## Capabilities and Constraints

- Data model is locked and non-recursive: Project → Page (1:1 canvas surface) →
  Block[text | canvas] → Shape → {rich text, image}. Shapes never contain pages or blocks.
- Tech stack is locked (Next.js 16 App Router, React 19, Tailwind 4, Convex, BlockNote,
  CodeMirror 6, MathLive/KaTeX, in-house canvas). Don't swap a library without asking.
- Heavy libraries lazy-load on demand; typing stays O(1) via local state +
  debounce-persist.
- Canvas and math persist as text in ProseMirror node attributes for v0; migration to
  dedicated Convex tables is flagged, not assumed.
- Undecided: audience beyond the owner, and multiplayer. Record decisions when made rather
  than designing for them speculatively.

## Brand Commitments

- Name: **Nootles**.
- Light-mode only. Neutral styling — no blue selection rings or accent colors on custom
  blocks or canvas. Match Notion/Figma restraint.
- Interactions feel native: Notion-clean block logic, instant edit-on-insert, keyboard
  copy/cut/paste/delete everywhere.
- The diagram canvas is the single most important piece — clean, delightful,
  best-in-class, held to a higher bar than anything else.

## Evidence on Hand

A working product: editor, canvas, sharing, welcome flow, and an in-progress AI chat panel
in `app/`. No marketing site, testimonials, case studies, or usage metrics exist — future
work must not fabricate any.

## Product Principles

1. **One operation vocabulary.** Never build a human-only path; every feature must be
   drivable by the future ambient LLM through the same operations.
2. **Editor-first, AI-aware.** The plain editor must be genuinely delightful before any AI
   ships, but built on the AI abstractions from day one.
3. **The canvas is the flagship.** Polish over shortcuts; hold it above everything else.
4. **Quality for one user is the bar.** Daily-driver depth beats feature breadth; no
   speculative multiplayer or market features.
5. **Domain-neutral by design.** Serve general-purpose thinking; don't specialize the
   surface toward one planning domain.
