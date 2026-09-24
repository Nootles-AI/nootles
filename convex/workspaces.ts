import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  atLeast,
  domainOf,
  isTrashed,
  ownerId as currentOwner,
  requireOwner,
  requireWorkspaceRole,
  roleForProject,
  standInActor,
  verifiedEmail,
  workspaceRole,
} from "./auth";
import { record, recordByCaller } from "./audit";
import { isPersonalDomain } from "./joinDomains";
import { pageSummary, withoutLinks } from "./projects";
import { rowIcon, workspaceSettings } from "./schema";
import { normalizeSlug, SLUG_TAKEN, slugProblem } from "./slugs";
import { scheduleSeatSync } from "./teamBilling";
import { teamsEnabledFor } from "./teamsRollout";

/**
 * Workspaces themselves: making one, finding one by its address, naming it,
 * its settings, and deleting it. Who is in one is `members.ts`; what anyone
 * may do in one is `auth.ts`.
 *
 * A workspace answers to `/w/<slug>`. Every slug it has ever had stays in
 * `workspaceSlugs`, so an old link keeps arriving and nobody else can take a
 * name that still has links pointing at it — the same holds after deletion.
 */

const NAME_MAX = 64;

function cleanName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ConvexError("Give the workspace a name.");
  if (name.length > NAME_MAX) {
    throw new ConvexError(`A workspace name can be at most ${NAME_MAX} characters.`);
  }
  return name;
}

async function slugRow(ctx: QueryCtx, slug: string) {
  return await ctx.db
    .query("workspaceSlugs")
    .withIndex("by_slug", (q) => q.eq("slug", slug))
    .unique();
}

/**
 * A usable address for `workspaceId` (or for a workspace not made yet), or a
 * refusal. Any row blocks it, retired or not, unless it is this workspace's
 * own old name coming back.
 */
async function vetSlug(
  ctx: QueryCtx,
  raw: string,
  workspaceId: Id<"workspaces"> | null,
): Promise<{ slug: string; row: Doc<"workspaceSlugs"> | null }> {
  const slug = normalizeSlug(raw);
  const problem = slugProblem(slug);
  if (problem) throw new ConvexError(problem);
  const row = await slugRow(ctx, slug);
  if (row && row.workspaceId !== workspaceId) {
    throw new ConvexError(SLUG_TAKEN);
  }
  return { slug, row };
}

/**
 * Whether the caller may make a workspace at all, for the switcher to ask. An
 * operator's stand-in is told no, the same courtesy as `projects.myRole`.
 */
export const canCreate = query({
  args: {},
  handler: async (ctx) =>
    !(await standInActor(ctx)) && teamsEnabledFor(await currentOwner(ctx)),
});

/**
 * What `create` (or, with `workspaceId`, `setSlug`) would say about an
 * address, asked while it is still being typed. Only for someone who could
 * then use it — the rollout for a new workspace, an admin's seat for a
 * renamed one — and null for anyone else, so it tells nobody more than
 * pressing the button would.
 */
export const checkSlug = query({
  args: { slug: v.string(), workspaceId: v.optional(v.id("workspaces")) },
  handler: async (ctx, args) => {
    if (await standInActor(ctx)) return null;
    if (args.workspaceId) {
      if (!atLeast(await workspaceRole(ctx, args.workspaceId), "admin")) return null;
    } else if (!teamsEnabledFor(await currentOwner(ctx))) {
      return null;
    }
    const slug = normalizeSlug(args.slug);
    const problem = slugProblem(slug);
    if (problem) return { slug, problem };
    const row = await slugRow(ctx, slug);
    return { slug, problem: row && row.workspaceId !== args.workspaceId ? SLUG_TAKEN : null };
  },
});

