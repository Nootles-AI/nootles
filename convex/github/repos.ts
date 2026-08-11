import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "../_generated/server";
import { readOwned, requireOwned, requireOwner } from "../auth";
import { repoRef } from "../schema";
import { json, text } from "./rest";
import { withToken } from "./account";

/**
 * Repositories linked to a project.
 *
 * Part of the Context Sheet in spirit: the summary each row carries is read into
 * every prompt, so the agent knows the repository exists and roughly what is in
 * it — and the tools in `read.ts` check this table before reading anything, so
 * being linked here is what "the agent may look at this repo" means.
 */

/** One page of repositories is plenty to choose from; `lookup` covers the rest. */
const PER_PAGE = 100;
/** Enough of a README to know what the project is, not enough to be the project. */
const README_HEAD = 1500;
/** Entries of the top level listed by name; a repo with more is a repo you scroll. */
const TOP_LEVEL = 80;

export const listForProject = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    if (!(await readOwned(ctx, "projects", args.projectId))) return [];
    return await ctx.db
      .query("projectRepos")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .collect();
  },
});

/**
 * The repositories this token can see, most recently pushed first.
 *
 * `affiliation` is what makes an organisation's repositories show up at all —
 * the default is repositories you own, which for anyone working in an org is the
 * short and wrong list.
 */
export const available = action({
  args: {},
  handler: async (ctx): Promise<Listed[]> => {
    const ownerId = await requireOwner(ctx);
    return await withToken(ctx, ownerId, async (token) => {
      const rows = await json<Repo[]>(token, "/user/repos", {
        query: {
          per_page: PER_PAGE,
          sort: "pushed",
          affiliation: "owner,collaborator,organization_member",
        },
      });
      return (rows ?? []).map(listed);
    });
  },
});

/**
 * One repository by exact name.
 *
 * `available` returns a page, and an organisation can have a thousand
 * repositories — so the picker also accepts "owner/name" typed out, and this is
 * what makes that work.
 */
export const lookup = action({
  args: { fullName: v.string() },
  handler: async (ctx, args): Promise<Listed | null> => {
    const ownerId = await requireOwner(ctx);
    const fullName = args.fullName.trim().replace(/^https:\/\/github\.com\//, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return null;
    return await withToken(ctx, ownerId, async (token) => {
      const repo = await json<Repo>(token, `/repos/${fullName}`, {
        allowMissing: true,
      });
      return repo ? listed(repo) : null;
    });
  },
});

export const link = mutation({
  args: { projectId: v.id("projects"), repos: v.array(repoRef) },
  handler: async (ctx, args) => {
    const { ownerId } = await requireOwned(ctx, "projects", args.projectId);
    await add(ctx, ownerId, args.projectId, args.repos);
  },
});

export const unlink = mutation({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => {
    await requireOwned(ctx, "projectRepos", args.repoId);
    await ctx.db.delete(args.repoId);
  },
});

/** Re-read a repository's summary now, rather than waiting for a reason to. */
export const refresh = action({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const repo: Doc<"projectRepos"> | null = await ctx.runQuery(
      internal.github.repos.row,
      { repoId: args.repoId, ownerId },
    );
    if (!repo) throw new ConvexError("That repository is no longer linked.");
    await summarise(ctx, ownerId, repo);
  },
});

// ---- Internal ------------------------------------------------------------

/**
 * Linking a repository and reading it are one act to the user and two to the
 * database: the row has to exist before anything can be fetched into it, and
 * fetching is a network call a mutation may not make. So the mutation schedules
 * this, and the row it wrote shows up unsummarised for as long as GitHub takes.
 */
export const sync = internalAction({
  args: { repoId: v.id("projectRepos"), ownerId: v.string() },
  handler: async (ctx, args) => {
    const repo: Doc<"projectRepos"> | null = await ctx.runQuery(
      internal.github.repos.row,
      args,
    );
    if (repo) await summarise(ctx, args.ownerId, repo);
  },
});

export const row = internalQuery({
  args: { repoId: v.id("projectRepos"), ownerId: v.string() },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repoId);
    return repo && repo.ownerId === args.ownerId ? repo : null;
  },
});

/**
 * The repositories a caller may read through this project — the permission
 * check every tool in `read.ts` makes first. Named, it is one row; unnamed, all
 * of them, which is what an unscoped code search is allowed to cover.
 */
