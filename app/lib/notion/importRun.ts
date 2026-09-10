"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { seedUpdate } from "@/app/lib/onboarding/seed";
import type { SeedBlock } from "@/app/lib/onboarding/types";
import { convertPage } from "./convert";
import type { NotionBlock } from "./types";
import { pageIdResolver, planImport, type NotionImportPlan, type NotionPageNode } from "./plan";
import { toBlockNote } from "./toBlockNote";

/**
 * Running an import, from a ticked list of Notion pages to pages you can open.
 *
 * This lives on the client for the same reason the AI applier does: content is
 * authored through a real editor, so an imported page is built by exactly the
 * calls a person's typing makes. The server fetches, converts nothing, and
 * copies files; every document write goes through BlockNote and Yjs. There is
 * no second write path for the AI to be unable to drive.
 *
 * The two passes are not an optimisation. Every page must exist before any page
 * is filled, because a link from one imported page to another can only become a
 * `pageRef` once the page it points at has an id.
 */

export type ImportPhase = "planning" | "creating" | "importing" | "done" | "failed";

export type PageProgress = {
  notionId: string;
  title: string;
  /** `removed`: made in pass one, then taken back out — the run stopped before filling it, or filling it failed (`error` says why). */
  state: "waiting" | "fetching" | "copying" | "writing" | "done" | "failed" | "removed";
  /** When work on this page began; absent while it waits. */
  startedAt?: number;
  /** Files copied so far, while copying. */
  files?: { done: number; total: number };
  /** NML blocks written, once the page is done. */
  blocks?: number;
  /** Diagnostics by code, for the expandable detail on the report. */
  issues?: Record<string, number>;
  stubbed?: number;
  /** Files that would not come down, so the report can be honest about them. */
  lostMedia?: number;
  error?: string;
};

export type ImportProgress = {
  phase: ImportPhase;
  pages: PageProgress[];
  projectId?: Id<"projects">;
  error?: string;
};

export type ImportRequest = {
  client: ConvexReactClient;
  roots: NotionPageNode[];
  selection: ReadonlySet<string>;
  /** Where it lands. A new project is created when this is absent. */
  projectId?: Id<"projects">;
  /** Folder inside that project; absent is its top level. */
  folderId?: Id<"folders">;
  newProjectTitle?: string;
  onProgress: (progress: ImportProgress) => void;
  signal?: AbortSignal;
};

/**
 * How far one page is, as the bar sees it.
 *
 * Fetching cannot be measured — Notion hands blocks down a hundred at a time
 * with no count up front — so it is held partway rather than at zero, and the
 * copying stage owns most of the span because files are the slow part.
 */
export function pageFraction(page: PageProgress): number {
  switch (page.state) {
    case "waiting":
      return 0;
    case "fetching":
      return 0.15;
    case "copying": {
      const files = page.files;
      return 0.3 + 0.6 * (files?.total ? files.done / files.total : 0);
    }
    case "writing":
      return 0.95;
    default:
      return 1;
  }
}

/** The whole run's fraction, or nothing while it cannot yet be measured. */
export function importFraction(progress: ImportProgress): number | undefined {
  if (progress.phase !== "importing" || !progress.pages.length) return undefined;
  const sum = progress.pages.reduce((total, page) => total + pageFraction(page), 0);
  return sum / progress.pages.length;
}

/** Everything pass one makes, so a run that stops can take it back out. */
type Made = {
  projectId: Id<"projects">;
  fresh: boolean;
  folders: Map<string, Id<"folders">>;
  pages: Map<string, Id<"pages">>;
};

