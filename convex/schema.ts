import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Nootles data model — bounded, non-recursive hierarchy:
 *   Project → Page → Block[text|canvas] → (canvas) Shape → {text, image}
 *
 * Text/block *content* is synced separately as Yjs updates (`ydocs`/`yUpdates`/
 * `ySnapshots`), or through @convex-dev/prosemirror-sync for documents not yet
 * migrated. A diagram is part of that content, not a table: its shapes and
 * edges are per-shape CRDT maps inside the page's Y.Doc, mirrored to the canvas
 * HTML on the block. This schema holds the structural tree around all of that,
 * and the AI substrate tables (operation log, checkpoints, context sheet).
 *
 * Tenancy: every top-level row carries `ownerId` — the Clerk subject that
 * created it. Access beyond the owner is granted per project through share
 * links and the claims they leave behind (`shareClaims`); resolution lives in
 * `auth.ts`, never at call sites.
 */

/**
 * Which surface a feedback report is about. One value per product surface,
 * "general" for everything else. Shared by the submit path, the classifier,
 * and the ops dashboard's admin functions.
 */
export const feedbackCategory = v.union(
  v.literal("canvas"),
  v.literal("code"),
  v.literal("math"),
  v.literal("tables"),
  v.literal("autocomplete"),
  v.literal("chat"),
  v.literal("editor"),
  v.literal("sharing"),
  v.literal("account"),
  v.literal("general"),
);

/**
 * Where a ticket stands: new → seen (auto, on first open) → in_progress →
 * pr_filed → done; declined ends a wish that won't be built.
 *
 * `pr_filed` is set by the PR poller whenever a pull request names the ticket,
 * whoever wrote it — provenance lives on the `ticketPrs` row, not here, so this
 * ladder stays about the ticket rather than about who did the work.
 */
export const feedbackStatus = v.union(
  v.literal("new"),
  v.literal("seen"),
  v.literal("in_progress"),
  v.literal("pr_filed"),
  v.literal("done"),
  v.literal("declined"),
);

/**
 * A repository as the picker hands it over — the same shape whether it is being
 * linked to a project that exists or carried alongside one being created.
 */
/**
 * The icon a sidebar row carries — a page's or a folder's.
 *
 * Three sources, one shape, because the row that draws it should not care where
 * it came from: an emoji, one of the app's own drawn glyphs by export name, or
 * an uploaded image. A discriminated union rather than a formatted string so
 * the future ambient LLM can set one through the same validated operation a
 * person does, and so an unknown `kind` fails at the door instead of rendering
 * as a broken glyph.
 *
 * `icon` stays optional everywhere it appears: a row without one keeps the
 * fixed page/folder glyph it has always drawn, so this is purely additive and
 * needs no migration.
 */
export const rowIcon = v.union(
  v.object({ kind: v.literal("emoji"), value: v.string() }),
  v.object({ kind: v.literal("icon"), name: v.string() }),
  v.object({ kind: v.literal("image"), storageId: v.id("_storage") }),
);

export const repoRef = v.object({
  /** "owner/name", the way GitHub writes it and the way the agent names it. */
  fullName: v.string(),
  defaultBranch: v.string(),
  description: v.optional(v.string()),
  private: v.boolean(),
});

