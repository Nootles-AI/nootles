# Commenting, Google Docs style

Technical design · 22 September 2026 · against `main` @ `fdc3c84`

## Status & deviations

**Implementation is in progress on the `comments/integration` branch**, in waves of unit
pull requests that merge there; one integration → `main` pull request lands the whole of it.
Wave 0 (the channel and its contracts) lays down the schema, the channel gate, the
`commenter` role as a type, comments-document minting, the audit and entitlement seams, the
NML thread types and the provider opt-outs. Nothing is on `main` yet.

Where the code disagreed with this design, these decisions were made and are what is built:

- **Teams is not on any branch, so its seams are minimal.**
  - `mentionablePeople` has the personal branch only (the owner plus share claims), behind
    one resolver with a workspace hook.
  - `auditEvents` takes the Teams design's exact shape, with `workspaceId` optional and a
    plain string until a `workspaces` table exists. `meta` is typed to ids and counts
    (`{ids?, counts?}`); `audit.recordAudit` is its only writer and refuses anything that is
    not id-shaped.
  - A single `comments` entitlement flag (`entitlements.PLAN_FEATURES`), on for every plan.
    `commentsEnabled` is asked by minting, by discovery and by the comments channel of the
    gate itself, so turning it off closes existing comments documents too.
- **NML has no container block, and paragraph props must be `{}`** — so §4's "a thread is a
  container block, a comment a paragraph" is not buildable as written. Two comment-only NML
  block types are added instead: `commentThread` (props `anchor`, `status`, `resolvedBy?`,
  `resolvedAt?`, `orphanedAt?`, `ambiguous?`; children `comment[]` only) and `comment`
  (props `authorId`, `createdAt`, `editedAt?`; inline content). They are valid only in a
  document whose `kind` is `"comments"`: a page document refuses them anywhere, and a
  comments document refuses every page block type. `NML_MARKS` and the inline grammar are
  untouched, as §6 requires. The placement rule is enforced by validation (and so by the
  command executor), not by decoding: a merge can always be read. When a thread is deleted
  while someone replies to it, the orphaned reply is dropped when the comments document is
  decoded. A page's orphans still recover at the root.
- **`reviewDecorations.ts` recomputes; it does not map.** The live-range model to copy is
  `app/components/editor/arrivalFlash.ts` (`set.map(tr.mapping, tr.doc)`);
  `reviewDecorations`' block-position walk supplies the id → position lookup.
- **The "NT-52 overlay layer" is a convention, not a component.** Cards portal to
  `document.body` and use the `--z-*` tokens.
- **Smaller gaps closed in wave 0.**
  - `YConvexProvider` can opt a document out of derived writes and presence
    (`acquireProvider(client, docId, { derived: false, presence: false })`).
  - The comments document is born server-side: `comments.ensureDoc` mints `commentsDocId`
    and writes its empty NML root as update #1 through `ydoc.registerYDoc`, so no two
    clients ever race to create the root.
  - The gate's channels default to the page document alone; only the content-blind Yjs log
    (`ydoc.ts`) accepts both. Presence, previews, the context digest, the NML migrator and
    the legacy ProseMirror sync API therefore refuse a comments docId without special cases.
  - `ydoc.init` stays document-channel only.
  - `MentionPick` has no person kind yet (wave 1).
- **Delivery is by waves, not the five PRs of §11**, all behind the same entitlement flag.
- **The comment UI (wave 3) made these calls.**
  - A comment is one NML paragraph, whose whitespace collapses, so the composer has no line
    breaks: Enter posts (as does ⌘Enter), Shift+Enter writes nothing. This departs from
    Docs, where Enter is a new line.
  - Cards or dots is decided by measurement, not by named layouts: the margin holds cards
    only when the pane has room for one beside the text, clear of the review's gutter
    buttons. A narrow window, the chat rail and split view all fall out of that one rule.
    The dots open the panel, which is also the drawer.
  - Deleting a whole thread is open to its author and to anyone holding the pen (owner or
    editor). A reply can be edited or deleted by its author only.
  - Comments are signed with names from a new `commentNotices.authors` query, which answers
    every reader of the comments. `mentionable` answers only people who may comment and
    leaves out the caller.
  - Model authorship is `comment.props.via: "assistant"`. The store stamps it whenever its
    actor is the model.
