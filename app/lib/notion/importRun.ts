"use client";

import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { seedUpdate } from "@/app/lib/onboarding/seed";
import type { SeedBlock } from "@/app/lib/onboarding/types";
import { convertPage } from "./convert";
import type { NotionBlock } from "./types";
import { pageIdResolver, planImport, type NotionPageNode } from "./plan";
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
  state: "waiting" | "fetching" | "copying" | "writing" | "done" | "failed";
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

    // A new project is born holding one blank page so it is usable straight
    // away. An import fills it instead of leaving it beside the real pages:
    // adopted by the first page that belongs at the top level, and removed if
    // every page lands in a folder.
    const seeded = fresh
      ? ((await client.query(api.pages.listByProject, { projectId }))[0]?._id ?? null)
      : null;
    let adopted = false;

    const folderIds = new Map<string, Id<"folders">>();
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

    const pageIds = new Map<string, Id<"pages">>();
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

    progress.phase = "done";
    report();
    return progress;
  } catch (error) {
    progress.phase = "failed";
    progress.error = isAbort(error) ? "Import stopped." : message(error);
    report();
    return progress;
  }
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
    report();
  }
  for (const asset of converted.assets) {
    stopIfAborted(signal);
    const stored = (await client.action(api.notion.assets.rehost, {
      url: asset.url,
    })) as { url: string } | null;
    if (stored) media.set(asset.blockId, stored.url);
    else lostMedia++;
  }

  entry.state = "writing";
  report();

  const page = await client.query(api.pages.get, { pageId: options.pageId });
  if (!page) throw new Error("The page vanished before it could be filled.");
  await writeDocument(client, page.docId, toBlockNote(converted.blocks, media));

  const issues: Record<string, number> = {};
  for (const issue of converted.diagnostics) {
    issues[issue.code] = (issues[issue.code] ?? 0) + 1;
  }
  entry.state = "done";
  entry.blocks = count(converted.blocks);
  entry.issues = issues;
  entry.stubbed = converted.ledger.filter((e) => e.reason === "stubbed").length;
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
 */
export async function importReferencedPage(
  client: ConvexReactClient,
  options: {
    projectId: Id<"projects">;
    folderId?: Id<"folders">;
    notionPageId: string;
    title: string;
    onProgress?: (page: PageProgress) => void;
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
      into: entry,
      report,
    });
  } catch (error) {
    entry.state = "failed";
    entry.error = message(error);
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
