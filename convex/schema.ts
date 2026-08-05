import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Nootles data model — bounded, non-recursive hierarchy:
 *   Project → Page → Block[text|canvas] → (canvas) Shape → {text, image}
 *
 * Text/block *content* is synced separately via @convex-dev/prosemirror-sync
 * (step-based). This schema holds the structural tree, the freeform canvas
 * shapes (high-frequency, kept out of the PM doc), and the AI substrate tables
 * (operation log, checkpoints, context sheet).
 *
 * v0 tenancy is single-user: every top-level row carries `ownerId`.
 */

// A 2D point / size used across shapes.
const vec2 = v.object({ x: v.number(), y: v.number() });

export default defineSchema({
  projects: defineTable({
    ownerId: v.string(),
    title: v.string(),
    // Optional short description that seeds the Context Sheet.
    description: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),

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
    // Manual ordering within the project sidebar.
    order: v.number(),
    // prosemirror-sync document id for this page's block flow.
    docId: v.string(),
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

  /**
   * Canvas blocks. A page's text blocks live inside the prosemirror-sync doc;
   * a *canvas* block is represented in the doc as a void node holding this
   * canvasId, and its shapes/edges live in the tables below (reactive, cheap
   * to mutate at drag frequency).
   */
  canvases: defineTable({
    ownerId: v.string(),
    pageId: v.id("pages"),
    // Stable id referenced by the void node inside the PM doc.
    blockId: v.string(),
    createdAt: v.number(),
  })
    .index("by_page", ["pageId"])
    .index("by_block", ["blockId"]),

  shapes: defineTable({
    ownerId: v.string(),
    canvasId: v.id("canvases"),
    kind: v.union(
      v.literal("rectangle"),
      v.literal("ellipse"),
      v.literal("diamond"),
      v.literal("node"), // generic diagram node
      v.literal("image"),
    ),
    position: vec2,
    size: vec2,
    // Rich text shown inside the shape (reuses the block text editor).
    // Stored as BlockNote/PM JSON; null for pure-image shapes.
    text: v.optional(v.any()),
    // Convex storage id when kind === "image".
    storageId: v.optional(v.id("_storage")),
    style: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_canvas", ["canvasId"]),

  edges: defineTable({
    ownerId: v.string(),
    canvasId: v.id("canvases"),
    source: v.id("shapes"),
    target: v.id("shapes"),
    label: v.optional(v.string()),
    style: v.optional(v.any()),
  }).index("by_canvas", ["canvasId"]),

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
    // Snapshot of the PM doc + shapes/edges at this point in time.
    docSnapshot: v.any(),
    canvasSnapshot: v.any(),
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
    status: v.union(v.literal("new"), v.literal("seen"), v.literal("done")),
    createdAt: v.number(),
  })
    .index("by_status", ["status", "createdAt"])
    .index("by_owner", ["ownerId", "createdAt"]),

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
  }).index("by_thread", ["threadId", "seq"]),

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