export default defineSchema({
  projects: defineTable({
    ownerId: v.string(),
    title: v.string(),
    // Optional short description that seeds the Context Sheet.
    description: v.optional(v.string()),
    /**
     * Link sharing, one token per role. Present = that link is live: each token
     * is an unguessable capability (a server-minted UUID) that names this
     * project in a public `/share/<token>` URL — `shareToken` admits viewers,
     * `editShareToken` admits editors. Unset to revoke; the old link dies with
     * it, and so does the access of everyone who claimed through it.
     */
    shareToken: v.optional(v.string()),
    editShareToken: v.optional(v.string()),
    /**
     * What the projects screen draws about this project's pages, denormalized
     * so the screen's read set stops covering every page of every project.
     * Maintained by `projects.refreshPageSummary`; absent on projects written
     * before it existed, which the screen still derives from the pages.
     * `pageCount` present is what says the whole summary is.
     */
    pageCount: v.optional(v.number()),
    firstPageDocId: v.optional(v.string()),
    updatedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_share_token", ["shareToken"])
    .index("by_edit_share_token", ["editShareToken"]),

  /**
   * What visiting a share link while signed in leaves behind: a bookmark plus
   * an identity, NOT a standing grant. Live permission is derived in `auth.ts`
   * from the claim's role and whether the project's corresponding token is
   * still set — so revoking a link revokes everyone who came through it, and a
   * claim row on its own admits nobody.
   *
   * `granteeId` is the recipient's Clerk subject, always derived server-side.
   * Deliberately NOT named `ownerId`: that field name would enroll this table
   * in the `Owned` union in `auth.ts`, and "rows I granted" is not a read
   * anyone performs.
   */
  shareClaims: defineTable({
    projectId: v.id("projects"),
    granteeId: v.string(),
    role: v.union(v.literal("viewer"), v.literal("editor")),
    /**
     * The pen, handed to this person by name — what the owner granting an
     * access request writes. Separate from `role` because that field records
     * which LINK they came by and must keep meaning that: promoting one viewer
     * must never be confused with turning the editor link on for everyone
     * holding it. Still contingent on the project being shared at all, so
     * revoking every link remains the owner's one way to close the door on
     * everybody (`auth.ts`).
     */
    grantedRole: v.optional(v.literal("editor")),
    createdAt: v.number(),
  })
    .index("by_grantee", ["granteeId"])
    .index("by_project_and_grantee", ["projectId", "granteeId"]),

  /**
   * "May I edit this?", asked from a read-only project and answered by its
   * owner. A row per person per project, reused rather than appended to: asking
   * twice is the same question, and the owner should see one of it.
   *
   * `projectOwnerId` is denormalized so the owner's inbox is one index read
   * wherever they happen to be standing, rather than a walk of their projects.
   * Deliberately not named `ownerId`: that field name would enroll this table
   * in the `Owned` union in `auth.ts`, and these rows are not the owner's to
   * read as their own — they are correspondence between two people.
   */
  accessRequests: defineTable({
    projectId: v.id("projects"),
    /** The Clerk subject asking, always derived server-side. */
    requesterId: v.string(),
    projectOwnerId: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
    ),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    /** When the requester was told they were let in. Grants only — a decline
     *  is never announced, it just leaves them able to ask again. */
    seenAt: v.optional(v.number()),
  })
    .index("by_project_and_requester", ["projectId", "requesterId"])
    .index("by_owner_and_status", ["projectOwnerId", "status"])
    .index("by_requester_and_status", ["requesterId", "status"]),

  /**
   * Per-account settings. Exists at all because first run needs somewhere to
   * record that it happened — a row here is what stops the welcome flow being
   * shown twice, so its absence is the "new account" signal.
   *
   * The survey answers are kept because they are not single-use: `role` and
   * `useCase` seed the project's Context Sheet, and `defaultMode` is the mode
   * new pages are created in. Nothing collected here is decoration.
   */
  profiles: defineTable({
    ownerId: v.string(),
    /**
     * Stamped from the verified Clerk identity once per session — never from
     * the client — so the operator dashboard can put a face to an id.
     */
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    /** Free text: the survey offers choices but accepts anything. */
    role: v.optional(v.string()),
    useCase: v.optional(v.string()),
    defaultMode: v.optional(v.union(v.literal("create"), v.literal("complete"))),
    /** The old gated tour's state. Unwritten now; kept so legacy rows validate. */
    tour: v.optional(
      v.object({
        projectId: v.id("projects"),
        template: v.string(),
        beat: v.number(),
        done: v.array(v.string()),
      }),
    ),
    /**
     * What first run seeded, so the hints can find their script — the template
     * names the hanging sentence to finish and the question to draft in chat.
     */
    seed: v.optional(
      v.object({ projectId: v.id("projects"), template: v.string() }),
    ),
    /**
     * First-touch hints already acted on, by id. Held server-side rather than
     * in localStorage so a hint that died stays dead across devices — each one
     * is shown until its lesson is demonstrably learned, and never again.
     */
    hints: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("surveying"),
      v.literal("touring"),
      v.literal("done"),
      v.literal("skipped"),
    ),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  /**
   * Sidebar folders: a folder holds pages and other folders of the same
   * project. Navigation structure only — a page's content never moves when its
   * row does, so this table stays outside the content hierarchy the schema
   * note above locks. Each level's folders and pages share one fractional
   * order line, so either kind can sit anywhere among the other.
   */
  folders: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    title: v.string(),
    /** Containing folder; absent = the project's top level. */
    parentId: v.optional(v.id("folders")),
    /** Chosen icon; absent = the fixed folder glyph. See `rowIcon`. */
    icon: v.optional(rowIcon),
    /** Manual place among the level's rows, folders and pages alike. */
    order: v.number(),
    createdAt: v.number(),
  }).index("by_project", ["projectId", "order"]),

  pages: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    title: v.string(),
    /**
     * How eager ambient suggestions should be on this page.
     *
     * "create" is the default: the model writes what is not there yet, and may
     * propose code, math and diagrams. "complete" only finishes what you have
     * started — it keeps a suggestion solely when the page itself supports it,
     * which is what you want while taking notes ON something, where the model
     * cannot know what comes next and every guess is invention.
     *
     * Optional so existing pages read as "create" without a migration.
     */
    mode: v.optional(v.union(v.literal("create"), v.literal("complete"))),
    /** Containing sidebar folder; absent = the project's top level. */
    folderId: v.optional(v.id("folders")),
    /** Chosen icon; absent = the fixed page glyph. See `rowIcon`. */
    icon: v.optional(rowIcon),
    // Manual place among the level's rows — one order line with its sibling
    // folders, not a rank within pages alone.
    order: v.number(),
    // prosemirror-sync document id for this page's block flow.
    docId: v.string(),
    /**
     * Set once this page's document moved to the Yjs pipeline — the same fact
     * as a `ydocs` row, kept here so `ydoc.state` can answer without reading a
     * row that every flush rewrites. Absent until the doc's next append, which
     * is where it is stamped; `ydoc.state` falls back to the `ydocs` lookup.
     */
    yjs: v.optional(v.boolean()),
    createdAt: v.number(),
    /**
     * Last time the page's content changed, stamped from the sync component's
     * `onSnapshot` hook — which already runs on the editor's debounce, so this
     * costs no write per keystroke. Coarse by construction: a page edited and
     * left alone for less than one debounce reads as its previous value, which
     * is well inside the granularity anything displays it at.
     *
     * Optional because pages written before it existed have no value; readers
     * fall back to `createdAt`.
     */
    updatedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId", "order"])
    .index("by_doc", ["docId"]),

  // ---- Document sync (Yjs) ------------------------------------------------
  // One CRDT document per page, stored as an update log folded into chunked
  // snapshots. App-level tables rather than a component because access rides
  // the same checkRead/checkWrite the legacy pipeline uses, and components do
  // no auth of their own.

  /**
   * One row per Yjs-native doc — its existence IS the migration flag: a docId
   * with a row here syncs through Yjs, and the legacy prosemirror-sync write
   * path refuses it. The row also serializes appends: every writer bumps
   * `seq` here, so Convex's transaction conflicts are what make sequence
   * numbers dense and unique. (Yjs itself never needs the order — updates are
   * commutative — seq is purely a fetch cursor.)
   */
  ydocs: defineTable({
    docId: v.string(),
    /** Seq of the newest yUpdates row; 0 = none yet. */
    seq: v.number(),
    /** Updates with seq <= this are folded into the snapshot. */
    snapshotSeq: v.number(),
    /** Chunk count of the current snapshot; 0 = no snapshot yet. */
    snapshotParts: v.number(),
    /**
     * Encoded size of the current snapshot. Written by the compactor so that
     * `append` can tell, without reading the chunks, that a fold would only
     * read them to find them too heavy to fold. Absent on snapshots written
     * before it existed.
     */
    snapshotBytes: v.optional(v.number()),
    /** The legacy pipeline's version at migration, for audit. */
    migratedFromVersion: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_doc", ["docId"]),

  /**
   * The update log: one merged Yjs update per client flush. Deleted as the
   * compactor folds them into the snapshot.
   */
  yUpdates: defineTable({
    docId: v.string(),
    seq: v.number(),
    update: v.bytes(),
    /**
     * Present on updates too large for one row: `parts` rows share the seq,
     * written in one transaction, joined by `yshape.joinUpdateRows` before
     * anything applies them. Absent means whole — every pre-existing row.
     */
    part: v.optional(v.number()),
    parts: v.optional(v.number()),
  }).index("by_doc_and_seq", ["docId", "seq"]),

  /**
   * The folded document, chunked under Convex's 1MiB value cap. `gen` is the
   * `snapshotSeq` the snapshot corresponds to; superseded generations are
   * deleted by the compactor that wrote their replacement.
   */
  ySnapshots: defineTable({
    docId: v.string(),
    gen: v.number(),
    part: v.number(),
    data: v.bytes(),
  }).index("by_doc_and_gen_and_part", ["docId", "gen", "part"]),

  /**
   * Who is on a document right now — one row per open session, carrying the
   * encoded y-protocols awareness state (cursor positions, selections) plus
   * the little the facepile needs denormalized so it never decodes Yjs.
   *
   * High-churn by nature (rewritten on every cursor move), which is exactly
   * why it is its own table rather than fields on `ydocs`. Hand-rolled rather
   * than `@convex-dev/presence` because awareness is an arbitrary binary
   * payload that component has no channel for. Rows go stale rather than
   * being deleted on disconnect — the client filters against its own clock
   * and a cron sweeps the leftovers, so no query ever reads the wall clock.
   */
  presence: defineTable({
    docId: v.string(),
    /** One per provider instance — two tabs are two presences. */
    sessionId: v.string(),
    /** The Y.Doc clientID this session's awareness states are keyed by. */
    clientId: v.number(),
    /** The signed-in subject, for self-filtering; absent for guests. */
    userId: v.optional(v.string()),
    user: v.object({
      name: v.string(),
      color: v.string(),
      imageUrl: v.optional(v.string()),
    }),
    /** encodeAwarenessUpdate for this one client. */
    state: v.bytes(),
    updatedAt: v.number(),
  })
    .index("by_doc_and_session", ["docId", "sessionId"])
    .index("by_doc", ["docId"])
    .index("by_updated", ["updatedAt"]),

  // ---- AI substrate (populated in Phase 2; defined now so it's stable) ----

  /** Append-only log of Operations (human + AI), the Context Spine feed. */
  opLog: defineTable({
    ownerId: v.string(),
    pageId: v.id("pages"),
    // Discriminated Operation payload (validated by the Zod vocabulary).
    op: v.any(),
    source: v.union(v.literal("human"), v.literal("ai")),
    // Set when this op belongs to an AI turn / chat prompt.
    chatPromptId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_page", ["pageId", "createdAt"]),

  /** Full snapshots for Cursor-style rewind; taken at every chat prompt. */
  checkpoints: defineTable({
    ownerId: v.string(),
    pageId: v.id("pages"),
    chatPromptId: v.string(),
    /** The packed BlockNote document, diagrams and all — see `ai/checkpoints.ts`. */
    docSnapshot: v.any(),
    /** Only ever written null, by rows older than this comment. */
    canvasSnapshot: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_page", ["pageId", "createdAt"]),

  /**
   * Every ambient suggestion the pipeline considered, and what became of it.
   * This is the eval signal for tuning the heuristics/gate — and the training
   * set if we ever distil an in-house model.
   */
  suggestionLog: defineTable({
    ownerId: v.string(),
    pageId: v.id("pages"),
    /** Heuristic proposal kind: code | formatCode | formatMath | reformat | diagram. */
    kind: v.string(),
    /** Did the Tier 1 gate confirm it? */
    gateOk: v.boolean(),
    /** Was a chip actually rendered? */
    shown: v.boolean(),
    outcome: v.union(
      v.literal("gated"),
      v.literal("accepted"),
      v.literal("dismissed"),
      v.literal("superseded"),
      v.literal("failed"),
    ),
    latencyMs: v.number(),
    // ---- Suggestion payload + context (all optional: rows predate them) ----
    /** What was generated, capped — the part a prompt iteration needs to read. */
    suggestionText: v.optional(v.string()),
    /** Visible text just before the caret at generation time. */
    contextBefore: v.optional(v.string()),
    model: v.optional(v.string()),
    pageMode: v.optional(v.union(v.literal("create"), v.literal("complete"))),
    docLength: v.optional(v.number()),
    // ---- Decision ----
    /** Time from shown to accept/dismiss — instant-dismiss vs read-then-reject. */
    decisionMs: v.optional(v.number()),
    dismissReason: v.optional(
      v.union(
        v.literal("typed-through"),
        v.literal("cursor-moved"),
        v.literal("superseded"),
        v.literal("escape"),
        v.literal("timeout"),
      ),
    ),
    // ---- Accept ----
    blockIds: v.optional(v.array(v.string())),
    acceptedText: v.optional(v.string()),
    /** Reformat: how many candidates were offered, and which one won. */
    candidateCount: v.optional(v.number()),
    chosenIndex: v.optional(v.number()),
    // ---- Post-accept fate (written later by scoreSurvival / amend) ----
    /** 0..1 — how much of the accepted text is still there at T+10min. */
    survivalScore: v.optional(v.number()),
    survivalCheckedAt: v.optional(v.number()),
    /** Set when the accept was undone within the 30s client watch. */
    undoneWithinMs: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId", "createdAt"])
    .index("by_owner", ["ownerId", "createdAt"]),

  /**
   * Drawings the chat's draw tool has made, waiting to be placed.
   *
   * Out of band by necessity, not preference: a drawn storyboard shot is
   * ~100KB of path data, and carried inside the tool result it travelled
   * everywhere a message travels — through the model's own step loop (nine
   * shots put 400K tokens into one request), into the persisted transcript
   * (2.14MiB, over the document ceiling), and back up with every later turn.
   * Here, a result is a ref and a row is a drawing; `edit_page` redeems refs
   * against this table, which also survives a reload where a message-borne
   * drawing did not. Rows are transient — placed content lives in the
   * document — and a cron sweeps the stale ones.
   */
  drawings: defineTable({
    ownerId: v.string(),
    ref: v.string(),
    data: v.string(),
    createdAt: v.number(),
  })
    // Owner-scoped: refs are deterministic (a brief's fingerprint), so two
    // accounts drawing the same brief legitimately share a ref string.
    .index("by_owner_and_ref", ["ownerId", "ref"])
    .index("by_owner", ["ownerId", "createdAt"]),

  /**
   * One row per LLM request, whatever the feature — the cost and reliability
   * ledger. Written fire-and-forget from the API routes after each stream ends.
   */
  aiCalls: defineTable({
    ownerId: v.string(),
    feature: v.union(
      v.literal("fim"),
      v.literal("reformat"),
      v.literal("diagram"),
      v.literal("chat"),
      v.literal("categorize"),
      v.literal("feedback"),
    ),
    model: v.string(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cacheReadTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    latencyMs: v.number(),
    ttfbMs: v.optional(v.number()),
    status: v.union(
      v.literal("ok"),
      v.literal("error"),
      v.literal("aborted"),
      v.literal("timeout"),
    ),
    errorCode: v.optional(v.string()),
    costUsd: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId", "createdAt"])
    .index("by_feature", ["feature", "createdAt"]),

  /** In-app "report issue / suggest feature" submissions, with their context. */
  feedback: defineTable({
    /**
     * The ticket's human name, `NT-{number}` — short enough to type into a PR
     * title, which is the whole point: that title is how a PR finds its way
     * back to the ticket it fixes. Allocated from the `counters` row at submit,
     * and backfilled onto the rows that predate it (`migrations.numberTickets`).
     */
    number: v.number(),
    ownerId: v.string(),
    kind: v.union(v.literal("issue"), v.literal("wish")),
    text: v.string(),
    screenshotStorageId: v.optional(v.id("_storage")),
    consoleLog: v.optional(v.string()),
    recentOps: v.optional(v.any()),
    pageId: v.optional(v.id("pages")),
    projectId: v.optional(v.id("projects")),
    replayUrl: v.optional(v.string()),
    env: v.object({
      sha: v.optional(v.string()),
      ua: v.string(),
      viewport: v.string(),
    }),
    status: feedbackStatus,
    /** Triage weight, Linear's ladder. Absent = no priority. */
    priority: v.optional(
      v.union(
        v.literal("urgent"),
        v.literal("high"),
        v.literal("medium"),
        v.literal("low"),
      ),
    ),
    /** Which surface it's about — AI-suggested on the form, always editable. */
    category: v.optional(feedbackCategory),
    /**
     * The reporter's email, read off the verified Clerk identity at submit —
     * never from the client — so a ticket can be answered, not just read.
     */
    email: v.optional(v.string()),

    /**
     * When the reporter was told this was fixed. Absent means they have not
     * been — including for everything closed before this existed, which is
     * deliberate: the backlog of fixes announces itself the next time each
     * reporter opens the app, and there is nothing to backfill.
     */
    notifiedAt: v.optional(v.number()),

    // ---- Triage ------------------------------------------------------------

    /**
     * The ticket this one repeats, always a ticket that is not itself a
     * duplicate — `feedbackSetDuplicate` collapses chains at write time, so the
     * pointer is one hop by construction.
     *
     * A link, never a merge: both reporters keep their row and their claim to
     * having reported it.
     */
    duplicateOf: v.optional(v.id("feedback")),
    duplicateSetBy: v.optional(
      v.union(v.literal("agent"), v.literal("human")),
    ),

    /**
     * Set by the operator to keep a ticket away from the agent entirely. The
     * queue queries filter on it, so a skipped ticket is never handed out —
     * this is a boundary, not a request the agent is trusted to honour.
     */
    agentSkip: v.optional(v.boolean()),

    /** 0–100: how *concrete* the report is, not how easy it'd be to build. */
    triageScore: v.optional(v.number()),
    triageNotes: v.optional(v.string()),
    triagedAt: v.optional(v.number()),
    triageRunId: v.optional(v.id("agentRuns")),
    /** Which rubric produced the score, so old scores stay comparable. */
    rubricVersion: v.optional(v.string()),

    /**
     * What happened the last time the agent tried to implement this. Without
     * it a ticket that fails is retried every night, forever.
     */
    agentAttemptedAt: v.optional(v.number()),
    agentOutcome: v.optional(
      v.union(v.literal("filed"), v.literal("failed"), v.literal("declined")),
    ),
    agentRunId: v.optional(v.id("agentRuns")),

    createdAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_owner", ["ownerId", "createdAt"])
    .index("by_number", ["number"])
    .index("by_duplicateOf", ["duplicateOf"]),

  /**
   * Pull requests that name a ticket, found by the poller in `prs.ts`.
   *
   * Its own table rather than an array on the ticket: a document's array is
   * rewritten whole on every update and grows unbounded, where an upsert keyed
   * by `by_repo_and_prNumber` touches one row — which matters when the poller
   * re-sees every open PR every fifteen minutes.
   */
  ticketPrs: defineTable({
    ticketId: v.id("feedback"),
    repo: v.string(),
    prNumber: v.number(),
    title: v.string(),
    url: v.string(),
    /** GitHub reports draft separately from open, and merged as a closed PR
     *  carrying `merged_at`; this flattens all four into one state. */
    state: v.union(
      v.literal("draft"),
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged"),
    ),
    mergedAt: v.optional(v.number()),
    /** Whether the agent opened it. Provenance is per-PR: a ticket can carry
     *  one of each. */
    agentFiled: v.boolean(),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_ticket", ["ticketId"])
    .index("by_repo_and_prNumber", ["repo", "prNumber"]),

  /**
   * One row per agent run — what it read, what it changed, and what broke.
   * The dashboard's Agent page is this table: without it a run that dies
   * halfway looks exactly like a quiet night.
   */
  agentRuns: defineTable({
    kind: v.union(v.literal("triage"), v.literal("implement")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    status: v.union(
      v.literal("running"),
      v.literal("ok"),
      v.literal("failed"),
    ),
    ticketsRead: v.number(),
    duplicatesLinked: v.number(),
    scored: v.number(),
    prsFiled: v.number(),
    /** Capped by the writer; a run that fails a hundred ways says so in ten. */
    errors: v.array(v.string()),
    notes: v.optional(v.string()),
  }).index("by_startedAt", ["startedAt"]),

  /**
   * The agent's knobs, as one row. They live in the database — visible and
   * changeable from the dashboard — rather than inside a prompt, because the
   * queue queries read them and the queue is where the rules are enforced.
   */
  opsConfig: defineTable({
    /** Master switch. Off means the queues return nothing at all. */
    agentEnabled: v.boolean(),
    /** Off means triage-only: score and dedupe, write no code. */
    implementEnabled: v.boolean(),
    maxPerRun: v.number(),
    /** How long a ticket is left alone, so the operator gets first look. */
    coolingHours: v.number(),
    /** Minimum `triageScore` before a ticket is worth implementing. */
    scoreThreshold: v.number(),
  }),

  /**
   * Monotonic counters, one row per name. Convex has no sequence type and no
   * count operator, so a number that must never repeat is read, incremented and
   * written inside the same mutation — a transaction, so concurrent submits
   * retry rather than collide.
   */
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  /**
   * Sessions for the operator dashboard (nootles-ops). Its login is a single
   * username/password held in deployment env vars — Clerk's multi-domain
   * tier isn't available, and one operator does not need an identity system.
   */
  adminSessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index("by_token", ["token"]),

  /**
   * Micro-survey answers (PMF question, dismiss-reason sampler). Append-only;
   * "has any row" is what stops a survey being shown twice.
   */
  surveyResponses: defineTable({
    ownerId: v.string(),
    survey: v.union(v.literal("pmf"), v.literal("dismiss_reason")),
    answer: v.optional(v.string()),
    dismissed: v.boolean(),
    createdAt: v.number(),
  }).index("by_owner_survey", ["ownerId", "survey"]),

  /** Per-project evolving Q&A that primes every LLM request. */
  contextSheet: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    question: v.string(),
    answer: v.optional(v.string()),
    // AI-generated vs user-added.
    source: v.union(v.literal("human"), v.literal("ai")),
    createdAt: v.number(),
  }).index("by_project", ["projectId"]),

  // ---- GitHub -------------------------------------------------------------

  /**
   * One personal access token per account — the whole of the GitHub setup.
   *
   * A token rather than an App because a token is the only thing that works in
   * somebody else's organisation without an owner installing anything: a classic
   * one authorised for SSO, or a fine-grained one where the org allows them.
   *
   * The token is stored SEALED (`github/seal.ts`) and never leaves the server:
   * every field a client can read is here beside it, and the token itself is
   * only ever opened inside an action that is about to call GitHub.
   */
  githubAccounts: defineTable({
    ownerId: v.string(),
    /** AES-GCM ciphertext. Opening it needs the deployment's GITHUB_TOKEN_KEY. */
    sealed: v.string(),
    /** The GitHub login the token authenticates as, read from /user at connect. */
    login: v.string(),
    /** Last four characters, so a stored token is recognisable but not readable. */
    hint: v.string(),
    kind: v.union(v.literal("classic"), v.literal("fine-grained")),
    /**
     * Classic tokens report their scopes in a response header; fine-grained ones
     * report nothing, which is why this is optional rather than empty.
     */
    scopes: v.optional(v.array(v.string())),
    /** Organisations the token can actually see — the SSO check, made concrete. */
    orgs: v.optional(v.array(v.string())),
    connectedAt: v.number(),
    /**
     * Stamped when GitHub last answered 401. A dead token is kept rather than
     * deleted so the UI can say "reconnect" instead of silently forgetting.
     */
    invalidAt: v.optional(v.number()),
  }).index("by_owner", ["ownerId"]),

  /**
   * A repository linked to a project. Part of the Context Sheet in spirit: the
   * summary below is read into every prompt, and the agent reads the rest of the
   * repo through tools that check this table for permission first.
   */
  projectRepos: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    fullName: v.string(),
    defaultBranch: v.string(),
    description: v.optional(v.string()),
    private: v.boolean(),
    /**
     * The standing note: what the repo is, its top level, and the head of its
     * README. Capped and refreshed on demand — enough for the agent to know the
     * repo is worth opening, never a substitute for opening it.
     */
    summary: v.optional(v.string()),
    syncedAt: v.optional(v.number()),
    /** Why the last refresh failed, shown on the row rather than swallowed. */
    syncError: v.optional(v.string()),
    addedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    // The permission check every repo tool makes, and the guard against linking
    // the same repo twice.
    .index("by_project_and_fullName", ["projectId", "fullName"]),

  /**
   * A file uploaded as project context — the other kind of read-not-written
   * context beside a repository. The bytes live in storage; what the agent
   * reads is the text extracted from them once, at upload, so a PDF costs its
   * parse one time rather than on every prompt.
   */
  projectFiles: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    storageId: v.id("_storage"),
    filename: v.string(),
    mediaType: v.string(),
    /** Bytes as uploaded, for the row's second line. */
    size: v.number(),
    /**
     * The extracted text, capped. The head of it is read into every prompt the
     * way a repo's summary is; the whole of it is what read_context_file
     * returns. Absent while extraction is still running.
     */
    text: v.optional(v.string()),
    /** Characters the extraction found before the cap, so a cut can say so. */
    fullChars: v.optional(v.number()),
    syncedAt: v.optional(v.number()),
    /** Why extraction failed, shown on the row rather than swallowed. */
    syncError: v.optional(v.string()),
    addedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    // The permission check the file tool makes, and how re-uploading a file of
    // the same name replaces it instead of doubling it.
    .index("by_project_and_filename", ["projectId", "filename"]),

  // ---- Chat ---------------------------------------------------------------

  /**
   * A conversation. Scoped to the PROJECT rather than the page: a thread
   * outlives switching pages, and the agent can work across several of them in
   * one turn. The open page travels with each message instead.
   */
  chatThreads: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    title: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_project", ["projectId", "updatedAt"]),

  chatMessages: defineTable({
    ownerId: v.string(),
    threadId: v.id("chatThreads"),
    /** The AI SDK's own message id, so a resend can be made idempotent. */
    uiId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system")),
    /** Position in the thread; the sort key, because timestamps can collide. */
    seq: v.number(),
    /**
     * `UIMessage.parts` stored VERBATIM. Tool calls and their results are
     * already parts, so a reloaded thread re-renders exactly as it streamed and
     * `convertToModelMessages` round-trips it back to the model without a
     * bespoke translation layer to keep in sync.
     */
    parts: v.any(),
    metadata: v.optional(v.any()),
    /** Links a turn to its checkpoints and op-log rows. */
    chatPromptId: v.optional(v.string()),
    /** Which page was open when this was sent — resolves "@current-page". */
    pageIdAtSend: v.optional(v.id("pages")),
    /**
     * Attachment sidecar. The storage id is the durable reference; URLs are
     * re-derived on read, never persisted, because they expire.
     */
    attachments: v.optional(
      v.array(
        v.object({
          storageId: v.id("_storage"),
          partIndex: v.number(),
          mediaType: v.string(),
          filename: v.optional(v.string()),
        }),
      ),
    ),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "seq"])
    // The upsert's lookup: `put` is keyed on the SDK's message id, and reading
    // the whole transcript to find one row is what it cost without this.
    .index("by_thread_and_uiId", ["threadId", "uiId"]),

  /**
   * One agent turn that touched the document, and where its review stands.
   *
   * `status: "pending"` IS "still under review", so reloading mid-review
   * rehydrates the diff rather than stranding the document with changes the
   * user never accepted. The trace records what each op actually did — resolved
   * anchors and the ids it produced — so rejecting a hunk can replay effects
   * deterministically instead of re-minting ids.
   */
  chatTurns: defineTable({
    ownerId: v.string(),
    threadId: v.id("chatThreads"),
    projectId: v.id("projects"),
    chatPromptId: v.string(),
    /** Pages this turn edited; one checkpoint each, taken on first edit. */
    pageIds: v.array(v.id("pages")),
    checkpointIds: v.array(v.id("checkpoints")),
    trace: v.any(),
    hunks: v.any(),
    status: v.union(
      v.literal("streaming"),
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("rejected"),
      v.literal("failed"),
    ),
    /** Set when the user restored the pre-turn checkpoint — a whole-turn no. */
    rewoundAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_prompt", ["chatPromptId"])
    // Review outlives the conversation it came from: a reload has to find every
    // turn still awaiting an answer without knowing which thread asked.
    .index("by_project_status", ["projectId", "status"]),
});
