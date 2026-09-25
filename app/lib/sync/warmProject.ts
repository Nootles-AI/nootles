import type { ConvexReactClient } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Asks ahead of an open for everything the project's first frame waits on —
 * its pages and folders, the caller's role, the address check — and loads the
 * page it opens on, so opening is one round trip that already happened
 * instead of two in a row. Reads only; the subscriptions lapse by themselves
 * if the open never comes.
 *
 * `firstPageDocId` is the project summary's first page, which is the lowest
 * `order` the workspace falls back to when nothing is selected. A stale one
 * costs one wasted read.
 */
export function warmProject(
  client: ConvexReactClient,
  project: { _id: Id<"projects">; firstPageDocId?: string | null },
) {
  const args = { projectId: project._id };
  client.prewarmQuery({ query: api.pages.listByProject, args });
  client.prewarmQuery({ query: api.folders.listByProject, args });
  client.prewarmQuery({ query: api.projects.myRole, args });
  client.prewarmQuery({ query: api.projects.home, args });
  client.prewarmQuery({ query: api.projects.pausedBy, args });
  const docId = project.firstPageDocId;
  // Imported on use: the projects screen does not carry the sync layer (yjs
  // and all), and the open this predicts needs it anyway.
  if (docId) void import("./YConvexProvider").then(({ warmDoc }) => warmDoc(client, docId));
}