- **Testing (wave 4).** §12 runs end to end in `tests/comments-e2e.fullstack.mjs`
  (`npm run test:comments:e2e`): a throwaway `convex-local-backend`, the real app, one browser
  per person (owner, editor, commenter, viewer, stranger, signed-out guest, and an operator
  standing in with a token the deployment mints). CI runs it and the other comment harnesses
  (`comments-browser`, `comments-fullstack` jobs). Its findings were fixed:
  - A resolved card has a reply box ("Reply to reopen…") beside Reopen. Replying is the store's
    one `comments.reply` transaction, which also reopens, so it sends one `reply` notice (and
    one `comment.reply` audit row); Reopen alone still sends `reopen`.
  - Every replica converges on the stored anchor without a reload. When a thread's stored
    anchor changes under a replica that is not mid-edit on it and no longer quotes its live
    range (another client settled, re-homed or re-resolved it after a Keep), the replica moves
    the range to where the new anchor quotes verbatim (stage 1), for display only. If the
    words have not arrived yet, the mapped range stays and the move is retried on remote
    changes. A replica editing that range keeps its own and its settle pass writes.

Original status line (22 September 2026): nothing was implemented. This document chooses the
anchor format and the storage split, and sizes the work as five shippable pull requests.

It is written to sit beside [Teams in Nootles](../../Teams%20in%20Nootles.html), which is
being implemented in parallel. §10 says where the two meet.

## 1. What a comment is here

A comment is a **thread hung off a range of text**. Somebody selects words, says something
about them, other people reply, one of them resolves it, and the words go on being edited
underneath all of it.

The governing constraint is decision 3: a person may be allowed to comment **and not to
edit**. Everything below follows from taking that literally — a commenter must be able to
leave a thread while holding no write access to the document whatsoever.

| # | Question | Decision |
|---|---|---|
| 1 | Where the thread lives | Its own Yjs document, NML-encoded |
| 2 | How a comment points at text | Block id + a quote selector (`exact`/`prefix`/`suffix`) |
| 3 | Who may comment | A `commenter` role, gated by which channel the write is on |
| 4 | Writes to the commented document | **None**, ever, by anybody, on account of a comment |
| 5 | Anchor lost to an edit | Three-stage resolve, then orphaned; reversible |
| 6 | Replies | Flat, not nested — Docs' shape |
| 7 | Mentions | `@` a person the project's container already knows |
| 8 | Notification | In-app only; there is no mail infrastructure |
| 9 | Commenting during an AI review | Allowed — the review forks a different document |
| 10 | The assistant | Reads and authors comments in NML, behind a classifier |
| 11 | Suggestion mode ("suggest an edit") | Out of scope — that is the review system |
| 12 | Comments on a shape or an image | Out of scope; §13 says why |

## 2. The one idea: the document is never written to

```
  Page document  (ydocs.docId = pages.docId)        Comments document
  ─────────────────────────────────────────         (ydocs.docId = pages.commentsDocId)
                                                    ─────────────────────────────────
  NML blocks, stable ids                            NML blocks — the thread bodies
    p_7f3a: "…ship it by Friday if the…"              + anchor: { blockId: "p_7f3a",
                     ▲▲▲▲▲▲▲▲▲▲▲▲▲▲                              exact: "by Friday",
                     resolved by searching                       prefix: "ship it ",
                     ─ never marked ─                            suffix: " if the" }

  write gate: editor | owner                        write gate: commenter | editor | owner
```