export const create = mutation({
  args: { name: v.string(), slug: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const me = await requireOwner(ctx);
    if (!teamsEnabledFor(me)) {
      throw new ConvexError("Workspaces aren’t open to your account yet.");
    }
    const name = cleanName(args.name);
    const { slug } = await vetSlug(ctx, args.slug ?? name, null);
    const now = Date.now();
    const workspaceId = await ctx.db.insert("workspaces", {
      slug,
      name,
      createdBy: me,
      plan: "team",
      settings: { linkSharing: true, guestCodeAccess: false, joinDomains: [], autoJoin: false },
      createdAt: now,
    });
    await ctx.db.insert("workspaceSlugs", { slug, workspaceId });
    await ctx.db.insert("memberships", {
      workspaceId,
      userId: me,
      role: "owner",
      status: "active",
      joinedAt: now,
    });
    await record(ctx, {
      workspaceId,
      actorId: me,
      action: "workspace.create",
      subjectKind: "workspace",
      subjectId: workspaceId,
      meta: { name, slug },
    });
    return { workspaceId, slug };
  },
});

/**
 * What `/w/<slug>` resolves to, for someone with a seat there — guests
 * included. An old address answers too, with the current one beside it so the
 * page can move to it. Everyone else gets null, the same as an address nobody
 * has: a workspace's existence is not something a stranger can learn here.
 */
export const bySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const row = await slugRow(ctx, normalizeSlug(args.slug));
    if (!row) return null;
    const role = await workspaceRole(ctx, row.workspaceId);
    const workspace = role && (await ctx.db.get(row.workspaceId));
    if (!role || !workspace) return null;
    return {
      workspace: {
        _id: workspace._id,
        name: workspace.name,
        slug: workspace.slug,
        plan: workspace.plan,
        settings: workspace.settings,
        icon: workspace.icon ?? null,
        createdAt: workspace.createdAt,
      },
      role,
      canonicalSlug: workspace.slug,
    };
  },
});

/** Every workspace the caller has a seat in, by name, for the switcher. */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentOwner(ctx);
    if (!me) return [];
    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_user_status", (q) => q.eq("userId", me).eq("status", "active"))
      .collect();
    const rows = await Promise.all(
      seats.map(async (seat) => {
        const workspace = await ctx.db.get(seat.workspaceId);
        if (!workspace || workspace.deletedAt !== undefined) return null;
        return {
          workspaceId: workspace._id,
          slug: workspace.slug,
          name: workspace.name,
          icon: workspace.icon ?? null,
          role: seat.role,
        };
      }),
    );
    return rows
      .filter((row) => row !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const rename = mutation({
  args: { workspaceId: v.id("workspaces"), name: v.string() },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const name = cleanName(args.name);
    if (name === workspace.name) return null;
    await ctx.db.patch(args.workspaceId, { name });
    await recordByCaller(ctx, workspace._id, {
      action: "workspace.rename",
      subjectKind: "workspace",
      subjectId: workspace._id,
      meta: { from: workspace.name, to: name },
    });
    return null;
  },
});

/**
 * The workspace's icon — an emoji, a glyph or a picture, the shape a page's
 * icon has — or null for its letter again. Its owners' and admins' to choose.
 */
export const setIcon = mutation({
  args: { workspaceId: v.id("workspaces"), icon: v.union(rowIcon, v.null()) },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const icon = args.icon ?? undefined;
    if (sameIcon(workspace.icon, icon)) return null;
    await ctx.db.patch(workspace._id, { icon });
    await recordByCaller(ctx, workspace._id, {
      action: "workspace.icon",
      subjectKind: "workspace",
      subjectId: workspace._id,
      meta: {
        kind: icon?.kind ?? null,
        ...(icon?.kind === "emoji" ? { emoji: icon.value } : {}),
      },
    });
    return null;
  },
});

type Icon = NonNullable<Doc<"workspaces">["icon"]>;

/** The same choice: a glyph by its name, a picture by its file. */
function sameIcon(a: Icon | undefined, b: Icon | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "emoji" && b.kind === "emoji") return a.value === b.value;
  if (a.kind === "icon" && b.kind === "icon") return a.name === b.name && a.d === b.d;
  if (a.kind === "image" && b.kind === "image") return a.storageId === b.storageId;
  return false;
}