export const access = internalQuery({
  args: {
    projectId: v.id("projects"),
    ownerId: v.string(),
    fullName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = args.fullName
      ? await ctx.db
          .query("projectRepos")
          .withIndex("by_project_and_fullName", (q) =>
            q.eq("projectId", args.projectId).eq("fullName", args.fullName!),
          )
          .collect()
      : await ctx.db
          .query("projectRepos")
          .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
          .collect();
    return rows.filter((r) => r.ownerId === args.ownerId);
  },
});

export const writeSummary = internalMutation({
  args: {
    repoId: v.id("projectRepos"),
    summary: v.optional(v.string()),
    syncError: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.repoId))) return;
    await ctx.db.patch(args.repoId, {
      // A failed read records why and leaves the last good summary alone. A
      // spent rate limit is a reason to try again later, not a reason for the
      // agent to stop knowing what the repository is.
      ...(args.summary ? { summary: args.summary, syncError: undefined } : {}),
      ...(args.syncError ? { syncError: args.syncError } : {}),
      syncedAt: Date.now(),
    });
  },
});

// ---- Shared --------------------------------------------------------------

/**
 * Link repositories to a project and start reading them.
 *
 * Exported because a project's first repositories are chosen before the project
 * exists — `projects.create` calls this with what the new-project dialog
 * collected, and the sidebar calls it with what you added later.
 */
export async function add(
  ctx: MutationCtx,
  ownerId: string,
  projectId: Id<"projects">,
  repos: readonly Infer<typeof repoRef>[],
) {
  const already = await ctx.db
    .query("projectRepos")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  const seen = new Set(already.map((r) => r.fullName));
  const now = Date.now();
  for (const repo of repos) {
    if (seen.has(repo.fullName)) continue;
    seen.add(repo.fullName);
    const repoId = await ctx.db.insert("projectRepos", {
      ownerId,
      projectId,
      ...repo,
      addedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.github.repos.sync, { repoId, ownerId });
  }
}

/**
 * What the agent is told a repository is, without opening it.
 *
 * Three requests: what GitHub says it is, what is at the top level, and the head
 * of the README. Deliberately not the file tree — a recursive listing of a real
 * repository is tens of thousands of tokens in every prompt, for something the
 * agent can ask for the moment it actually needs it.
 */
async function summarise(ctx: ActionCtx, ownerId: string, repo: Doc<"projectRepos">) {
  try {
    const summary = await withToken(ctx, ownerId, async (token) => {
      const [meta, top, readme] = await Promise.all([
        json<Repo>(token, `/repos/${repo.fullName}`),
        json<Entry[]>(token, `/repos/${repo.fullName}/contents`, {
          allowMissing: true,
        }),
        text(token, `/repos/${repo.fullName}/readme`, { allowMissing: true }),
      ]);

      const lines = [
        [
          repo.fullName,
          meta?.private ? "(private)" : "",
          meta?.description ? `— ${meta.description}` : "",
        ]
          .filter(Boolean)
          .join(" "),
        [
          meta?.default_branch,
          meta?.language,
          meta?.pushed_at ? `pushed ${meta.pushed_at.slice(0, 10)}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ];

      const entries = (top ?? [])
        .slice(0, TOP_LEVEL)
        .map((e) => (e.type === "dir" ? `${e.name}/` : e.name));
      if (entries.length) lines.push(`Top level: ${entries.join(", ")}`);

      const head = readme?.trim().slice(0, README_HEAD);
      if (head) lines.push("README —", head);
      return lines.filter(Boolean).join("\n");
    });
    await ctx.runMutation(internal.github.repos.writeSummary, {
      repoId: repo._id,
      summary,
    });
  } catch (error) {
    // A repository that cannot be read is still linked, and says why on its row.
    // Throwing here would only lose the reason in a scheduled function's logs.
    await ctx.runMutation(internal.github.repos.writeSummary, {
      repoId: repo._id,
      syncError: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---- Shapes --------------------------------------------------------------

/** The fields of GitHub's repository object this app has a use for. */
type Repo = {
  full_name: string;
  default_branch: string;
  description: string | null;
  private: boolean;
  language?: string | null;
  pushed_at?: string | null;
};

type Entry = { name: string; type: string };

export type Listed = {
  fullName: string;
  defaultBranch: string;
  description?: string;
  private: boolean;
  pushedAt?: string;
};

function listed(repo: Repo): Listed {
  return {
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    ...(repo.description ? { description: repo.description } : {}),
    private: repo.private,
    ...(repo.pushed_at ? { pushedAt: repo.pushed_at } : {}),
  };
}
