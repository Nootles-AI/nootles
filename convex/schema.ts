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
 * created it. A project lives in a container: its creator's account, or a
 * workspace (`projects.workspaceId`), whose members reach it by their seat.
 * Access beyond that is granted per project through share links and the
 * claims they leave behind (`shareClaims`); resolution lives in `auth.ts`,
 * never at call sites.
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
 * done; declined ends a wish that won't be built.
 *
 * Every rung is now moved by a person or by the agent reporting on itself.
 * There used to be a sixth, `pr_filed`, which nothing here set — a GitHub poll
 * did, on noticing a pull request whose title named the ticket. That link is
 * gone, and with it the only status this ladder did not own.
 */
export const feedbackStatus = v.union(
  v.literal("new"),
  v.literal("seen"),
  v.literal("in_progress"),
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
  v.object({
    kind: v.literal("icon"),
    name: v.string(),
    /**
     * The glyph's own path data, carried with the choice.
     *
     * The catalog it came from is a lazily-loaded 664KB, and a sidebar draws
     * every row's icon at once — so resolving a name against that catalog
     * would drag it into the shell for every page that has an icon at all.
     * The path is a few hundred bytes and makes the row self-contained: it
     * draws on a share route, and it survives the catalog being recurated.
     *
     * Optional because the name is the identity; a row without it falls back
     * to the default glyph rather than to nothing.
     */
    d: v.optional(v.string()),
    /** The box `d` is drawn in. Absent means the catalog's own 256. */
    box: v.optional(v.number()),
  }),
  v.object({
    kind: v.literal("image"),
    storageId: v.id("_storage"),
    /**
     * The permanent bearer URL, kept beside the id for the same reason albums
     * keep theirs: a sidebar draws every row's icon at once, and a shared page
     * has no signed-in identity to resolve a storage id with. The id stays so
     * the file can still be found when the icon is replaced.
     */
    url: v.string(),
  }),
);

export const repoRef = v.object({
  /** "owner/name", the way GitHub writes it and the way the agent names it. */
  fullName: v.string(),
  defaultBranch: v.string(),
  description: v.optional(v.string()),
  private: v.boolean(),
  /**
   * The GitHub App installation that reads it, for a workspace project's
   * repository chosen from the workspace's installations. Absent is read with
   * the linker's own connection.
   */
  installationId: v.optional(v.number()),
});

/** A seat in a workspace, highest first. `auth.ts` ranks them. */
export const memberRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("guest"),
);

/** What an invitation can hand out: ownership is given by an owner, never by mail. */
export const invitedRole = v.union(
  v.literal("admin"),
  v.literal("member"),
  v.literal("guest"),
);

export const workspaceSettings = v.object({
  /** Whether projects here may have share links at all. Default on. */
  linkSharing: v.boolean(),
  /** Whether a guest may be granted the repository half of a project's context. Default off. */
  guestCodeAccess: v.boolean(),
  /** Email domains an admin has proved they hold, lowercased. */
  joinDomains: v.array(v.string()),
  /** A signed-in address on a join domain joins without an invitation. */
  autoJoin: v.boolean(),
  /** A GitHub organisation every non-guest must belong to, when set. */
  requireGithubOrg: v.optional(v.string()),
  /**
   * Whether a repository may be linked, and read, with a member's own GitHub
   * connection rather than the workspace's App. Absent is allowed, so nothing
   * linked before the App was installed stops working (docs/github-app.md).
   */
  allowPersonalTokens: v.optional(v.boolean()),
  /** The expiry a new share link starts with, in days. Absent is no expiry. */
  linkTtlDays: v.optional(v.number()),
});