/**
 * A new address. The old one is retired rather than released, so links to it
 * keep arriving here; taking back an address this workspace used before
 * simply un-retires it.
 */
export const setSlug = mutation({
  args: { workspaceId: v.id("workspaces"), slug: v.string() },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const { slug, row } = await vetSlug(ctx, args.slug, workspace._id);
    if (slug === workspace.slug) return { slug };
    const current = await slugRow(ctx, workspace.slug);
    if (current) await ctx.db.patch(current._id, { retiredAt: Date.now() });
    if (row) await ctx.db.patch(row._id, { retiredAt: undefined });
    else await ctx.db.insert("workspaceSlugs", { slug, workspaceId: workspace._id });
    await ctx.db.patch(workspace._id, { slug });
    await recordByCaller(ctx, workspace._id, {
      action: "workspace.slug",
      subjectKind: "workspace",
      subjectId: workspace._id,
      meta: { from: workspace.slug, to: slug },
    });
    return { slug };
  },
});

/**
 * Settings an admin changes here. The GitHub organisation rule is not among
 * them: it must name an organisation the GitHub App is installed on, which
 * `github/app.setOrgRule` checks.
 *
 * A join domain lets anyone signed in on it walk in, so adding one needs proof
 * of holding it: it must be the domain of the acting admin's own verified
 * address, and not one anybody can sign up on. Domains already on the list
 * stay without that proof, and any of them can be taken off.
 */
export const updateSettings = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    patch: workspaceSettings
      .omit("requireGithubOrg", "linkTtlDays")
      .partial()
      .extend({
        /** Null clears it: new links stop expiring. */
        linkTtlDays: v.optional(v.union(v.number(), v.null())),
      }),
  },
  handler: async (ctx, args) => {
    const { workspace } = await requireWorkspaceRole(ctx, args.workspaceId, "admin");
    const { joinDomains, linkTtlDays, ...flags } = args.patch;
    const settings = { ...workspace.settings, ...flags };

    if (linkTtlDays !== undefined) {
      if (
        linkTtlDays !== null &&
        (!Number.isInteger(linkTtlDays) || linkTtlDays < 1 || linkTtlDays > 365)
      ) {
        throw new ConvexError("Links can expire after 1 to 365 days.");
      }
      settings.linkTtlDays = linkTtlDays ?? undefined;
    }

    if (joinDomains !== undefined) {
      const next = [
        ...new Set(joinDomains.map((d) => d.trim().toLowerCase().replace(/^@/, ""))),
      ].filter(Boolean);
      const had = new Set(workspace.settings.joinDomains);
      const email = await verifiedEmail(ctx, { now: Date.now() });
      for (const domain of next) {
        if (had.has(domain)) continue;
        if (isPersonalDomain(domain)) {
          throw new ConvexError(
            `${domain} is a personal email domain: anyone could join through it.`,
          );
        }
        if (!email || domainOf(email) !== domain) {
          throw new ConvexError(
            email
              ? `You can only add your own email’s domain (${domainOf(email)}).`
              : "You can only add your own email’s domain.",
          );
        }
      }
      await syncDomains(ctx, workspace._id, next);
      settings.joinDomains = next;
    }

    await ctx.db.patch(workspace._id, { settings });
    await recordSettings(ctx, workspace, settings);
    return null;
  },
});

type Settings = Doc<"workspaces">["settings"];

/** A setting as the log shows it: a list joined, absent as null. */
function settingValue(value: Settings[keyof Settings]): string | number | boolean | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(", ") : value;
}

/**
 * One event per setting that changed, so each reads as its own sentence —
 * "turned link sharing off", "allowed personal GitHub connections".
 */
