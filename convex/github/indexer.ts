"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
import { BATCH, type EdgeInput, type NodeInput } from "./graphShape";
import { cluster, type Clustering } from "./index/cluster";
import { coChange } from "./index/cochange";
import { describeFile, describeStyling } from "./index/describe";
import { parseFile, type ParsedFile } from "./index/parse";
import { resolveReferences, tsPaths } from "./index/resolve";
import { keep, MAX_FILES, prioritise } from "./index/select";
import { untar } from "./index/tar";
import { GitHubError, json, request } from "./rest";
import { open } from "./seal";

/**
 * Stages 0 and 1 of the GitHub pipeline (docs/context-graph.md): the
 * repository at its default branch's head, parsed into files and references,
 * clustered into areas and concerns, and written into the project's context
 * graph. No model calls — names here are directory-derived, and a model
 * renames them afterwards (`app/api/context/name`).
 *
 * In Node for the room: a real repository's tarball, unpacked and parsed,
 * wants more than the default runtime's memory.
 */

/** Past this the tarball is not fetched at all — it would not fit to parse. */
const MAX_TARBALL = 150 * 1024 * 1024;
/** Recent history is what co-change reads; older commits describe older code. */
const HISTORY = 100;
const PARALLEL = 6;

export const run = internalAction({
  args: { repoId: v.id("projectRepos") },
  handler: async (ctx, args): Promise<void> => {
    const repo: Doc<"projectRepos"> | null = await ctx.runQuery(
      internal.github.graphStore.repoById,
      args,
    );
    if (!repo) return;
    await ctx.runMutation(internal.github.graphStore.setIndex, {
      repoId: repo._id,
      index: { state: "indexing" },
    });
    try {
      const built = await read(await tokenFor(ctx, repo.ownerId), repo);
      await write(ctx, repo, built);
      await ctx.runMutation(internal.github.graphStore.setIndex, {
        repoId: repo._id,
        index: {
          state: "naming",
          sha: built.sha,
          at: Date.now(),
          files: built.files.length,
          areas: built.clustering.areas.length,
          concerns: built.clustering.areas.reduce((n, a) => n + a.concerns.length, 0),
          references: built.references.length,
        },
      });
    } catch (error) {
      if (error instanceof GitHubError && error.unauthorized) {
        await ctx.runMutation(internal.github.account.markInvalid, { ownerId: repo.ownerId });
      }
      await ctx.runMutation(internal.github.graphStore.setIndex, {
        repoId: repo._id,
        index: {
          state: "failed",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  },
});

/**
 * The linker's token, opened here rather than through `account.withToken`,
 * which lives beside queries and mutations a Node module may not import.
 */
async function tokenFor(ctx: ActionCtx, ownerId: string): Promise<string> {
  const row: Doc<"githubAccounts"> | null = await ctx.runQuery(
    internal.github.account.forOwner,
    { ownerId },
  );
  if (!row) throw new Error("No GitHub account is connected for this repository's owner.");
  return await open(row.sealed);
}

type Built = {
  sha: string;
  files: ParsedFile[];
  texts: Map<string, string>;
  references: ReturnType<typeof resolveReferences>;
  clustering: Clustering;
};

async function read(token: string, repo: Doc<"projectRepos">): Promise<Built> {
  const full = repo.fullName;
  const head = await json<{ sha: string }>(token, `/repos/${full}/commits/${repo.defaultBranch}`);
  if (!head?.sha) throw new Error(`${full} has no commits on ${repo.defaultBranch}.`);

  const tarball = await request(token, `/repos/${full}/tarball/${head.sha}`);
  const size = Number(tarball!.headers.get("content-length"));
  if (Number.isFinite(size) && size > MAX_TARBALL) {
    throw new Error(`${full} is too large to index (${Math.round(size / 1e6)} MB).`);
  }
  const entries = untar(new Uint8Array(await tarball!.arrayBuffer()));

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const kept = entries.filter((e) => keep(e.path, e.data.length));
  const chosen = new Set(prioritise(kept.map((e) => e.path)).slice(0, MAX_FILES));
  const texts = new Map<string, string>();
  for (const entry of kept) {
    if (!chosen.has(entry.path)) continue;
    const text = decoder.decode(entry.data);
    // A NUL is a binary file that slipped past the extension check.
    if (!text.includes("\u0000")) texts.set(entry.path, text);
  }

  const files = [...texts].map(([path, text]) => parseFile(path, text));
  const config = tsPaths([...texts].map(([path, text]) => ({ path, text })));
  const references = resolveReferences(files, config);
  const history = await changedTogether(token, full, repo.defaultBranch);
  const clustering = cluster({
    files,
    references,
    cochange: coChange(history, new Set(texts.keys())),
  });
  return { sha: head.sha, files, texts, references, clustering };
}

/** The file lists of the branch's recent commits, a few requests at a time. */
async function changedTogether(token: string, full: string, branch: string) {
  const commits =
    (await json<{ sha: string }[]>(token, `/repos/${full}/commits`, {
      query: { sha: branch, per_page: HISTORY },
    })) ?? [];
  const lists: string[][] = [];
  for (let i = 0; i < commits.length; i += PARALLEL) {
    const batch = await Promise.all(
      commits.slice(i, i + PARALLEL).map((c) =>
        json<{ files?: { filename: string }[] }>(token, `/repos/${full}/commits/${c.sha}`)
          .then((d) => (d?.files ?? []).map((f) => f.filename))
          // One unreadable commit costs its pairs, not the whole index.
          .catch(() => []),
      ),
    );
    lists.push(...batch);
  }
  return lists;
}

async function write(ctx: ActionCtx, repo: Doc<"projectRepos">, built: Built) {
  // Batched: a large repository's old graph is thousands of rows.
  let more: boolean = true;
  while (more) more = await ctx.runMutation(internal.github.graphStore.clear, { repoId: repo._id });

  const full = repo.fullName;
  const { clustering, files, texts } = built;
  const byPath = new Map(files.map((f) => [f.path, f]));
  const blob = (path: string) => `https://github.com/${full}/blob/${built.sha}/${path}`;
  const key = (id: string) => `${full}#${id}`;
  const fileKey = (path: string) => `${full}:${path}`;
  const concernOf = new Map<string, string>();
  const concerns = clustering.areas.flatMap((a) => a.concerns);
  for (const c of concerns) for (const path of c.files) concernOf.set(path, c.id);

  const nodes: NodeInput[] = [
    {
      kind: "repo",
      tier: "source",
      externalId: full,
      title: full,
      brief: repo.description ?? `${files.length} files`,
      summary:
        `${full}: ${files.length} files in ${clustering.areas.length} areas and ` +
        `${concerns.length} concerns, read at ${built.sha.slice(0, 7)} on ${repo.defaultBranch}.`,
      terms: [full, repo.description ?? ""].join("\n"),
      url: `https://github.com/${full}`,
    },
  ];
  for (const area of clustering.areas) {
    const count = area.concerns.reduce((n, c) => n + c.files.length, 0);
    nodes.push({
      kind: "area",
      tier: "concern",
      externalId: key(area.id),
      parent: full,
      title: area.name,
      brief: `${plural(area.concerns.length, "concern")}, ${plural(count, "file")}`,
      summary: `Concerns: ${area.concerns.map((c) => c.name).join(", ")}`,
      terms: [area.name, ...area.concerns.map((c) => c.name)].join("\n"),
    });
    for (const concern of area.concerns) {
      const members = concern.files.map((p) => byPath.get(p)).filter((f) => !!f);
      nodes.push({
        kind: "concern",
        tier: "concern",
        externalId: key(concern.id),
        parent: key(area.id),
        title: concern.name,
        brief: `${plural(members.length, "file")}${common(concern.files)}`,
        summary: concern.styling
          ? describeStyling(members, texts)
          : outline(members),
        terms: [
          concern.name,
          ...members.flatMap((f) => [f.path, ...f.exports]),
        ]
          .join("\n")
          .slice(0, 6000),
        ...(concern.styling ? { styling: true } : {}),
      });
    }
  }
  const concernById = new Map(concerns.map((c) => [c.id, c]));
  for (const file of files) {
    const concern = concernById.get(concernOf.get(file.path) ?? "");
    const d = describeFile(file, concern?.name ?? "");
    nodes.push({
      kind: "file",
      tier: "artifact",
      externalId: fileKey(file.path),
      ...(concern ? { parent: key(concern.id) } : {}),
      title: file.path,
      brief: d.brief,
      summary: d.summary,
      terms: d.terms,
      url: blob(file.path),
    });
  }

  const ids = new Map<string, Id<"contextNodes">>();
  for (let i = 0; i < nodes.length; i += BATCH) {
    const written: { externalId: string; id: Id<"contextNodes"> }[] = await ctx.runMutation(
      internal.github.graphStore.writeNodes,
      {
      repoId: repo._id,
        nodes: nodes.slice(i, i + BATCH),
      },
    );
    for (const w of written) ids.set(w.externalId, w.id);
  }

  const edges: EdgeInput[] = [];
  const link = (from: string, to: string, rest: Omit<EdgeInput, "from" | "to">) => {
    const a = ids.get(from);
    const b = ids.get(to);
    if (a && b) edges.push({ from: a, to: b, ...rest });
  };
  for (const area of clustering.areas) {
    link(full, key(area.id), { family: "contains", type: "contains" });
    for (const concern of area.concerns) {
      link(key(area.id), key(concern.id), { family: "contains", type: "contains" });
      for (const path of concern.files) {
        link(fileKey(path), key(concern.id), { family: "about", type: "in" });
      }
    }
  }
  for (const ref of built.references) {
    link(fileKey(ref.from), fileKey(ref.to), { family: "references", type: ref.type });
  }
  for (const r of clustering.rollups) {
    link(key(r.from), key(r.to), {
      family: "references",
      type: "rollup",
      weight: Math.round(r.weight * 100) / 100,
    });
  }
  for (let i = 0; i < edges.length; i += BATCH * 2) {
    await ctx.runMutation(internal.github.graphStore.writeEdges, {
      repoId: repo._id,
      edges: edges.slice(i, i + BATCH * 2),
    });
  }
}

/** A concern at summary resolution: its files, and what each one exports. */
function outline(files: ParsedFile[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const f of files) {
    const line = f.exports.length ? `${f.path} — ${f.exports.slice(0, 6).join(", ")}` : f.path;
    if (size + line.length > 880) {
      lines.push(`…and ${files.length - lines.length} more files`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
}

/** ", mostly in src/lib" — where a concern's files live, when most share a place. */
function common(paths: readonly string[]): string {
  const dirs = new Map<string, number>();
  for (const p of paths) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (dir) dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
  }
  const top = [...dirs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  return top && top[1] * 2 >= paths.length ? `, mostly in ${top[0]}` : "";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
