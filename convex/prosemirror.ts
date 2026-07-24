import { components } from "./_generated/api";
import { ProsemirrorSync } from "@convex-dev/prosemirror-sync";

/**
 * Collaborative sync for each page's block flow. The client (BlockNote) talks to
 * these endpoints via useBlockNoteSync; steps + snapshots are persisted by the
 * prosemirror-sync component. v0 permissions are open (single-user).
 */
const prosemirrorSync = new ProsemirrorSync(components.prosemirrorSync);

export const { getSnapshot, submitSnapshot, latestVersion, getSteps, submitSteps } =
  prosemirrorSync.syncApi({
    // TODO(auth): gate reads/writes by owner once tenancy lands.
  });