export async function recordSettings(
  ctx: MutationCtx,
  workspace: Doc<"workspaces">,
  after: Settings,
) {
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    const from = settingValue(workspace.settings[key]);
    const to = settingValue(after[key]);
    if (from === to) continue;
    await recordByCaller(ctx, workspace._id, {
      action: "workspace.settings",
      subjectKind: "workspace",
      subjectId: workspace._id,
      meta: { setting: key, from, to },
    });
  }
}

/** Keeps the domain lookup table equal to `settings.joinDomains`. */
async function syncDomains(
  ctx: MutationCtx,
  workspaceId: Id<"workspaces">,
  after: string[],
) {
  const rows = await ctx.db
    .query("workspaceDomains")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
    .collect();
  for (const row of rows) {
    if (!after.includes(row.domain)) await ctx.db.delete(row._id);
  }
  const kept = new Set(rows.map((row) => row.domain));
  for (const domain of after) {
    if (!kept.has(domain)) await ctx.db.insert("workspaceDomains", { domain, workspaceId });
  }
}

/**
 * Deletes a workspace, softly, and everything it held with it in the same
 * mutation: every live project goes to the trash (purged on the usual
 * schedule), every seat is retired, every open invitation withdrawn. Retiring
 * the seats here is what lets the per-document access path skip the
 * workspace row — nothing downstream has to know it was deleted. A Team
 * subscription is set to end with the period already paid for.
 */
export const remove = mutation({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    const { membership } = await requireWorkspaceRole(ctx, args.workspaceId, "owner");
    const workspaceId = args.workspaceId;
    const now = Date.now();
    await ctx.db.patch(workspaceId, { deletedAt: now });

    const projects = await ctx.db
      .query("projects")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    for (const project of projects) {
      if (!isTrashed(project)) await ctx.db.patch(project._id, { deletedAt: now });
    }

    const seats = await ctx.db
      .query("memberships")
      .withIndex("by_workspace_status_role", (q) =>
        q.eq("workspaceId", workspaceId).eq("status", "active"),
      )
      .collect();
    for (const seat of seats) {
      await ctx.db.patch(seat._id, {
        status: "removed",
        removedAt: now,
        removedBy: membership.userId,
      });
    }

    const invitations = await ctx.db
      .query("invitations")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .collect();
    for (const invitation of invitations) {
      if (invitation.acceptedAt === undefined && invitation.revokedAt === undefined) {
        await ctx.db.patch(invitation._id, { revokedAt: now });
      }
    }

    await syncDomains(ctx, workspaceId, []);
    await scheduleSeatSync(ctx, workspaceId);
    await record(ctx, {
      workspaceId,
      actorId: membership.userId,
      action: "workspace.delete",
      subjectKind: "workspace",
      subjectId: workspaceId,
      meta: {
        name: (await ctx.db.get(workspaceId))?.name,
        projects: projects.filter((p) => !isTrashed(p)).length,
        members: seats.length,
      },
    });
    return null;
  },
});

/**
 * The workspace home: every project in it the caller can open, in the same
 * shape as the personal screen's rows plus the caller's role in each. What
 * "can open" means is `roleForProject`'s answer, project by project — all of
 * them for its owners and admins, the shared ones and their own private ones
 * for a member, and for a guest whatever links they came in by.
 *
 * The share links are left off (`withoutLinks`): a row on a home screen is
 * not that door.
 */
export const projectsFor = query({
  args: { workspaceId: v.id("workspaces") },
  handler: async (ctx, args) => {
    if (!(await workspaceRole(ctx, args.workspaceId))) return [];
    const projects = (
      await ctx.db
        .query("projects")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
        .collect()
    ).filter((p) => !isTrashed(p));
    const standIn = await standInActor(ctx);

    const rows = await Promise.all(
      projects.map(async (p) => {
        const role = await roleForProject(ctx, p);
        if (!role) return null;
        return {
          ...withoutLinks(p),
          ...(await pageSummary(ctx, p)),
          // The same courtesy demotion as `projects.myRole`.
          role: standIn ? ("viewer" as const) : role,
        };
      }),
    );
    return rows
      .filter((row) => row !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});