Two Yjs documents, both NML, both on the persistence pipeline that already exists. The
commented document carries no trace of the comment — no attribute, no mark, no side map.
The comments document carries the thread *and* its anchor, and the anchor is text.

Three things fall out:

- **The role gate is a channel gate.** A commenter writes only to the comments document.
  Nothing needs to inspect the bytes of an update to decide whether it was allowed (§5).
- **Comments are fully NML.** Same AST, parser, serializer and semantic commands. The
  assistant reads and authors them with the grammar it already has (§8).
- **The anchor is mintable by a language model.** "Block `p_7f3a`, the phrase *by Friday*"
  is text. `Y.RelativePosition` is not, and no model will ever produce one.

### What was considered and rejected

**A mark in the document text.** Tracks edits for free and survives cut-and-paste, and it
is what BlockNote's own commenting does. Rejected because writing it is a document write,
which is the one thing decision 3 forbids — and the gate cannot be made honest by
authorizing the *mutation* while the client writes the bytes itself. It also forces
`commentId` through NML's inline grammar, whose decoder throws on an unrecognised
attribute (`app/lib/nml/yjs.ts`, `marksOf` and `textRuns`), so a half-deployed fleet would
fail to decode served documents rather than degrade.

**A `Y.RelativePosition` pair.** No document write, but it resolves only in the doc whose
items it names — and a served page has two roots, canonical `nml` and the derived
`prosemirror` mirror — so it needs the bridge's stable-ID index to cross. It is also
opaque: unreadable in the database, unmintable by the assistant, and undebuggable by a
person. The quote selector gives the same write-freedom with none of that.

**Block id alone.** Clean, and exactly how review hunks already anchor, but a Docs comment
points at a phrase and a block-grain comment is a different product.

## 3. The anchor

The W3C Web Annotation `TextQuoteSelector` shape, narrowed by a block id.

```ts
type CommentAnchor = {
  blockId: string;      // NML stable id — narrows the search to one block
  exact: string;        // the commented words
  prefix: string;       // up to 32 chars before them
  suffix: string;       // up to 32 chars after them
  offsetHint: number;   // where `exact` began in the block when the thread was made
};
```

### Durable anchor, live range

The selector is the **durable** anchor: it survives reload, resolves on any client, and is
the only thing persisted. It is deliberately *not* what the highlight is drawn from
frame to frame.

On load, each thread's selector is resolved **once** to a document range. From then on that
range is mapped forward through ProseMirror transactions — `tr.mapping`, which every
decoration already uses, and which covers remote Yjs changes too because y-prosemirror
delivers them as transactions. So while somebody types inside the commented phrase the
highlight tracks the characters exactly, at the cost of a decoration mapping step, and the
selector is never consulted.

That is the answer to the obvious objection. A quote selector re-searched on every
keystroke would drop the highlight the moment a word went half-typed; a quote selector
resolved once and then *mapped* is exactly as stable as a mark, and still writes nothing.
Re-resolution happens on load, and when mapping reports the range deleted.

`app/components/editor/ai/reviewDecorations.ts` is the working example of this pattern in
this codebase, and comment decorations should be built beside it.

### Resolving a selector: three stages, in order

Every stage is deterministic, so two clients resolving the same selector against the same
document always agree.

1. **Exact, in the named block.** Find every occurrence of `exact` in `blockId`. One match
   wins. Several are narrowed by `prefix` and `suffix`, then by nearest `offsetHint`, then
   by lowest offset — a total order, so there is no tie a client can break differently
   from its peer. A surviving ambiguity is recorded on the thread so the card can say the
   text appears more than once.
2. **Fuzzy, in the named block.** The words were edited rather than replaced. Match with an
   edit-distance threshold proportional to `exact.length` — the alignment machinery in
   `app/lib/ai/review/textDiff.ts` (common-ends plus LCS) is the same walk and should be
   reused rather than reimplemented. A fuzzy hit **rewrites `exact`** to what the text now
   says, so the anchor tracks slow drift instead of degrading toward a miss.
