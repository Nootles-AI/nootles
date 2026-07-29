import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * auto-board data model — bounded, non-recursive hierarchy:
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
    createdAt: v.number(),
  }).index("by_page", ["pageId", "createdAt"]),

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
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_prompt", ["chatPromptId"])
    // Review outlives the conversation it came from: a reload has to find every
    // turn still awaiting an answer without knowing which thread asked.
    .index("by_project_status", ["projectId", "status"]),
});
