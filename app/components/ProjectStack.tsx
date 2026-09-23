"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { projectPath } from "@/app/lib/containerPaths";
import { Authed } from "./Authed";
import { Wordmark } from "./Brand";
import { EditorRegistryProvider } from "./editor/EditorRegistry";
import { OpenPageProvider } from "./OpenPageContext";
import { ReviewProvider } from "./ReviewContext";
import { Workspace } from "./Workspace";
import { slugOf, useContainer } from "./workspaces/ContainerContext";

/**
 * One project, open — the same stack at `/p/<id>` and at
 * `/w/<slug>/p/<id>`, so a project cannot look or behave differently for
 * which of its addresses it was reached at.
 *
 * All three providers sit above the workspace because the chat panel is a
 * sibling of the document, not a parent of it: this is where they meet.
 */
export function ProjectStack({ projectId }: { projectId: string }) {
  // The id is not checked here: every query under it answers "not yours"
  // for an id that names nothing, the same as for one the caller can't see.
  const id = projectId as Id<"projects">;
  return (
    <Authed>
      <InItsHome projectId={projectId}>
        <EditorRegistryProvider>
          <OpenPageProvider>
            <ReviewProvider projectId={id}>
              <Workspace projectId={id} />
            </ReviewProvider>
          </OpenPageProvider>
        </EditorRegistryProvider>
      </InItsHome>
    </Authed>
  );
}

/**
 * Moves the project to the address it answers to (`projects.home`) when it
 * was reached at another: an old `/p/` link to a workspace project, or the
 * address of a workspace it is not in. (Someone without a seat in the
 * workspace an address names never gets this far — `ContainerRoute` sends
 * them on.)
 *
 * The stack is not held back while the answer is on its way. Nearly every
 * open is already at the right address, and holding it would put a round trip
 * in front of every one of them; the answer is asked for alongside the
 * project's own first reads and usually lands with them, before anything but
 * the skeleton has drawn.
 *
 * An answer of "nowhere" is said in place of the project: most often by
 * someone whose way in was taken away — removed from it, or its link turned
 * off or expired — who would otherwise land in what looks like an empty
 * project of their own.
 */
function InItsHome({ projectId, children }: { projectId: string; children: ReactNode }) {
  const router = useRouter();
  const here = slugOf(useContainer());
  const home = useQuery(api.projects.home, { projectId });
  const elsewhere = home && home.slug !== here ? projectPath(home.slug, projectId) : null;

  useEffect(() => {
    if (!elsewhere) return;
    const { search, hash } = window.location;
    router.replace(`${elsewhere}${search}${hash}`);
  }, [elsewhere, router]);

  if (elsewhere) return <div className="flex-1" aria-busy="true" />;
  if (home === null) return <NoAccess />;
  return <>{children}</>;
}

function NoAccess() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Link href="/" aria-label="Nootles" className="mb-4">
        <Wordmark className="text-muted" />
      </Link>
      <p className="text-sm font-medium">You don’t have access to this project</p>
      <p className="max-w-xs text-sm text-muted">
        Whoever shared it may have removed you or turned off its link, or it
        may have been deleted. Ask them to share it again.
      </p>
      <Link href="/" className="nt-row mt-2 px-2.5">
        Back to your projects
      </Link>
    </div>
  );
}