3. **Exact, document-wide.** The block is gone but the words are not: cut and pasted, or
   moved by a drag. Search every block; accept only a unique match, disambiguated by
   `prefix`/`suffix`. On a hit, **re-home** the anchor by writing the new `blockId`.

Re-homing and `exact`-rewriting are writes to the comments document, which a commenter may
make — and they are idempotent, since every client computes the same new value, so a
duplicate write from a second client converges rather than conflicting. No coordination and
no leader election.

If all three stages miss, the thread is **orphaned**: it leaves the margin and moves to a
"no longer in the document" section of the panel, keeping `exact` as the quotation of what
it was about. Orphaning is derived, not sticky — a thread whose text comes back (an undo, a
re-paste, a restored revision) re-anchors on the next resolve. `orphanedAt` is a cache for
listing and sweeping, cleared automatically when it resolves again.

**One rule about when orphaning may be written.** A resolve against a review's fork must
never persist an orphan. An agent's pending proposal that rewrites the commented sentence
makes the anchor unresolvable *in the fork*, and a discard puts it back. The fork's view
shows the thread as unanchored while the proposal stands, which is honest — the proposal
has nowhere to put it — but nothing is written until the answer lands and the shared
document is the thing being resolved against.

## 4. The comments document

`ydocs.docId` is a free-form `v.string()`, and `pages` already carries a `docId` column
resolved through a `by_doc` index. A page gains a second: `commentsDocId`, with its own
`by_comments_doc` index. The entire persistence pipeline — `append`, chunking, the update
log, snapshots, compaction — then works unchanged, because all of it is keyed by `docId`
and none of it cares what is inside.

The comments document's NML holds one block per comment, grouped per thread, with the
thread's anchor and status as block props. It is ordinary NML: `parse`, `serialize`,
`validate` and the semantic command executor all apply as they stand, and the AST needs no
new node type. A thread is a container block; a comment is a paragraph inside it with an
author and a timestamp on its props.

**Convex rows hold nothing about a comment's content.** The only rows are the inbox
(§9) and audit (§10), which are about *notification* and *record*, not about the thread.

### Why a separate document rather than a second root

The NML work already puts two roots in one Y.Doc (`nml` and the derived `prosemirror`
mirror), so a third root is the obvious move and it is wrong here for two reasons.

- **A root cannot be gated.** Updates arrive as opaque bytes; deciding which root an update
  touched means resolving parent chains against state the update does not carry. A separate
  `docId` is gated by which mutation was called, which is where every other gate in this
  codebase lives.
- **A review forks the Y.Doc.** A comments root would fork with it, so comments written
  during a review would reach nobody and a discard would delete them. A separate document
  never forks, which is the whole of decision 9.

## 5. Access: the commenter role

`convex/auth.ts` has `ProjectRole = "owner" | "editor" | "viewer"`, resolved from which live
link token a claim came by. `commenter` is a fourth answer on a third token
(`project.commentShareToken`), ranked between viewer and editor, and demoted by the same
live-token re-derivation the editor link already has.

The gate itself is the good part. `convex/prosemirror.ts`'s `pageForDoc` resolves a `docId`
by **looking it up as a column on the page row**, not by parsing the string:

```ts
export async function pageForDoc(ctx, id) {
  return await ctx.db.query("pages").withIndex("by_doc", q => q.eq("docId", id)).unique();
}
```

So the channel is decided by *which index matched*, and a caller supplying a `docId` cannot
choose the channel — the database does:

