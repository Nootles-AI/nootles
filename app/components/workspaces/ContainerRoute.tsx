"use client";

import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { withSlug } from "@/app/lib/containerPaths";
import { rememberWorkspace, seenWorkspace } from "@/app/lib/projectsCache";
import { Wordmark } from "../Brand";
import { ContainerProvider, type WorkspaceContainer } from "./ContainerContext";

const noop = () => () => {};

/**
 * `/w/<slug>` and everything under it: the address resolved to a workspace,
 * and that workspace provided as the container its pages are in.
 *
 * Resolved here in the browser rather than on the server, because an
 * operator's stand-in token only exists in the browser — a server lookup
 * would answer as the operator. The wait that costs is covered the way the
 * projects screen covers its own: what this address last resolved to in this
 * browser (`projectsCache`) stands in until `bySlug` answers, and is replaced
 * by whatever it says.
 *
 * An old address is moved to the current one where it stands, the rest of the
 * path kept, so a link to a project from before a rename still opens that
 * project. An address that is not a workspace the caller sits in reads exactly
 * like one that was never taken: `bySlug` says null for both.
 */
export function ContainerRoute({ slug, children }: { slug: string; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated } = useConvexAuth();
  const { userId } = useAuth();
  // False on the server and through hydration, so what storage holds cannot
  // make the first client render disagree with the server's.
  const hydrated = useSyncExternalStore(noop, () => true, () => false);
  // Never asked as nobody: an anonymous answer is null, which would read as
  // "no such workspace" for the moment before Convex has the token.
  const live = useQuery(api.workspaces.bySlug, isAuthenticated ? { slug } : "skip");

  const resolved = useMemo(
    (): WorkspaceContainer | null | undefined =>
      live &&
      ({
        kind: "workspace",
        workspaceId: live.workspace._id,
        slug: live.canonicalSlug,
        name: live.workspace.name,
        role: live.role,
      } as const),
    [live],
  );
  const seen = hydrated && userId ? seenWorkspace(userId, slug) : null;
  const container = resolved === undefined ? seen : resolved;

  useEffect(() => {
    if (userId && resolved !== undefined) rememberWorkspace(userId, slug, resolved);
  }, [userId, slug, resolved]);

  const canonical = resolved?.slug;
  useEffect(() => {
    if (!canonical || canonical === slug) return;
    const { search, hash } = window.location;
    router.replace(`${withSlug(pathname, canonical)}${search}${hash}`);
  }, [canonical, slug, pathname, router]);

  if (resolved === null) return <Nowhere />;
  if (!container) return <div className="flex-1" aria-busy="true" />;
  return <ContainerProvider value={container}>{children}</ContainerProvider>;
}

/**
 * The same few words whether the workspace does not exist or is not the
 * caller's to see, so an address cannot be used to learn which one it is.
 */
function Nowhere() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Link href="/" aria-label="Nootles" className="mb-4">
        <Wordmark className="text-muted" />
      </Link>
      <p className="text-sm font-medium">Nothing here</p>
      <p className="max-w-xs text-sm text-muted">
        This address doesn’t lead anywhere you can open. The link may be
        mistyped, or meant for another account.
      </p>
      <Link href="/" className="nt-row mt-2 px-2.5">
        Back to your projects
      </Link>
    </div>
  );
}
