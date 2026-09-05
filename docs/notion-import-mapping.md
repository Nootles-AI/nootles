# Notion → Nootles import: the translation map

Status: proposed; no implementation yet. Direction is **one-way, Notion → Nootles only**
(see [Why one-way](#why-one-way-and-what-actually-answers-the-adoption-risk)).

The target of this import is the **canonical NML AST**
([`nml-canonical-ast.md`](nml-canonical-ast.md), `app/lib/nml/`), not BlockNote. NML is
already the vocabulary the AI layer reads and writes, its parser already has an `import`
mode with structured diagnostics, and every editor surface will be projected from it. An
importer that targets BlockNote would have to be written twice.

Everything below is measured against NML schema v1 as it stands on
`aryansingh/nt-8-nml-refactor`, not against what Notion looks like.

## The three NML facts that decide most of this map

1. **Only list items nest.** `leafBase` in `app/lib/nml/schema.ts:112` pins
   `children: []` on paragraph, heading, quote, code, math, divider, media and every
   domain block. The four list-item types are the *only* blocks with real children. So
   Notion's "any block can have children" flattens on arrival, everywhere except lists.
2. **There are five marks and no colour.** `NML_MARKS = code, bold, italic, strike,
   underline`. Notion's ten text colours and ten backgrounds have no representation, and
   shouldn't — light-mode-only, neutral styling is a locked product decision in
   `CLAUDE.md`.
3. **A link may only contain text.** `content: z.array(textSchema)` at
   `app/lib/nml/schema.ts:41`. Notion permits an equation inside a link; NML does not.

Also binding: `maxBlockDepth: 4`, `maxBlocks: 10_000`, `maxInlineUtf16: 1_000_000`.

## Direct translations

Lossless in both directions. These are the bulk of any real Notion page.

| Notion | NML | Note |
|---|---|---|
| `paragraph` | `paragraph` | |
| `heading_1/2/3` | `heading` level 1/2/3 | Levels 4–6 exist in NML and are simply unused by Notion |
| `bulleted_list_item` | `bulletListItem` | children carry over |
| `numbered_list_item` | `numberedListItem` | children carry over |
| `to_do` | `checkListItem` | `props.checked` from `to_do.checked` |
| `toggle` | `toggleListItem` | children carry over |
| `quote` | `quote` | text only — see below |
| `divider` | `divider` | |
| `equation` (block) | `mathBlock` | one `rows` entry; NML's multi-row block is a superset |
| `code` | `codeBlock` | content exact; `language` needs a map, below |
| `image` / `video` / `audio` | `image` / `video` / `audio` | file bytes must be rehosted, below |
| `pdf` / `file` | `file` | |
| `table` + `table_row` | `table` | cells are rich text on both sides |
| annotations `bold` `italic` `strikethrough` `underline` `code` | marks `bold` `italic` `strike` `underline` `code` | exact 1:1, all five |
| rich text `text.link.url` | `link` | |
| rich text `equation` | inline `math` | |
| `child_page` | a Nootles `page` | plus `pageRef` wherever it was linked |

## Semi-translations

The content survives; something around it does not. Each row is a decision, and each one
should raise a diagnostic on the import report rather than happening quietly.

| Notion | NML | What is lost |
|---|---|---|
| `callout` | `quote` + icon emoji prefixed to the text | Background colour, icon as an icon. **Children flatten to following siblings** — quote is a leaf |
| `quote` with children | `quote` + flattened siblings | The nesting relationship |
| toggleable `heading_1/2/3` | `heading` + flattened siblings | The collapse, and the parent/child relation — heading is a leaf |
| `column_list` / `column` | blocks emitted in column order | The side-by-side layout entirely. NML has no columns |
| `synced_block` (original) | its content, inlined once | The sync. Duplicates elsewhere become a `link` to the page holding the original |
| `bookmark` / `link_preview` / `embed` | `paragraph` containing a `link` | The rendered preview card |
| `table` with `has_row_header` | `table` with `props.headerRows` only | First-column-as-header. NML models header *rows*, not columns |
| `table_of_contents` | dropped, or a static heading list | Live updating. Recommend dropping — it is navigation, not content |
| `breadcrumb` | dropped | Nothing of value; it is derived navigation |
| `child_database` (inline) | `table` of the row properties | Views, filters, sorts, formulas, relations, rollups. Big — see below |
| database page properties | dropped, or a `table` at page top | Typed property semantics |
| `mention` → user | plain text of the name | Identity |
| `mention` → date | plain text of the date | Date semantics |
| `mention` → page | `pageRef` if that page is in the import set, else `link` to notion.so | |
| `mention` → database | `link` | |
| text colour / background | dropped | Colour. Deliberate — see fact 2 |
| image/file `caption` | `props.caption` string | Caption is rich text in Notion, a plain `string` in NML — bold and links inside a caption flatten |
| page `icon` | `pages.icon` (`rowIcon`: emoji or image) | Nothing, for emoji and uploaded icons |
| page `cover` | dropped, or a leading `image` block | The cover as a cover |
| link containing an equation | link split around the equation | The equation stays; it just leaves the link |
| nesting deeper than 4 | flattened at depth 4 | `NML_LIMITS.maxBlockDepth` |

### Code languages

Notion offers ~80 language names; Nootles lazy-loads CodeMirror 6 grammars per language.
The importer needs an explicit `notionLanguage → nootlesGrammar` table with an honest
`plaintext` fallback, not a pass-through — an unmapped name would produce a code block
that never highlights and never says why.

One special case worth naming: Notion renders `mermaid` code blocks as diagrams. Today
those should land as `codeBlock` with `language: "mermaid"`, faithfully. But this is the
single highest-value future enrichment in this whole document — the diagram canvas is the
product's crown jewel, and a Notion user's mermaid blocks are exactly the content that
would land best there. Deliberately out of scope for v1; it is a converter with real
failure modes, and a wrong diagram is worse than a right code block.

### Databases

The honest position: a Notion database is not a Nootles anything. A simple one (rows,
scalar properties, one table view) converts to an NML `table` well enough to be useful. A
database with relations, rollups, formulas or multiple views does not convert at all, and
pretending otherwise produces a table that looks right and is wrong.

Recommendation for v1: convert simple databases to a table, and stub the rest (below)
with a link to the Notion original. Do not build a database model.

## Non-translations, and the fallback

Notion's block set is open — integrations, embeds and new first-party block types arrive
without warning, and the API answers with `type: "unsupported"` or a type string we have
never seen. This set can never be enumerated, so the *fallback* is the actual feature
here, not the mapping table.

What has no NML representation at all: `template`, `unsupported`, buttons, AI blocks,
comments and discussions, permissions, backlinks, and every block type Notion ships after
this document is written.

The good news is that the unbounded part is smaller than it looks: Notion normalises most
third-party surfaces (Figma, Miro, Loom, Google Drive, tweets) into `embed` or
`link_preview` **carrying a URL**, which the semi-translation table already handles as a
paragraph with a link. What is left is genuinely unknown types.

### Four rules for the fallback

1. **Nothing disappears silently.** The NML parser's existing `quarantine` is the wrong
   default here: it lifts markup *out* of the document and reports `severity: "error"`
   (`app/lib/nml/parse.ts:76`). That is correct for a canonical document that must not
   admit garbage, and wrong for an import, where the user's content leaving the page
   without a trace is the worst outcome available.
2. **The stub is built from blocks that already exist.** A `quote` whose content is the
   block-type name plus a `link` to the Notion original. No NML schema change, so this
   does not block on v1 being locked, and it renders as a visible, clickable placeholder
   rather than a hole.
3. **Fidelity is kept outside the document.** An import ledger stores the raw Notion JSON
   for every stubbed and every degraded block, keyed by the NML block id it became.
   `app/lib/nml/migrate.ts` already exists as a pure migration registry: when NML v2 adds
   a real embed block, the stubs upgrade in place from the ledger — without re-fetching
   from Notion, whose token may be long gone by then.
4. **Every import ends with a fidelity report.** Blocks imported, perfect, degraded,
   stubbed, each degraded class named and linked. This is what makes a lossy import feel
   trustworthy instead of suspicious.

**Worth raising with the NML owner:** Notion import is the strongest argument for an
`embed` / `unsupported` block type in NML v2. The set of things a document must be able to
hold *without understanding them* is unbounded by nature, and rule 2 is a workaround for
its absence, not a design. Not a blocker — the ledger means we can decide later without
losing anything.

## Structure: Notion's tree onto Project → Page

Nootles is deliberately non-recursive: `Project → Page`, with nestable `folders` for
sidebar organisation (`convex/schema.ts:279`). Notion nests pages arbitrarily deep, and a
Notion page is both a document and a container at once — that is the real structural
mismatch, not block types.

Proposal:

- A Notion page **without children** → one Nootles page.
- A Notion page **with children** → a folder named after it, containing a page of the same
  name holding its own content, with its children as siblings inside that folder. This is
  the only shape that keeps both the content and the tree.
- Depth beyond what folders comfortably carry flattens, with the parent's title prefixed.
- **Two passes.** Create every page first so ids exist, then resolve cross-page links into
  `pageRef`. Links to pages outside the selected set stay external links to notion.so.

The import wizard: connect, pick a target (new project, or an existing project and
folder), see the granted page tree, check a set, import. Page-import-within-a-project is
the same flow with the target pre-filled — worth building as one path, not two.

## Two things that will bite the implementation

**Notion file URLs expire in one hour.** `image`, `video`, `audio`, `file` and `pdf`
blocks return a signed `file.url` with a short TTL. Storing it as
`props.source = {kind: "url"}` produces an import where every picture is broken by lunch.
Files must be downloaded and re-uploaded to Convex storage during the import, landing as
`{kind: "storage", storageId}`. This is most of the import's wall-clock time and all of
its storage cost.

**The Notion API is paginated and rate-limited.** Block children come 100 at a time,
`has_children` forces a recursive walk, and the limit is roughly three requests a second.
A large page tree takes minutes. The import must be a background job (Convex action +
scheduler) with resumable progress, not a request. It touches no AI lane and spends no
model tokens — but it is an external API, and the job needs its own backoff and its own
failure surface on the import row.

## Auth: connect, not sign-in

Nootles authentication is Clerk with Google OAuth only, locked in `CLAUDE.md`. Adding
Notion as an identity provider is a different and much larger decision than importing
pages, and the import does not need it.

What the import needs is the **GitHub precedent** (`convex/schema.ts:1040`): a
`notionAccounts` table holding an AES-GCM `sealed` token, a `hint`, the workspace name and
icon, and an `invalidAt` stamp so a dead connection can say "reconnect" instead of quietly
forgetting. Notion requires real OAuth rather than a pasted token, so the callback route is
new work, but the storage shape and the reconnect semantics are already solved here.

One UX consequence worth designing around early: **the user picks which pages we can see
inside Notion's own OAuth page-picker**, not in our UI. Our page tree can only ever show
what was granted, so the wizard needs a visible "grant more pages" path back into Notion —
otherwise a user who granted one page will conclude the import is broken.

## Why one-way, and what actually answers the adoption risk

One-way is right, and the hedge against adoption risk is not a Notion writer.

Import is the standard wedge — it removes switching cost at the exact moment someone is
deciding. That argument is well tested and it points only inward.

The stated worry is that no path back out raises adoption risk. That worry is real, but it
is about **trust**, not about Notion specifically: the buyer's question is "can I get my
data out", and the answer to that is an **export**, not a round-trip to one competitor.
Nootles → Markdown and Nootles → HTML answer it almost for free, since the NML serializer
is already exact (`serialize(parse(html)) === html` is a standing contract). That is a
fraction of the cost of a Notion writer and it covers every buyer, including the ones who
have never used Notion.

Nootles → Notion is worse than merely expensive — it is actively counterproductive. The
canvas, storyboard, album, location and multi-row math blocks have no Notion
representation, so the export would render precisely the differentiated work as broken
stubs inside a competitor's product. Shipping a feature whose output is a bad advert for
your own crown jewel is a strange thing to spend a quarter on.

So: one-way now, generic export as the trust answer, and revisit Notion-as-a-target only
if a real customer asks for it out loud.