```ts
// convex/prosemirror.ts
export async function pageAndChannelForDoc(ctx, id) {
  const page = await byDoc(ctx, id);
  if (page) return { page, channel: "document" as const };
  const commented = await byCommentsDoc(ctx, id);
  return commented ? { page: commented, channel: "comments" as const } : null;
}

export async function checkWrite(ctx, id) {
  await refuseStandIn(ctx);                       // unchanged: no stand-in writes
  const found = await pageAndChannelForDoc(ctx, id);
  if (!found) throw new Error("Not found");
  const role = await roleForPage(ctx, found.page);
  const allowed = found.channel === "comments"
    ? role === "commenter" || role === "editor" || role === "owner"
    : role === "editor" || role === "owner";
  if (!allowed) throw new Error("Not found");
}
```

A commenter calling `append` with the page's document id is refused, because that id
resolves through `by_doc` and the document channel requires editor. There is nothing to
forge and no bytes to validate. `requireEditable` does not move, and `refuseStandIn` covers
the comments channel for free.

| Viewer | Read page | Read comments | Reply | Start a thread | Edit the page |
|---|---|---|---|---|---|
| Owner / editor | ✓ | ✓ | ✓ | ✓ | ✓ |
| Commenter | ✓ | ✓ | ✓ | ✓ | — |
| Viewer | ✓ | ✓ | — | — | — |
| Operator standing in | ✓ | ✓ | — | — | — |

### One inherited behaviour to decide deliberately

`checkRead` today ends with:

```ts
if (project.shareToken || project.editShareToken) return;
```

— any live share token admits a read, with no role and no sign-in. Comments would inherit
that, so a signed-out link visitor would read the team's comments on a public page. That is
almost certainly not wanted, and it is the same hole the teams design closes with its
decision 12 (workspace links require sign-in). **Until that lands, the comments channel
should not take the fallback**: `checkRead` on a comments `docId` requires a resolved role.
One line, and it fails closed.

## 6. What this design does not have to solve

Worth stating, because the previous draft of this plan spent three sections on each.

- **NML's inline allowlist.** `marksOf` and `textRuns` throw on an unrecognised attribute.
  Nothing is added to inline content, so `NML_MARKS` is untouched and no cohort migration,
  schema version bump or half-deployed-fleet decode failure exists.
- **The review fork's birth record.** `ensureForked` records `Y.XmlFragment.toString()`,
  which serializes attributes — a comment written under a review would have read to
  `mergeFork` as the person's own work. A separate document is never forked, so commenting
  during a review just works.
- **The review diff.** `app/lib/ai/review/textDiff.ts` compares characters and never reads
  marks or styles, so a commented range was never going to be drawn as an agent change.
  Now there is nothing in the document to read either way.
- **Undo.** ⌘Z in the document cannot reach a comment, because the comment is not in it.
  The comments document gets its own `Y.UndoManager`, scoped to its own doc.

## 7. The panel and the margin

Highlight under the words, card in the right margin aligned to the block the anchor starts
in, overlapping cards stacked downward, the focused thread taking its natural position —
the Docs behaviour.

The margin is contended. The review already draws its rule there, on the changed block's
`::after` and never `::before`, because BlockNote pins `height: 0` on that pseudo-element
as a Chrome workaround (NT-47). Comment cards take neither: after NT-52 every floating
surface portals into one overlay layer, and cards go through it. On a narrow window, or
with the chat rail out, cards collapse to a gutter dot and the thread opens in a drawer.