export async function runImport(request: ImportRequest): Promise<ImportProgress> {
  const { client, roots, selection, onProgress, signal } = request;
  const plan = planImport(roots, selection);

  const progress: ImportProgress = {
    phase: "planning",
    pages: plan.pages.map((page) => ({
      notionId: page.notionId,
      title: page.title,
      state: "waiting",
    })),
  };
  const report = () => onProgress({ ...progress, pages: [...progress.pages] });
  report();

  let made: Made | null = null;
  try {
    // ---- Pass one: every row exists before any of them is filled ----------
    progress.phase = "creating";
    report();

    const fresh = !request.projectId;
    const projectId =
      request.projectId ??
      ((await client.mutation(api.projects.create, {
        title: request.newProjectTitle?.trim() || "Imported from Notion",
      })) as Id<"projects">);
    progress.projectId = projectId;
    made = { projectId, fresh, folders: new Map(), pages: new Map() };

    // A new project is born holding one blank page so it is usable straight
    // away. An import fills it instead of leaving it beside the real pages:
    // adopted by the first page that belongs at the top level, and removed if
    // every page lands in a folder.
    const seeded = fresh
      ? ((await client.query(api.pages.listByProject, { projectId }))[0]?._id ?? null)
      : null;
    let adopted = false;

    const folderIds = made.folders;
    for (const folder of plan.folders) {
      stopIfAborted(signal);
      const parentId = folder.parentKey ? folderIds.get(folder.parentKey) : request.folderId;
      const id = (await client.mutation(api.folders.create, {
        projectId,
        title: folder.title,
        ...(parentId ? { parentId } : {}),
      })) as Id<"folders">;
      folderIds.set(folder.key, id);
      if (folder.emoji) {
        await client.mutation(api.folders.setIcon, {
          folderId: id,
          icon: { kind: "emoji", value: folder.emoji },
        });
      }
    }

    const pageIds = made.pages;
    const byNotionId = new Map<string, string>();
    for (const page of plan.pages) {
      stopIfAborted(signal);
      const folderId = page.folderKey ? folderIds.get(page.folderKey) : request.folderId;
      const reuse = seeded && !adopted && !folderId ? seeded : null;
      if (reuse) adopted = true;
      const id =
        reuse ??
        ((await client.mutation(api.pages.create, {
          projectId,
          title: page.title,
          ...(folderId ? { folderId } : {}),
        })) as Id<"pages">);
      if (reuse) await client.mutation(api.pages.rename, { pageId: reuse, title: page.title });
      pageIds.set(page.key, id);
      byNotionId.set(page.notionId, id);
      if (page.emoji) {
        await client.mutation(api.pages.setIcon, {
          pageId: id,
          icon: { kind: "emoji", value: page.emoji },
        });
      }
    }
    if (seeded && !adopted) await client.mutation(api.pages.remove, { pageId: seeded });
    const resolvePage = pageIdResolver(byNotionId);

    // ---- Pass two: fill them ---------------------------------------------
    progress.phase = "importing";
    report();

    for (const [index, planned] of plan.pages.entries()) {
      stopIfAborted(signal);
      const entry = progress.pages[index];
      try {
        await fillPage(client, {
          pageId: pageIds.get(planned.key)!,
          notionId: planned.notionId,
          resolvePage,
          signal,
          into: entry,
          report,
        });
      } catch (error) {
        if (isAbort(error)) throw error;
        entry.state = "failed";
        entry.error = message(error);
        report();
      }
    }

    // A page that failed is an empty page wearing a Notion title, whether the
    // run around it finished or not — a token revoked partway fails every
    // page after it and would otherwise leave a project full of them.
    if (progress.pages.some((page) => page.state === "failed")) {
      const gone = await unmake(client, plan, made, progress.pages);
      if (gone) progress.projectId = undefined;
    }

    progress.phase = "done";
    report();
    return progress;
  } catch (error) {
    progress.phase = "failed";
    progress.error = isAbort(error) ? "Import stopped." : message(error);
    if (made) {
      const gone = await unmake(client, plan, made, progress.pages);
      if (gone) progress.projectId = undefined;
    }
    report();
    return progress;
  }
}