export default defineSchema({
  /**
   * A team's home for projects, beside the personal account. The row is read
   * for settings and naming only — never on a document's access path (see
   * `auth.ts`), so an admin editing a setting does not re-run every open
   * document subscription in the workspace.
   */
  workspaces: defineTable({
    /** The current slug, mirrored from `workspaceSlugs` for display. */
    slug: v.string(),
    name: v.string(),
    /** Clerk subject of whoever made it. */
    createdBy: v.string(),
    plan: v.union(v.literal("team"), v.literal("enterprise")),
    settings: workspaceSettings,
    createdAt: v.number(),
    /**
     * Soft delete. The deleting mutation also trashes every project and
     * retires every membership, so nothing downstream has to read this.
     */
    deletedAt: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

  /**
   * Every slug a workspace has answered to. The current one has no
   * `retiredAt`; old ones stay so `/w/<old>` keeps redirecting and no other
   * workspace can claim a name that still has links pointing at it.
   */
  workspaceSlugs: defineTable({
    slug: v.string(),
    workspaceId: v.id("workspaces"),
    retiredAt: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

  /**
   * One row per person per workspace, reused rather than appended to: leaving
   * and coming back reactivates the row. Removal is a status, not a delete, so
   * the record of who was here survives them.
   */
  memberships: defineTable({
    workspaceId: v.id("workspaces"),
    /** Clerk subject. */
    userId: v.string(),
    role: memberRole,
    status: v.union(v.literal("active"), v.literal("removed")),
    invitedBy: v.optional(v.string()),
    joinedAt: v.number(),
    removedAt: v.optional(v.number()),
    /**
     * Who took the seat away: the person themselves when they left. Someone
     * an admin removed does not walk back in through a join domain; it takes
     * a fresh invitation.
     */
    removedBy: v.optional(v.string()),
    /**
     * When the GitHub organisation rule last passed for this person — by their
     * own check, or the nightly one (`github/orgProof.recheck`).
     */
    githubOrgVerifiedAt: v.optional(v.number()),
    /**
     * Who this person is on GitHub, as their own connection's `GET /user`
     * said: the login the App asks the organisation about, every night, and
     * the organisation's webhook names when it leaves. Kept when the rule
     * fails, so the nightly check lets them in once the organisation does.
     */
    githubOrgLogin: v.optional(v.string()),
    /** The same account's numeric id, which a rename leaves alone. */
    githubUserId: v.optional(v.number()),
  })
    .index("by_workspace_user", ["workspaceId", "userId"])
    .index("by_user_status", ["userId", "status"])
    .index("by_workspace_status_role", ["workspaceId", "status", "role"]),

  /**
   * An email address asked in. The token is the capability; the address is
   * what binds it to one person — accepting needs a verified identity with
   * that email, so a forwarded link is worth nothing to anyone else.
   */
  invitations: defineTable({
    workspaceId: v.id("workspaces"),
    /** Lowercased. */
    email: v.string(),
    role: invitedRole,
    token: v.string(),
    invitedBy: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_workspace", ["workspaceId"])
    .index("by_email", ["email"]),

  /**
   * `settings.joinDomains`, one row per domain, so someone signing in can find
   * the workspaces their address may join without reading every workspace.
   * Written in the same mutation as the settings it mirrors.
   */
  workspaceDomains: defineTable({
    domain: v.string(),
    workspaceId: v.id("workspaces"),
  })
    .index("by_domain", ["domain"])
    .index("by_workspace", ["workspaceId"]),

  /**
   * One feature, decided for one workspace against its plan (`plans.ts`) —
   * what sales promised one customer, or a tester's plan without a card
   * (`feature: "plan"`). Most workspaces have none. One row per feature,
   * replaced rather than appended to; expired rows are ignored, not deleted.
   */
  workspaceEntitlements: defineTable({
    workspaceId: v.id("workspaces"),
    /** A key of `Features`, or "plan". */
    feature: v.string(),
    value: v.union(v.boolean(), v.number(), v.string()),
    /** Why, and who asked — required, as a VIP note is. */
    note: v.string(),
    /** The operator session that set it, or "convex run". */
    grantedBy: v.string(),
    grantedAt: v.number(),
    expiresAt: v.optional(v.number()),
  }).index("by_workspace_and_feature", ["workspaceId", "feature"]),

  /**
   * A workspace's Team subscription as Stripe last reported it: one customer
   * per workspace, never a member's own, and one subscription with two items,
   * seats and metered AI usage. Instants are milliseconds, unlike the personal
   * mirror's verbatim seconds. Written when the customer is made, before
   * anything is bought (`teamBilling.ts`).
   */
  workspaceBilling: defineTable({
    workspaceId: v.id("workspaces"),
    stripeCustomerId: v.string(),
    subscriptionId: v.optional(v.string()),
    seatItemId: v.optional(v.string()),
    usageItemId: v.optional(v.string()),
    /**
     * Stripe's own status word, stored verbatim — see `entitlements.ts` — or
     * "none" while the customer has no subscription.
     */
    status: v.string(),
    /** The seat quantity last pushed to Stripe. */
    seats: v.number(),
    /** Zero while there is no subscription. */
    periodStart: v.number(),
    periodEnd: v.number(),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    /** AI spend included in the period before usage is billed, in dollars. */
    aiAllowanceUsd: v.number(),
    /** Signed spend up to here has been reported as usage. */
    usageReportedThrough: v.optional(v.number()),
    /**
     * The period that reported spend was counted in: its bounds, its
     * allowance, the signed spend up to `usageReportedThrough`, and the cents
     * of overage already sent. Kept apart from `periodStart` so the report
     * after a renewal can still finish the period before it.
     */
    usagePeriod: v.optional(
      v.object({
        start: v.number(),
        end: v.number(),
        allowanceUsd: v.number(),
        spentUsd: v.number(),
        reportedCents: v.number(),
      }),
    ),
    /**
     * A usage report counted here and not yet acknowledged by Stripe. It is
     * sent again under the same identifier, never recounted, so a retry
     * cannot bill the same spend twice.
     */
    pendingUsage: v.optional(v.object({ identifier: v.string(), cents: v.number() })),
    /** A seat sync is scheduled; membership changes until it runs ride along. */
    seatSyncPending: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_customer", ["stripeCustomerId"])
    .index("by_subscription", ["subscriptionId"]),

  /**
   * A workspace's free allowance while it has no live plan: `FREE_LIMITS`,
   * counted once for the whole workspace rather than per person. Its own table
   * rather than a field on the workspace, which every settings screen reads.
   * Projects are counted live, as an account's are.
   */
  workspaceMeters: defineTable({
    workspaceId: v.id("workspaces"),
    acceptedCompletions: v.number(),
    chatConversations: v.number(),
    createdAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * What someone without a paid seat — a guest, or anyone an editor link let
   * in — spent of a workspace's AI in one UTC day, from signed ledger rows.
   * The guest cap reads one row here rather than summing a day of calls on the
   * path of every completion. `userId`, not `ownerId`, so the row stays out of
   * `auth.ts`'s owned tables.
   */
  guestAiSpend: defineTable({
    workspaceId: v.id("workspaces"),
    /** `YYYY-MM-DD`, UTC (`plans.utcDay`). */
    day: v.string(),
    userId: v.string(),
    costUsd: v.number(),
  }).index("by_workspace_and_day_and_user", ["workspaceId", "day", "userId"]),

  /**
   * What one person spent of a workspace's AI in one billing period, from
   * signed ledger rows, split by whether they held a seat when they spent it.
   * Kept as calls are recorded so the billing screen reads a row per person
   * rather than a period of calls; a row per person, not per workspace, so
   * two people's calls never contend for one document. The nightly report
   * still sums the ledger itself (`teamBilling.signedSpend`) — this is the
   * screen's figure, not the bill.
   */
  workspaceSpend: defineTable({
    workspaceId: v.id("workspaces"),
    /** `workspaceBilling.periodStart` when the spend was recorded. */
    periodStart: v.number(),
    userId: v.string(),
    seatUsd: v.number(),
    guestUsd: v.number(),
  }).index("by_workspace_and_period_and_user", ["workspaceId", "periodStart", "userId"]),

  projects: defineTable({
    /**
     * The creator. In a personal project that is also the owner; in a
     * workspace project it confers nothing — who may manage it is the
     * workspace's answer (`auth.ts`).
     */
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
     * When each link stops admitting anyone; absent is never. Past it the
     * link reads as off, and so does every claim made through it.
     */
    shareExpiresAt: v.optional(v.number()),
    editShareExpiresAt: v.optional(v.number()),
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
    /**
     * Soft delete — set is deleted, absent is live. Every read treats a
     * stamped row as missing (`auth.ts` centrally, list queries locally);
     * `trash.restore` clears it, and a cron purges rows past retention with
     * the old hard cascade. What this buys is an undo for the one class of
     * action that used to be irreversible.
     */
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
    /** The workspace this project lives in. Absent is a personal project. */
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * Who in the workspace sees it: every member (absent or "workspace"), or
     * only its admins and its creator ("private"). Meaningless on a personal
     * project.
     */
    visibility: v.optional(v.union(v.literal("workspace"), v.literal("private"))),
  })
    .index("by_owner", ["ownerId"])
    // Someone's live personal projects are the prefix (ownerId, no workspace,
    // no deletedAt): the free limit counts them and the projects screen lists
    // them, and neither may cut before it filters.
    .index("by_owner_and_workspace_and_deleted", ["ownerId", "workspaceId", "deletedAt"])
    .index("by_share_token", ["shareToken"])
    .index("by_edit_share_token", ["editShareToken"])
    .index("by_deleted", ["deletedAt"])
    .index("by_workspace", ["workspaceId"])
    // A workspace's live projects, for its free limit — filtered before the
    // cut, as an account's are.
    .index("by_workspace_and_deleted", ["workspaceId", "deletedAt"]),

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
    /**
     * The expiry of the link this claim came through, carried so a claim
     * outlives neither it nor a new link turned on after it ran out. Absent
     * is never. `grantedRole` does not expire: it was handed over by name.
     */
    expiresAt: v.optional(v.number()),
    /**
     * A workspace guest let into the repository half of the project's
     * context, by one of its managers, while the workspace allows it.
     */
    codeAccess: v.optional(v.boolean()),
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
   *
   * A workspace project's requests are answered by any of its admins, not
   * by its creator, so they carry `workspaceId` for the same one-read inbox.
   */
  accessRequests: defineTable({
    projectId: v.id("projects"),
    /** The Clerk subject asking, always derived server-side. */
    requesterId: v.string(),
    projectOwnerId: v.string(),
    workspaceId: v.optional(v.id("workspaces")),
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
    .index("by_requester_and_status", ["requesterId", "status"])
    .index("by_workspace_and_status", ["workspaceId", "status"]),

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
     * Copied from `identities` — when the row is made, and by every stamp
     * after — never from the client, so the operator dashboard can put a
     * face to an id. The last address Clerk vouched for, kept for the face
     * after the stamp itself lapses; people lists read `profiles.personOf`,
     * which prefers the source.
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
   * What the sign-in provider vouches for about an account, written only by
   * `identity.sync` and the Clerk webhook — from the session token when it
   * carries the claims, or else from Clerk's Backend API — and never from
   * anything a client sends.
   *
   * Beside `profiles` rather than on it, because a profile row's absence is
   * first run's signal and nothing may create one speculatively, while an
   * invitation's very first visit has to confirm an address before any
   * profile exists.
   */
  identities: defineTable({
    ownerId: v.string(),
    /** Lowercased. Only ever a primary address the provider marks verified. */
    verifiedEmail: v.optional(v.string()),
    /** When Clerk last vouched for it; `identity.expire` lapses it past `STAMP_MAX_AGE_MS`. */
    verifiedEmailAt: v.optional(v.number()),
    /** When Clerk was last asked, answered or not; `identity.sync`'s throttle. */
    checkedAt: v.optional(v.number()),
    /** When a source last answered, even with no address; unset, nobody has. */
    answeredAt: v.optional(v.number()),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_verifiedEmailAt", ["verifiedEmailAt"]),

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
    /** Soft delete — see `projects.deletedAt`. */
    deletedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_project", ["projectId", "order"])
    .index("by_deleted", ["deletedAt"]),

  pages: defineTable({
    ownerId: v.string(),
    /**
     * Who made the page. `ownerId` is the project's owner — a page an editor
     * creates still belongs to the project — so it cannot say whose page this
     * is. Absent on pages made before it existed and on seeded ones; readers
     * fall back to `ownerId`.
     */
    createdBy: v.optional(v.string()),
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
    /** Soft delete — see `projects.deletedAt`. */
    deletedAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId", "order"])
    .index("by_doc", ["docId"])
    .index("by_deleted", ["deletedAt"]),

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
   * The top of a document as blocks, kept so a thumbnail is one small read.
   *
   * Without it a card on the projects screen has to open the document to draw
   * it: `meta`, the snapshot, the log behind it, a Y.Doc rebuilt in the
   * browser and BlockNote imported to read it — several round trips in a row,
   * per card, for a picture of a page nobody has touched since yesterday.
   *
   * Written by the CLIENT, because turning a Y.Doc into blocks needs the
   * BlockNote schema and that is a browser bundle (see `projects.listForScreen`).
   * The sync provider writes it behind its own flushes, so every Yjs writer
   * keeps it current without knowing it exists. Derived and disposable: a
   * missing row just means the card reads the document the old way and leaves
   * a row behind for next time.
   *
   * Its own table rather than a field on `pages` or `ydocs`: it churns with
   * the content, and those rows sit in the read set of queries that should
   * not re-run because a heading changed.
   */
  pagePreviews: defineTable({
    docId: v.string(),
    /** JSON of the document's first blocks — see `app/lib/sync/pagePreview.ts`. */
    blocks: v.string(),
    /**
     * The `ydocs.seq` the blocks were read at. Two writers can race — an
     * editor and a card backfilling from an older read — and the higher seq
     * is the one that saw more of the document.
     */
    seq: v.number(),
    updatedAt: v.number(),
  }).index("by_doc", ["docId"]),

  // ---- NML persistence & cohort migration (step 12) -----------------------
  // The elected migrator writes the canonical NML root into a page's Y.Doc
  // beside its ProseMirror root; these tables record that it happened, gate
  // which docs are eligible, and keep the NML content recoverable across a
  // rollback. The legacy root stays the served truth until step 13, so a
  // rollback here is authority + audit only — the NML root is never removed
  // (Yjs roots are permanent), which is exactly what keeps NML-only edits the
  // legacy tree cannot represent from being lost.

  /**
   * One row per document that has had its NML root written. Its presence is the
   * election record — the first writer inserts it, and a second migrator sees
   * it and stands down rather than racing a duplicate root.
   */
  nmlDocState: defineTable({
    docId: v.string(),
    /**
     * "migrated": the NML root exists and its migrator's checks passed.
     * "rolledBack": authority was returned to legacy; the root still exists.
     */
    status: v.union(v.literal("migrated"), v.literal("rolledBack")),
    /** Canonical AST schema version the root declares (for mixed-version reads). */
    nmlSchemaVersion: v.number(),
    /** Yjs encoding version the root declares (for mixed-version reads). */
    nmlEncodingVersion: v.number(),
    /** The append seq that introduced the NML root, for audit. */
    nmlSeq: v.number(),
    /** The migrator's equivalence verdict over structure, IDs, inline, canvas. */
    equivalenceOk: v.boolean(),
    /** Understood, acceptable mismatch classes (e.g. an unsupported-block gap). */
    mismatchClasses: v.array(v.string()),
    /** Whether the document was within the four v1 size limits. */
    limitOk: v.boolean(),
    migratedAt: v.number(),
    /** Clerk subject of the elected migrator, or "anonymous" for a link editor. */
    migratedBy: v.string(),
    /**
     * Step 13's independent server-side re-assertion of the persisted root,
     * distinct from the client's `equivalenceOk`/`limitOk` claim above. The
     * backend decodes the stored `nml` root and re-runs `validateDocument`;
     * authority moves to NML only once `serverVerified` is true. Optional so
     * rows written before verification (or before this field existed) read as
     * "not yet verified". All content-free.
     */
    serverVerified: v.optional(v.boolean()),
    serverVerifiedAt: v.optional(v.number()),
    /** Declared versions the server actually decoded (may differ from the claim). */
    serverSchemaVersion: v.optional(v.number()),
    serverEncodingVersion: v.optional(v.number()),
    /** Content-free failure classification when `serverVerified` is false. */
    serverVerifyError: v.optional(v.string()),
    rolledBackAt: v.optional(v.number()),
    rollbackReason: v.optional(v.string()),
    /** True when rollback found NML-only edits the legacy tree cannot reproduce. */
    rolledBackDiverged: v.optional(v.boolean()),
  }).index("by_doc", ["docId"]),

  /**
   * The migration cohort: which documents are eligible to be migrated. Scoped
   * by project (opt a whole project in, owner-gated) or by single doc (writer-
   * gated). The migrator refuses any document not covered by a row here.
   */
  nmlCohorts: defineTable({
    scope: v.union(v.literal("project"), v.literal("doc")),
    /** A projectId or docId as a string, by scope. */
    key: v.string(),
    addedAt: v.number(),
    addedBy: v.string(),
  }).index("by_scope_and_key", ["scope", "key"]),

  /**
   * The internal-owner allowlist: Clerk subjects whose documents are eligible to
   * migrate to NML — the "internal docs" class the founding team dogfoods, and
   * (later) the set an agent may reach over MCP. Membership makes ALL of a
   * subject's documents eligible, current and future, without per-project or
   * per-doc enrollment in `nmlCohorts` — an additional eligibility source beside
   * it, not a replacement.
   *
   * Eligibility keyed here is OWNED-ONLY: a document counts as internal iff its
   * page owner is listed, never because a listed member can edit someone else's
   * shared doc. This is an infrastructure control, not a user-facing feature —
   * an operator manages it through the internal `addInternalOwner` /
   * `removeInternalOwner` functions (deploy-authenticated, never a public
   * mutation), so nothing an end user can call widens the agent's reach.
   */
  internalOwners: defineTable({
    /** The internal owner's Clerk subject. */
    subject: v.string(),
    /** Who this is / why they're internal — operator-facing, free text. */
    note: v.optional(v.string()),
    addedAt: v.number(),
  }).index("by_subject", ["subject"]),

  /**
   * The master serve switch: whether the app may serve the canonical NML tree at
   * all. A single-row table rather than a `NEXT_PUBLIC_*` build flag, so an
   * operator flips it live in prod with `setNmlServe` (`convex run`) — reactively,
   * with no Vercel change or rebuild — which makes it a real instant kill switch:
   * turning it off remounts every served editor back onto legacy on the next
   * query tick. Off (an absent row) by default. Peer of the per-doc `nmlDocState`:
   * this says "serving is on", that says "this doc is individually cleared".
   */
  nmlServeState: defineTable({
    enabled: v.boolean(),
    updatedAt: v.number(),
  }),

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
   * What a photograph in an album looks like, so the agent does not have to be
   * shown the photograph to know.
   *
   * Keyed by the picture's storage URL rather than by the block holding it,
   * because the subject is the PICTURE: one used in two albums is indexed once,
   * a reordered album needs no rewrite, and copying a moodboard into another
   * document brings its index along. Derived data, so it is deliberately not in
   * the document — an album's markup stays what a person authored, and the
   * round trip that the AI edits diagrams and albums through stays exact.
   *
   * Two tiers in one row. The colour columns are computed in the browser at
   * upload from the canvas the re-encode already drew (free, no model), and are
   * enough on their own to answer anything about palette or spread. `alt` and
   * `striking` come from one cheap vision call over a contact sheet, written
   * the first time an agent expands the album and kept forever after.
   */
  imageMeta: defineTable({
    ownerId: v.string(),
    src: v.string(),
    hex: v.string(),
    palette: v.array(v.string()),
    hue: v.number(),
    sat: v.number(),
    light: v.number(),
    /**
     * Absent, not zero, when nobody measured it: a picture fetched from the web
     * never passed through a canvas here, so its colours come from what the
     * provider published and its contrast was never seen. Zero would read as
     * "measured, and utterly flat", which is a different and false claim.
     */
    energy: v.optional(v.number()),
    /** ---- Written by the captioning pass, which may never run. ---- */
    alt: v.optional(v.string()),
    striking: v.optional(v.number()),
    indexedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_owner_and_src", ["ownerId", "src"]),

  /**
   * Pictures `find_images` has found, waiting to be added to an album.
   *
   * The `drawings` pattern, for the same reason and one more. A tool result
   * carries refs rather than URLs so the model never handles a URL it could
   * mistype or invent — and because the row is the only place an `add` op's
   * source can come from, the server fetches bytes exclusively from an address
   * IT minted. That is the whole SSRF story: there is no path by which a URL
   * the model wrote reaches a fetch.
   */
  foundImages: defineTable({
    ownerId: v.string(),
    ref: v.string(),
    url: v.string(),
    w: v.number(),
    h: v.number(),
    alt: v.string(),
    hex: v.string(),
    /** Photographer and source, which the licence requires travel with the picture. */
    credit: v.string(),
    /** The provider's download-report endpoint, pinged when the picture is kept. */
    report: v.optional(v.string()),
    createdAt: v.number(),
  })
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
      v.literal("album"),
      v.literal("context"),
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
    /**
     * The workspace whose allowance the call spent, resolved from the project
     * it was made in (`entitlements.containerFor`) — never taken from the
     * request. Absent is the caller's own account.
     */
    workspaceId: v.optional(v.id("workspaces")),
    /**
     * The Next server vouched for this row with `AI_LEDGER_SECRET`
     * (`ai/callSignature.ts`). Absent is unsigned — written before signing,
     * on a deployment without the secret, or by anyone calling the mutation
     * directly — and an unsigned row is never billed or counted against a
     * cap, whatever cost it claims.
     */
    signed: v.optional(v.boolean()),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId", "createdAt"])
    .index("by_feature", ["feature", "createdAt"])
    .index("by_workspace_and_createdAt", ["workspaceId", "createdAt"])
    .index("by_workspace_and_ownerId_and_createdAt", ["workspaceId", "ownerId", "createdAt"]),

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
   * Every time an operator stood in for a user. Written before the token is
   * signed, so a row exists even if the mint then fails — the log is of what
   * was ASKED for, which is the question an audit actually has.
   *
   * There is no `revokedAt`: the token is verified by signature alone and
   * never touches this table, so nothing here could stop one. Expiry is the
   * whole revocation story, which is why the window is short.
   */
  impersonations: defineTable({
    /** Which operator session asked. Deleting it ends future asks, not this one. */
    adminSessionId: v.id("adminSessions"),
    /** The Clerk subject stood in for. */
    subject: v.string(),
    /** Why — required, free text, and the only part a human writes. */
    reason: v.string(),
    issuedAt: v.number(),
    expiresAt: v.number(),
  }).index("by_subject", ["subject"]),

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

  // ---- Billing & entitlements ---------------------------------------------

  /**
   * What an account may do, and how much of the free allowance it has spent.
   *
   * One row per account, created lazily on the first thing that needs to be
   * counted — so its absence means "free, untouched" rather than an error, the
   * same way a missing `profiles` row means "new account".
   *
   * `vip` is the operator's override and outranks everything, including a
   * lapsed subscription: it is how a friend, an investor or a support case gets
   * in without money changing hands. It is written only from `adminBilling.ts`,
   * and `vipNote` is required there because an unexplained free account is
   * indistinguishable from a mistake six months later.
   *
   * The two counters are here rather than derived from `suggestionLog` and
   * `chatThreads` because both of those grow without bound and the meters are
   * read on the hot path of every completion. Projects are NOT counted here —
   * they are counted live off the `by_owner` index, since a stored count drifts
   * against trash and restore.
   */
  billingAccounts: defineTable({
    ownerId: v.string(),
    /** Operator override — a complete pass, outranking every other source. */
    vip: v.optional(v.boolean()),
    /** Why, in the operator's words. Required whenever `vip` is turned on. */
    vipNote: v.optional(v.string()),
    vipSetAt: v.optional(v.number()),
    /** Which operator session set it — the audit trail, as `impersonations` keeps one. */
    vipSetBy: v.optional(v.id("adminSessions")),
    /** Suggestions this account has ACCEPTED. Offers are free; keeping one is not. */
    acceptedCompletions: v.number(),
    /** Threads that have actually reached the model. See `chatThreads.billedAt`. */
    chatConversations: v.number(),
    /**
     * Where this account met the paywall, and what it did next.
     *
     * Recorded because the interesting number is not how many people pay, it
     * is how many were STOPPED and then did not — that difference is the only
     * evidence about whether the free run is too thin, too generous, or
     * stopping people at the wrong thing. Which wall it was matters for the
     * same reason: being cut off mid-conversation and running out of projects
     * are different arguments about the price.
     */
    walls: v.optional(
      v.object({
        firstAt: v.number(),
        lastAt: v.number(),
        /** How many times each wall was shown. */
        projects: v.number(),
        completions: v.number(),
        chats: v.number(),
      }),
    ),
    /**
     * When they last opened Stripe's checkout, and how many times. Set on the
     * way OUT to Stripe, so it counts intent rather than payment — an account
     * with a checkout and no subscription is somebody who looked at the price
     * and stopped, which is the most useful row on the whole dashboard.
     */
    checkoutAt: v.optional(v.number()),
    checkouts: v.optional(v.number()),
    /**
     * The Stripe customer, mirrored here so ops can reach a person's billing
     * without a round trip through the component's tables.
     */
    stripeCustomerId: v.optional(v.string()),
    /**
     * The subscription as Stripe last reported it, mirrored by the webhook.
     *
     * Mirrored rather than read live from the component on every access check:
     * this is consulted on the hot path of every completion, and a webhook that
     * is briefly behind is a far smaller problem than an entitlement read that
     * has to join another component's tables to answer at all. Absent = this
     * account has never subscribed.
     */
    subscription: v.optional(
      v.object({
        /** Stripe's own status word, stored verbatim — see `entitlements.ts`. */
        status: v.string(),
        interval: v.union(v.literal("month"), v.literal("year")),
        /**
         * Paid through this instant — in seconds, as Stripe sends it. A
         * cancellation still runs to here.
         */
        currentPeriodEnd: v.number(),
        cancelAtPeriodEnd: v.boolean(),
        priceId: v.string(),
        subscriptionId: v.string(),
        updatedAt: v.number(),
      }),
    ),
    createdAt: v.number(),
  }).index("by_owner", ["ownerId"]),

  /**
   * Codes that grant free access — the operator's way to let someone in
   * without a card. Deliberately NOT Stripe's promotion codes: those discount a
   * price, and this table is for the case where no money moves at all, which
   * Stripe has no representation for.
   *
   * Two independent lifetimes, which is the part worth reading twice:
   * `expiresAt` is when the CODE stops being redeemable, and `durationDays` is
   * how long the GRANT lasts once someone has redeemed it. A launch code can be
   * open for a week and grant a year; a reviewer code can be open forever and
   * grant a month.
   */
  accessCodes: defineTable({
    /** Uppercase and unique. Compared case-insensitively at redeem. */
    code: v.string(),
    /** What this code is for, in the operator's words — shown in ops only. */
    label: v.string(),
    /** How many people may redeem it; absent = unlimited. */
    maxRedemptions: v.optional(v.number()),
    /** Kept on the row so the cap is one read rather than a scan of redemptions. */
    redemptions: v.number(),
    /** How long the grant lasts once redeemed; absent = permanent. */
    durationDays: v.optional(v.number()),
    /** When the code stops being redeemable; absent = never. */
    expiresAt: v.optional(v.number()),
    /** Set = withdrawn. Existing grants survive — revoking a code is not a clawback. */
    disabledAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  /**
   * One row per person per code. Both the record of who got in for free and
   * the lock that stops a code being redeemed twice by the same account.
   *
   * `expiresAt` is copied from the code's `durationDays` at redemption rather
   * than recomputed, so shortening a code later cannot retroactively cut short
   * a grant somebody is already holding.
   */
  codeRedemptions: defineTable({
    codeId: v.id("accessCodes"),
    ownerId: v.string(),
    redeemedAt: v.number(),
    /** When this grant lapses; absent = permanent. */
    expiresAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_code", ["codeId"])
    .index("by_owner_and_code", ["ownerId", "codeId"]),

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
    kind: v.union(v.literal("classic"), v.literal("fine-grained"), v.literal("oauth")),
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
   * A GitHub App installation a workspace admin attached to their workspace,
   * after GitHub proved they can reach it (`github/app.install`). One
   * installation can serve more than one workspace, a row each.
   *
   * The installation token GitHub mints lasts an hour; it is cached here
   * sealed, the same way a personal token is kept, and re-minted when it has
   * little left.
   */
  githubInstallations: defineTable({
    workspaceId: v.id("workspaces"),
    /** GitHub's id for the installation. */
    installationId: v.number(),
    accountLogin: v.string(),
    accountType: v.union(v.literal("Organization"), v.literal("User")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    installedBy: v.string(),
    createdAt: v.number(),
    suspendedAt: v.optional(v.number()),
    /** Uninstalled on GitHub. Kept so the screen can say so. */
    removedAt: v.optional(v.number()),
    token: v.optional(v.object({ sealed: v.string(), expiresAt: v.number() })),
  })
    .index("by_workspace", ["workspaceId"])
    .index("by_installation", ["installationId"]),

  /**
   * The Notion connection, one per account.
   *
   * OAuth rather than a pasted token, because the thing being connected is a
   * person's own workspace and Notion asks them, in their own consent screen,
   * which pages this app may see. That picker is the access model: the token
   * can read what was ticked there and nothing else, so re-granting is a normal
   * part of using the import, not a failure.
   *
   * Notion issues no refresh token and its access tokens do not expire, so the
   * only thing that ends a connection is the user revoking it — which shows up
   * as a 401 on first use and is recorded in `invalidAt` rather than guessed at.
   */
  notionAccounts: defineTable({
    ownerId: v.string(),
    /** AES-GCM ciphertext. Opening it needs the deployment's NOTION_TOKEN_KEY. */
    sealed: v.string(),
    /** The workspace granted, as Notion named it at connect. */
    workspaceId: v.string(),
    workspaceName: v.string(),
    /** Emoji or image URL, whichever Notion gave for the workspace. */
    workspaceIcon: v.optional(v.string()),
    /** The integration's bot user inside that workspace. */
    botId: v.string(),
    /** Last four characters, so a stored token is recognisable but not readable. */
    hint: v.string(),
    connectedAt: v.number(),
    /** Stamped when Notion last answered 401. See `githubAccounts.invalidAt`. */
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
    /**
     * Where the repository's place in the context graph stands. "naming" is
     * indexed and waiting for its concerns to be named; directory names stand
     * in until then, so the graph is usable the moment indexing lands.
     */
    index: v.optional(
      v.object({
        state: v.union(
          v.literal("queued"),
          v.literal("indexing"),
          v.literal("naming"),
          v.literal("ready"),
          v.literal("failed"),
        ),
        error: v.optional(v.string()),
        /** The commit the graph was built from. */
        sha: v.optional(v.string()),
        at: v.optional(v.number()),
        files: v.optional(v.number()),
        concerns: v.optional(v.number()),
        areas: v.optional(v.number()),
        references: v.optional(v.number()),
        /** When a naming run took this repository, so two tabs do not both pay for it. */
        claimedAt: v.optional(v.number()),
      }),
    ),
    addedAt: v.number(),
    /** Read through this GitHub App installation instead of `ownerId`'s connection. */
    installationId: v.optional(v.number()),
    /**
     * When a re-index for pushes to the default branch is due. Pushes inside
     * the window add nothing: the run reads the branch's head when it starts.
     */
    pushReindexAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    // What a push or an uninstall names: an installation and a repository.
    .index("by_installation_and_fullName", ["installationId", "fullName"])
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

  // ---- Context graph ------------------------------------------------------
  // One typed graph per project that every source feeds and every AI lane
  // reads through a budget — see docs/context-graph.md. Pages are the first
  // source, through `context/pages.ts`.

  /**
   * One thing a source knows about. `externalId` is the source's own id for it
   * (a page id, for pages), unique within a project.
   *
   * Kept small on purpose: the pack reads every node in a project and re-runs
   * whenever one changes, so a node holds only what a pack prints. The words a
   * search needs and the summary live in `contextNodeText`, which churns with
   * every digest without touching this row.
   */
  contextNodes: defineTable({
    projectId: v.id("projects"),
    source: v.union(
      v.literal("pages"),
      v.literal("github"),
      v.literal("files"),
      v.literal("notion"),
    ),
    /** The linked repository a GitHub node came from; what a re-index replaces. */
    repoId: v.optional(v.id("projectRepos")),
    /** The node this one sits inside: a file's concern, a concern's area, an area's repo. */
    parentId: v.optional(v.id("contextNodes")),
    tier: v.union(
      v.literal("source"),
      v.literal("artifact"),
      v.literal("part"),
      v.literal("concern"),
    ),
    kind: v.union(
      v.literal("page"),
      v.literal("repo"),
      v.literal("area"),
      v.literal("concern"),
      v.literal("file"),
      /** A whole document read into context: an uploaded file, a linked Notion page. */
      v.literal("document"),
    ),
    externalId: v.string(),
    title: v.string(),
    /** A deep link into the source, where it has one — a file on GitHub. */
    url: v.optional(v.string()),
    /** Set on the one concern that holds a codebase's look — see `github/index/cluster.ts`. */
    styling: v.optional(v.boolean()),
    /** About twenty tokens: what the node is, for a list. Empty until digested. */
    brief: v.string(),
    /**
     * Whose it is in its source, shown and never enforced. `memberId` is the
     * Clerk subject when the owner is a project member; `handle` is the
     * source's own name for them when they are not.
     */
    owner: v.object({
      memberId: v.optional(v.string()),
      handle: v.optional(v.string()),
    }),
  })
    .index("by_project_and_externalId", ["projectId", "externalId"])
    // What a pack or the graph view reads: pages, or a repository's map,
    // without wading through its thousands of files.
    .index("by_project_and_kind", ["projectId", "kind"])
    .index("by_repoId", ["repoId"])
    .index("by_parentId", ["parentId"]),

  /** A node's heavier half — see `contextNodes`. One row per node. */
  contextNodeText: defineTable({
    nodeId: v.id("contextNodes"),
    projectId: v.id("projects"),
    /** About 150 tokens: enough to decide whether to read the body. */
    summary: v.string(),
    summaryOrigin: v.union(v.literal("template"), v.literal("model"), v.literal("human")),
    /** The source's words for the node, kept so a rename can rebuild `searchText`. */
    terms: v.string(),
    /** Title plus terms — the one field the full-text index reads. */
    searchText: v.string(),
    /** Fingerprint of what the digest was built from; equal means nothing to write. */
    contentHash: v.string(),
    /**
     * A document's whole text, capped, for `read_context` — a page's body is
     * read from the page, and a code file's from GitHub, but an uploaded file
     * or a Notion page is read from here.
     */
    body: v.optional(v.string()),
    syncedAt: v.number(),
    /**
     * Whether the node is a repository's — code, which not every reader of the
     * project may see (`canReadCode`). On the row so search can leave it out
     * in the index rather than after. Absent only on rows older than the field
     * (`migrations.markContextCode`).
     */
    code: v.optional(v.boolean()),
  })
    .index("by_nodeId", ["nodeId"])
    .index("by_project", ["projectId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["projectId", "code"],
    }),

  /**
   * A directed relation between two nodes. Retired rather than deleted:
   * `expiredAt` set means the relation stopped holding then, so what the graph
   * believed at a point in time can still be read back.
   */
  contextEdges: defineTable({
    projectId: v.id("projects"),
    from: v.id("contextNodes"),
    to: v.id("contextNodes"),
    family: v.union(
      v.literal("contains"),
      v.literal("references"),
      v.literal("about"),
      v.literal("same_as"),
      v.literal("supersedes"),
    ),
    /**
     * Which kind within the family — "mentions" for a page naming a page,
     * "imports" for code, "rollup" for the summed pull between two concerns.
     */
    type: v.string(),
    /** How strong the relation is, where that varies — a rollup's summed weight. */
    weight: v.optional(v.number()),
    repoId: v.optional(v.id("projectRepos")),
    origin: v.union(v.literal("parsed"), v.literal("inferred"), v.literal("human")),
    createdAt: v.number(),
    expiredAt: v.optional(v.number()),
  })
    // `expiredAt` last, so live edges are one range: eq(undefined).
    .index("by_from_and_family_and_expiredAt", ["from", "family", "expiredAt"])
    .index("by_to_and_family_and_expiredAt", ["to", "family", "expiredAt"])
    .index("by_project", ["projectId"])
    .index("by_project_and_type", ["projectId", "type"])
    .index("by_repoId", ["repoId"]),

  /**
   * A Notion page linked to a project as context: it stays in Notion, and is
   * read into the context graph as a document — the Notion counterpart of a
   * linked repository. Read with the token of whoever linked it.
   */
  projectNotion: defineTable({
    ownerId: v.string(),
    projectId: v.id("projects"),
    /** Notion's page id, dashed or not as Notion gave it. */
    pageId: v.string(),
    title: v.string(),
    emoji: v.optional(v.string()),
    url: v.optional(v.string()),
    index: v.object({
      state: v.union(
        v.literal("queued"),
        v.literal("reading"),
        v.literal("ready"),
        v.literal("failed"),
      ),
      error: v.optional(v.string()),
      at: v.optional(v.number()),
      /** Characters read, so a card can say how much there is. */
      chars: v.optional(v.number()),
    }),
    addedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_pageId", ["projectId", "pageId"]),

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
    /**
     * When this thread first reached the model, and so when it was charged
     * against the free allowance. Present is the idempotency key: a thread is
     * counted once however long the conversation runs, and one already counted
     * keeps working after the allowance is gone — a wall in the middle of a
     * conversation would punish the person for continuing to talk. A thread
     * opened and abandoned never reaches here and costs nothing.
     */
    billedAt: v.optional(v.number()),
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
