import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, type ActionCtx } from "../_generated/server";
import { requireOwner } from "../auth";
import { json, text } from "./rest";
import { withToken } from "./account";

/**
 * Reading a linked repository — the three things the agent can do to one.
 *
 * They live on this side rather than in the chat route so the token never
 * leaves Convex: the route calls these as the signed-in user, and each one
 * checks that the repository is actually linked to the project the chat belongs
 * to before it fetches anything. Being named in a tool call is not permission;
 * being in `projectRepos` is.
 *
 * Everything is capped. A model that asks for a 40,000-line generated file gets
 * the top of it and a note saying so, which is a better turn than one that
 * spends the whole context window on a lockfile.
 */

/** Enough of a file to reason about; a model that needs more can ask by path. */
const FILE_CHARS = 60_000;
/** A directory listing is cheap, but a generated one can hold thousands. */
const ENTRIES = 400;
const RESULTS = 20;

export const tree = action({
  args: {
    projectId: v.id("projects"),
    repo: v.string(),
    path: v.optional(v.string()),
    ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { ownerId, repo } = await permitted(ctx, args.projectId, args.repo);
    const path = clean(args.path);
    return await withToken(ctx, ownerId, async (token) => {
      const found = await json<Entry[] | Entry>(
        token,
        `/repos/${repo.fullName}/contents/${path}`,
        { query: { ref: args.ref }, allowMissing: true },
      );
      if (!found) return { repo: repo.fullName, path, missing: true as const };
      // GitHub answers a file path with the file, not with a one-item listing.
      if (!Array.isArray(found)) {
        return {
          repo: repo.fullName,
          path,
          file: true as const,
          note: `${path} is a file, not a directory — read it with read_repo_file.`,
        };
      }
      return {
        repo: repo.fullName,
        path: path || "/",
        entries: found.slice(0, ENTRIES).map((e) => ({
          path: e.path,
          type: e.type === "dir" ? ("dir" as const) : ("file" as const),
          ...(e.type === "dir" ? {} : { size: e.size }),
        })),
        ...(found.length > ENTRIES
          ? { truncated: `${found.length - ENTRIES} more entries not shown` }
          : {}),
      };
    });
  },
});

export const file = action({
  args: {
    projectId: v.id("projects"),
    repo: v.string(),
    path: v.string(),
    ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { ownerId, repo } = await permitted(ctx, args.projectId, args.repo);
    const path = clean(args.path);
    if (!path) throw new ConvexError("A file path is required.");
    return await withToken(ctx, ownerId, async (token) => {
      const body = await text(token, `/repos/${repo.fullName}/contents/${path}`, {
        query: { ref: args.ref },
        allowMissing: true,
      });
      if (body === null) {
        return { repo: repo.fullName, path, missing: true as const };
      }
      // A NUL byte is the one reliable tell that what came back was never text.
      // Decoded as UTF-8 it is noise, and noise costs the same as prose.
      if (body.includes("\u0000")) {
        return {
          repo: repo.fullName,
          path,
          binary: true as const,
          note: `${path} is a binary file.`,
        };
      }
      return {
        repo: repo.fullName,
        path,
        ref: args.ref ?? repo.defaultBranch,
        content: body.slice(0, FILE_CHARS),
        ...(body.length > FILE_CHARS
          ? { truncated: `Showing the first ${FILE_CHARS} characters of ${body.length}.` }
          : {}),
      };
    });
  },
});

/**
 * GitHub's code search, confined to this project's repositories.
 *
 * The `repo:` qualifiers are not a filter applied afterwards — they are what
 * stops the query reaching across every repository the token can see, which for
 * an organisation token is the entire organisation.
 */
export const search = action({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    repo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const repos: Doc<"projectRepos">[] = await ctx.runQuery(
      internal.github.repos.access,
      { projectId: args.projectId, ownerId, ...(args.repo ? { fullName: args.repo } : {}) },
    );
    if (!repos.length) throw new ConvexError(unlinked(args.repo));

    const scope = repos.map((r) => `repo:${r.fullName}`).join(" ");
    return await withToken(ctx, ownerId, async (token) => {
      const found = await json<{ total_count: number; items: Hit[] }>(
        token,
        "/search/code",
        {
          accept: "application/vnd.github.text-match+json",
          query: { q: `${args.query} ${scope}`, per_page: RESULTS },
        },
      );
      return {
        total: found?.total_count ?? 0,
        // Search only ever covers the default branch — worth saying, because a
        // model that finds nothing should not conclude the code isn't there.
        searched: repos.map((r) => `${r.fullName}@${r.defaultBranch}`),
        results: (found?.items ?? []).map((hit) => ({
          repo: hit.repository.full_name,
          path: hit.path,
          matches: (hit.text_matches ?? [])
            .map((m) => m.fragment.trim())
            .slice(0, 3),
        })),
      };
    });
  },
});

/**
 * The repository, if this project is allowed to read it. The message names the
 * project rather than the repository as the thing that is wrong, because that
 * is the fix — a repository the agent wants is one the user can link.
 */
async function permitted(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  fullName: string,
) {
  const ownerId = await requireOwner(ctx);
  const rows: Doc<"projectRepos">[] = await ctx.runQuery(internal.github.repos.access, {
    projectId,
    ownerId,
    fullName: fullName.trim(),
  });
  const repo = rows[0];
  if (!repo) throw new ConvexError(unlinked(fullName));
  return { ownerId, repo };
}

const unlinked = (fullName?: string) =>
  fullName
    ? `"${fullName}" is not one of this project's linked repositories. Only the ` +
      "repositories listed in the project's context can be read."
    : "This project has no linked repositories.";

/** Leading and trailing slashes are how a model writes a path; GitHub is not. */
const clean = (path?: string) => (path ?? "").trim().replace(/^\/+|\/+$/g, "");

type Entry = { path: string; type: string; size?: number };
type Hit = {
  path: string;
  repository: { full_name: string };
  text_matches?: { fragment: string }[];
};