/**
 * Take back what a run left half-made: the rows that never reached done.
 *
 * Pass one makes every row before pass two fills any, so stopping partway —
 * or a page failing inside a run that otherwise finished — leaves empty pages
 * wearing Notion titles, including a fresh project's seed page, renamed and
 * never written. Each row that never reached done is removed (its error is
 * kept, so the report can still say why), then any folder left holding
 * nothing, and a project this run made goes entirely when nothing landed in
 * it. Removals are individually guarded: a row that will not go is marked
 * failed rather than allowed to stop the rest from going. Returns whether the
 * project itself was removed.
 */
async function unmake(
  client: ConvexReactClient,
  plan: NotionImportPlan,
  made: Made,
  pages: PageProgress[],
): Promise<boolean> {
  const landed = new Set<string>();
  plan.pages.forEach((planned, index) => {
    if (pages[index].state === "done") landed.add(planned.key);
  });

  if (made.fresh && landed.size === 0) {
    try {
      await client.mutation(api.projects.remove, { projectId: made.projectId });
      for (const page of pages) if (page.state !== "done") page.state = "removed";
      return true;
    } catch {
      // Fall through to row-by-row removal; a project that stays at least
      // stays without empty pages in it.
    }
  }

  for (const [index, planned] of plan.pages.entries()) {
    const entry = pages[index];
    const pageId = made.pages.get(planned.key);
    if (entry.state === "done" || !pageId) continue;
    try {
      await client.mutation(api.pages.remove, { pageId });
      entry.state = "removed";
    } catch {
      entry.state = "failed";
      entry.error = "Left empty; it could not be removed.";
    }
  }

  // A folder is kept if any landed page is inside it, at any depth. Only the
  // topmost empty folders are removed — the mutation cascades to the rest.
  const parentOf = new Map(plan.folders.map((f) => [f.key, f.parentKey]));
  const keep = new Set<string>();
  for (const planned of plan.pages) {
    if (!landed.has(planned.key)) continue;
    for (let key = planned.folderKey; key; key = parentOf.get(key)) keep.add(key);
  }
  for (const folder of plan.folders) {
    const folderId = made.folders.get(folder.key);
    if (!folderId || keep.has(folder.key)) continue;
    if (folder.parentKey && !keep.has(folder.parentKey)) continue;
    try {
      await client.mutation(api.folders.remove, { folderId });
    } catch {
      // An empty folder that stays is untidy, not broken.
    }
  }
  return false;
}

/**
 * Fetch one Notion page, copy its files, and write it into a page that exists.
 *
 * The whole of an import's per-page work, in one place, because it is also the
 * whole of resolving a single reference: a link followed from inside a document
 * runs exactly what the wizard runs, on one page.
 */
async function fillPage(
  client: ConvexReactClient,
  options: {
    pageId: Id<"pages">;
    notionId: string;
    resolvePage: (notionPageId: string) => string | undefined;
    signal?: AbortSignal;
    into: PageProgress;
    report: () => void;
  },
): Promise<void> {
  const { into: entry, report, signal } = options;
  entry.state = "fetching";
  entry.startedAt = Date.now();
  report();

  const blocks = (await client.action(api.notion.pages.fetchBlocks, {
    pageId: options.notionId,
  })) as NotionBlock[];

  const converted = convertPage(options.notionId, blocks, {
    resolvePage: options.resolvePage,
  });

  // Files are copied before anything is written, so a page never appears
  // holding links that are already dying.
  const media = new Map<string, string>();
  let lostMedia = 0;
  if (converted.assets.length) {
    entry.state = "copying";
    entry.files = { done: 0, total: converted.assets.length };
    report();
  }
  for (const asset of converted.assets) {
    stopIfAborted(signal);
    const stored = (await client.action(api.notion.assets.rehost, {
      url: asset.url,
    })) as { url: string } | null;
    if (stored) media.set(asset.blockId, stored.url);
    else lostMedia++;
    entry.files = { done: entry.files!.done + 1, total: converted.assets.length };
    report();
  }

  entry.state = "writing";
  report();

  const page = await client.query(api.pages.get, { pageId: options.pageId });
  if (!page) throw new Error("The page vanished before it could be filled.");
  const stubs = new Map(
    converted.ledger.filter((e) => e.reason === "stubbed").map((e) => [e.blockId, e]),
  );
  await writeDocument(client, page.docId, toBlockNote(converted.blocks, media, stubs));

  const issues: Record<string, number> = {};
  for (const issue of converted.diagnostics) {
    issues[issue.code] = (issues[issue.code] ?? 0) + 1;
  }
  entry.state = "done";
  entry.blocks = count(converted.blocks);
  entry.issues = issues;
  entry.stubbed = stubs.size;
  entry.lostMedia = lostMedia;
  report();
}

