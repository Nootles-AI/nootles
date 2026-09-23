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
 * being in `projectRepos` is. Its owner may read its repositories, and so may
 * a workspace seat that edits it — each with the connection of whoever linked
 * the repository. A share link does not reach this far (`readsLinkedCode`).
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
      const found = await json<Entry[] | Entry>(token, contents(repo, path), {
        query: { ref: args.ref },
        allowMissing: true,
      });
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
      const body = await text(token, contents(repo, path), {
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
 * The text of a file the context graph indexed — what `read_context` returns
 * for a file, past its summary. Readable by anyone the project is shared
 * with, read with the token of whoever linked the repository.
 */
export const nodeFile = action({
  args: { projectId: v.id("projects"), nodeId: v.id("contextNodes") },
  handler: async (ctx, args): Promise<NodeFile> => {
    const found: { path: string; url: string | null; repo: Doc<"projectRepos"> } | null =
      await ctx.runQuery(internal.github.graphStore.fileForReader, args);
    if (!found) throw new ConvexError("That file is not in this project's context.");
    const { repo, path } = found;
    return await withToken(ctx, repo.ownerId, async (token) => {
      const body = await text(token, contents(repo, path), {
        query: { ref: repo.defaultBranch },
        allowMissing: true,
      });
      if (body === null) return { repo: repo.fullName, path, missing: true as const };
      if (body.includes("\u0000")) return { repo: repo.fullName, path, binary: true as const };
      return {
        repo: repo.fullName,
        path,
        url: found.url,
        content: body.slice(0, FILE_CHARS),
        ...(body.length > FILE_CHARS
          ? { truncated: `Showing the first ${FILE_CHARS} characters of ${body.length}.` }
          : {}),
      };
    });
  },
});

type NodeFile =
  | { repo: string; path: string; missing: true }
  | { repo: string; path: string; binary: true }
  | { repo: string; path: string; url: string | null; content: string; truncated?: string };

/** A qualifier that widens a code search beyond the repositories it names. */
const SCOPE_QUALIFIER = /\b(?:repo|org|user):/i;

/**
 * GitHub's code search, confined to this project's repositories.
 *
 * The `repo:` qualifiers are not a filter applied afterwards — they are what
 * stops the query reaching across every repository the token can see, which for
 * an organisation token is the entire organisation. So the query may not bring
 * qualifiers of its own: GitHub reads a second `repo:` as "or that one too".
 */
export const search = action({
  args: {
    projectId: v.id("projects"),
    query: v.string(),
    repo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    if (SCOPE_QUALIFIER.test(args.query)) {
      throw new ConvexError(
        "Search already covers only this project's repositories. Leave out repo:, " +
          "org: and user:, and name one repository to search just that one.",
      );
    }
    const repos: Doc<"projectRepos">[] = await ctx.runQuery(
      internal.github.repos.access,
      { projectId: args.projectId, ...(args.repo ? { fullName: args.repo } : {}) },
    );
    if (!repos.length) throw new ConvexError(unlinked(args.repo));

    // One search per connection: each can only be asked about the repositories
    // it linked, and the qualifiers keep it from reaching past them.
    const byLinker = new Map<string, Doc<"projectRepos">[]>();
    for (const r of repos) byLinker.set(r.ownerId, [...(byLinker.get(r.ownerId) ?? []), r]);
    const found = await Promise.all(
      [...byLinker].map(async ([linker, linked]) => {
        const answer = await withToken(ctx, linker, (token) =>
          json<{ total_count: number; items: Hit[] }>(token, "/search/code", {
            accept: "application/vnd.github.text-match+json",
            query: {
              q: `${args.query} ${linked.map((r) => `repo:${r.fullName}`).join(" ")}`,
              per_page: RESULTS,
            },
          }),
        );
        // Whatever reached past the linked repositories is someone else's
        // code, and so is the count that includes it.
        const names = new Set(linked.map((r) => r.fullName.toLowerCase()));
        const items = answer?.items ?? [];
        const hits = items.filter((hit) => names.has(hit.repository.full_name.toLowerCase()));
        return {
          hits,
          total: hits.length === items.length ? (answer?.total_count ?? 0) : hits.length,
        };
      }),
    );
    return {
      total: found.reduce((sum, f) => sum + f.total, 0),
      // Search only ever covers the default branch — worth saying, because a
      // model that finds nothing should not conclude the code isn't there.
      searched: repos.map((r) => `${r.fullName}@${r.defaultBranch}`),
      results: found
        .flatMap((f) => f.hits)
        .slice(0, RESULTS)
        .map((hit) => ({
          repo: hit.repository.full_name,
          path: hit.path,
          matches: (hit.text_matches ?? [])
            .map((m) => m.fragment.trim())
            .slice(0, 3),
        })),
    };
  },
});

/**
 * The repository, if this project is allowed to read it, and the connection it
 * is read with — its linker's. The message names the project rather than the
 * repository as the thing that is wrong, because that is the fix — a
 * repository the agent wants is one the user can link.
 */
async function permitted(
  ctx: ActionCtx,
  projectId: Id<"projects">,
  fullName: string,
) {
  await requireOwner(ctx);
  const rows: Doc<"projectRepos">[] = await ctx.runQuery(internal.github.repos.access, {
    projectId,
    fullName: fullName.trim(),
  });
  const repo = rows[0];
  if (!repo) throw new ConvexError(unlinked(fullName));
  return { ownerId: repo.ownerId, repo };
}

const unlinked = (fullName?: string) =>
  fullName
    ? `"${fullName}" is not one of this project's linked repositories. Only the ` +
      "repositories listed in the project's context can be read."
    : "This project has no linked repositories.";

/**
 * A path inside the repository, or a refusal. Leading and trailing slashes
 * are how a model writes a path; GitHub is not. A `.` or `..` segment is how
 * one leaves the repository — `new URL` resolves them, and the linker's token
 * would go wherever they point — so neither is a name, spelled out or
 * percent-encoded.
 */
function clean(path?: string): string {
  const trimmed = (path ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (trimmed && trimmed.split("/").some((segment) => !segment || isDots(segment))) {
    throw new ConvexError(`"${path}" is not a path inside the repository.`);
  }
  return trimmed;
}

function isDots(segment: string): boolean {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Not percent-encoding at all: a name with a `%` in it.
  }
  return [segment, decoded].some((name) => name === "." || name === "..");
}

/**
 * Where GitHub keeps a path's contents. Each segment is sent as the literal
 * name a listing gives, so a `?`, `#` or `%` in a filename stays part of it.
 */
const contents = (repo: Doc<"projectRepos">, path: string) =>
  `/repos/${repo.fullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;

type Entry = { path: string; type: string; size?: number };
type Hit = {
  path: string;
  repository: { full_name: string };
  text_matches?: { fragment: string }[];
};