Layout is one measurement per pass, not one per thread per frame. The two workspace-motion
passes (#150, #158) exist because that region restyles the whole document when handled
carelessly, and fifty threads is exactly the load that would show it.

## 8. The assistant

Because the thread is NML, the assistant reads it with `parse` and writes it with the
semantic command executor — no bespoke serialization, no second grammar.

Whether it reads them at all is a per-interaction decision, not a setting: a classifier
ahead of context assembly decides whether this turn is one where the comments matter. A
request to redraft a paragraph usually is; a request to add a table usually is not.
Comments are frequently about the document rather than in it — disagreement, hedging, a
half-made decision — and pouring them into every prompt would be both expensive and
misleading.

Three operations, added to the vocabulary in PR 5: read the open threads on a page, reply
to one, resolve one. Authoring an anchor is the interesting one and it is nearly free: the
model already names blocks by stable id in every other operation, and `exact`/`prefix`/
`suffix` are quotations from text it is holding. The executor validates a minted anchor by
resolving it before the write, so a hallucinated quotation is refused at the boundary
rather than stored as an anchor that will never match.

## 9. Mentions and the inbox

`@` in a comment opens the existing `MentionMenu` — already the hand-built menu used by the
chat composer and the canvas label editor, already taking a filtered list and keyboard
handling. What it has never been given is a list of **people**:

```ts
mentionablePeople(ctx, project) →
  workspace project : active memberships of project.workspaceId
  personal project  : share claims on the project, plus the owner
```

There is no mail infrastructure in this repository — no Resend, no nodemailer, no send path
of any kind — so notification is in-app, modelled on `accessRequests`: a row per recipient
per event, a `seenAt` recording being told, and an index making the recipient's inbox one
read wherever they are standing.

```ts
commentNotices: defineTable({
  recipientId: v.string(),            // Clerk subject
  pageId: v.id("pages"),
  threadId: v.string(),               // the NML block id of the thread
  kind: v.union(v.literal("mention"), v.literal("reply"), v.literal("resolved")),
  createdAt: v.number(),
  seenAt: v.optional(v.number()),
}).index("by_recipient_unseen", ["recipientId", "seenAt"]),
```

Mentioning somebody who cannot open the project is refused at the mutation with a message
saying so, rather than sending a notice to a door that will not open.

## 10. Where this meets the teams work

**The idea, first.** The teams design's `Container` — "one resolver turns a project into a
container, and four call sites consume it" — is exactly what §9 needs. *Who can I mention*
is *who does this project's container know*, and that belongs as a fifth call site on their
abstraction. Building a second membership lookup here would give the product two answers to
one question inside a release.

**`convex/auth.ts`.** Both features rewrite `roleForProject`: theirs adds the workspace
branch ahead of the personal one, ours adds a fourth role inside the claim path. The
conflict is textual, not conceptual — a workspace member resolves to `editor` or `owner` and
never reaches the claim path, so `commenter` is a link-holder's role in both worlds.
**Sequence it: their PR 1 lands first, ours rebases onto it.**

**Their decision 12 and our `checkRead`.** §5's fallback hole is their finding, not ours;
we fail closed on the comments channel until their sign-in requirement lands, then delete
our special case and inherit theirs.

**`shareClaims`.** Their PR 2 adds `expiresAt?`. A `commenter` claim must honour it the
moment it exists — one line, in their file, worth agreeing on now.

**`auditEvents`.** Their decision 23 coalesces edit activity by
`(page, actor, 10-minute window)` and writes discrete events one row each. Comments are
discrete: `comment.create`, `comment.resolve`, `comment.delete`, one row apiece. `meta`
carries ids and counts only — **never the comment body** — for the same reason their audit
log carries no document text: it would become a second copy of the conversation under
different access rules.

**Entitlements.** Add `comments: boolean` to their `PLANS` matrix, `true` on every tier
including free. Commenting is not a feature to meter; the row exists so a workspace can be
turned off through the override table they already ship if it is ever abused.

**Guests.** Their decision 14 makes guests free, which makes a comment link cheap to hand
out. Comments cost no model call, so they sit outside their §7 guest-spend concern entirely.

## 11. Rollout

Five pull requests, each shippable alone, behind a `comments` entitlement until the last.

**PR 1 — The channel.** `pages.commentsDocId` and its index, `pageAndChannelForDoc`, the
channel-aware `checkRead`/`checkWrite`, and a comments Y.Doc that persists and syncs with no
UI at all. The test that matters is the negative one: a commenter appending to the page's
document id is refused.

**PR 2 — Threads and anchors.** The NML thread shape, the three-stage resolve, the
durable-selector/live-range decoration, the margin cards on the overlay layer, the panel,
orphaning. Owner and editor only.

**PR 3 — The commenter role.** `commentShareToken`, `roleForProject`, the share dialog's
third row, the share route, and the comments channel opened to `commenter`.

**PR 4 — Mentions and the inbox.** `mentionablePeople` on the teams `Container`, the `@`
menu wired to people, `commentNotices`, the unread affordance.

**PR 5 — The assistant, and audit.** The classifier, the three operations, anchor
validation at the executor boundary, audit events, CSV export beside the teams one.

Nothing here has the deploy-ordering hazard the previous design had, because no client
writes anything the fleet must understand first. A client without PR 2 simply does not
show comments on a page that has them.

## 12. Testing

Comments are a concurrency feature, so what counts is browser tests with two real replicas,
following the house pattern (`tests/*.browser.mjs`, real Chromium input, a stand-in Convex
backend, the peer asserted on its Y.Doc rather than a second rendered editor).

**The anchor.**
- Type inside the commented phrase: the highlight tracks the characters on both replicas
  and the selector is never re-resolved.
- Type at each edge: the range does not grow.
- Reload mid-edit: the selector re-resolves to the range the mapping had.
- Edit the phrase until `exact` no longer matches, then reload: stage 2 hits, `exact` is
  rewritten, both replicas agree.
- Cut the paragraph and paste it elsewhere, then reload: stage 3 re-homes to the new block,
  and two clients doing it concurrently converge on the same `blockId`.
- Delete the phrase: orphaned on both replicas. Undo it: re-anchored, `orphanedAt` cleared.
- The same phrase twice in one block: `prefix`/`suffix` disambiguate; identical context
  falls to `offsetHint` then lowest offset, and both replicas pick the same one.

**The gate.**
- A commenter starts a thread; the same person's `append` to the page's `docId` is refused.
- A commenter's document write is refused at `requireEditable`, unchanged.
- An operator standing in is refused on the comments channel.
- Revoking the comment link demotes claimants to viewer; revoking every link closes the
  project.
- A signed-out link visitor reads the page and is refused the comments channel.

**The review.** A review opens: commenting works throughout. An anchor the proposal rewrites
reads as unanchored under the fork and **no orphan is written**; Discard restores it, Keep
resolves it against the new text through stage 2. This is the NT-45/NT-68 shape and it is
where a regression will hide.

`app/lib/nml/` gains direct tests for the resolver — all three stages, the total order, and
the idempotence of re-homing — which run far faster than the browser for that half.

## 13. Left open, deliberately

- **Comments on a shape, an image or a table cell.** The anchor here is a quotation of
  inline text. A shape lives in per-shape CRDT maps with no text to quote, so it needs a
  second anchor kind — `blockId` plus a shape id, with no selector — which is additive to
  this design but is its own change.
- **Suggestion mode.** "Propose an edit rather than make it" already exists here as the AI
  review's accept/reject layer. A human suggestion should reuse it, and deciding how is its
  own design; the wiki is explicit that competing undo semantics are not to be created.
- **Email.** §9. In-app until somebody builds a send path.
- **Comment edit history.** An edit rewrites the paragraph; previous bodies are not kept.
- **Anchors surviving a wholesale rewrite.** Stage 2 tracks drift, not replacement. Text
  rewritten past the threshold orphans, as it does in Docs.
- **Reactions.** Cheap, and not in this release.

## Related

[`nml-canonical-ast.md`](nml-canonical-ast.md) ·
[`nml-prosemirror-view-bridge.md`](nml-prosemirror-view-bridge.md) ·
[`../../agent-wiki/architecture/editor-and-sync.md`](../../agent-wiki/architecture/editor-and-sync.md) ·
[`../../agent-wiki/architecture/data-and-auth.md`](../../agent-wiki/architecture/data-and-auth.md)