/**
 * Bring in one page that a document already links to, beside the page linking
 * to it.
 *
 * Landing it in the same folder is what "here" means: you followed a reference
 * out of this page, so the thing you get back belongs next to it, not at the
 * top of a project you were not looking at.
 *
 * A page that could not be filled is taken back out: the link stays a Notion
 * link, followable again, rather than pointing at an empty page wearing the
 * title of the one that did not arrive.
 */
export async function importReferencedPage(
  client: ConvexReactClient,
  options: {
    projectId: Id<"projects">;
    folderId?: Id<"folders">;
    notionPageId: string;
    title: string;
    onProgress?: (page: PageProgress) => void;
    /** Stopping is the same as failing: the page is taken back out. */
    signal?: AbortSignal;
  },
): Promise<{ pageId: Id<"pages">; progress: PageProgress }> {
  const entry: PageProgress = {
    notionId: options.notionPageId,
    title: options.title,
    state: "waiting",
  };
  const report = () => options.onProgress?.({ ...entry });
  report();

  const pageId = (await client.mutation(api.pages.create, {
    projectId: options.projectId,
    title: options.title,
    ...(options.folderId ? { folderId: options.folderId } : {}),
  })) as Id<"pages">;

  try {
    await fillPage(client, {
      pageId,
      notionId: options.notionPageId,
      // Nothing else is being imported alongside it, so every other reference
      // this page carries stays a Notion link — followable the same way.
      resolvePage: () => undefined,
      signal: options.signal,
      into: entry,
      report,
    });
  } catch (error) {
    entry.state = "failed";
    entry.error = isAbort(error) ? "Import stopped." : message(error);
    try {
      await client.mutation(api.pages.remove, { pageId });
    } catch {
      // The failure above is the one worth reporting.
    }
    report();
  }
  return { pageId, progress: entry };
}

/**
 * Fill one page's document, by giving its Y.Doc the content it is born with.
 *
 * An imported page has never been opened, so it has no document on either
 * pipeline yet — `YConvexProvider` answers "not Yjs-native (yet)" and would
 * wait forever for a sync that nothing is going to start. There is no live
 * editor to hand content to and no reason to want one: the same move first run
 * already makes for its seeded pages is the right one here, and `seedUpdate`
 * is where it lives.
 *
 * Born on Yjs rather than the legacy pipeline for the reason `seed.ts` gives:
 * the pipeline a document is born on is the one it stays on, so seeding the
 * legacy side would make the first open of every imported page pay a migration
 * before it could read.
 */
async function writeDocument(
  client: ConvexReactClient,
  docId: string,
  blocks: ReturnType<typeof toBlockNote>,
): Promise<void> {
  if (!blocks.length) return;
  await client.mutation(api.ydoc.init, {
    docId,
    update: seedUpdate(blocks as SeedBlock[]),
  });
}

function count(blocks: { children: unknown[] }[]): number {
  return blocks.reduce(
    (total, block) => total + 1 + count(block.children as { children: unknown[] }[]),
    0,
  );
}

class Aborted extends Error {}
function stopIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Aborted("aborted");
}
const isAbort = (error: unknown) => error instanceof Aborted;
const message = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong.";
