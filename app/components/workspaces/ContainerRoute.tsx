"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  addressMove,
  homePath,
  projectIdIn,
  projectPath,
  settingsPath,
} from "@/app/lib/containerPaths";
import { rememberWorkspace, seenWorkspace } from "@/app/lib/projectsCache";
import { Wordmark } from "../Brand";
import { HomeLoading } from "../ProjectsLoading";
import { SettingsLoading } from "../settings/SettingsLoading";
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
 * by whatever it says. The ways into a workspace tell the cache before they
 * go — the switcher, making one, accepting an invitation — and an address
 * this browser has never seen draws a home's frame while it waits.
 *
 * An old address is moved to the current one, the rest of the path kept, so a
 * link to a project from before a rename still opens that project — and a
 * rename made while someone is here changes only what their address bar says
 * (`addressMove`). An address that is not a workspace the caller sits in
 * reads exactly like one that was never taken: `bySlug` says null for both.
 *
 * Except one that answered and then stopped: the workspace was deleted, or
 * left, or its seat taken away, while someone was in it. That is not an
 * address that leads nowhere — it is a place that has just gone — so they
 * are taken home, not told the address is wrong. Deleting and leaving go home
 * themselves, but only once the mutation has answered, and by then this
 * answer has already come back null.
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

  // The address that has resolved while this was open — kept from an earlier
  // render, which is what tells a workspace gone from one never here.
  const [held, setHeld] = useState<string | null>(null);
  if (resolved && held !== slug) setHeld(slug);
  const gone = resolved === null && held === slug;
  useEffect(() => {
    if (gone) router.replace(homePath(null));
  }, [gone, router]);

  useEffect(() => {
    if (userId && resolved !== undefined) rememberWorkspace(userId, slug, resolved);
  }, [userId, slug, resolved]);

  // What the address was on its first answer, which is what tells arriving
  // at an old address from staying on one while it is renamed.
  const canonical = resolved?.slug;
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!canonical) return;
    opened.current ??= canonical;
    const move = addressMove(pathname, { slug, canonical: opened.current }, canonical);
    if (!move) return;
    const { search, hash } = window.location;
    if (move.navigate) router.replace(`${move.to}${search}${hash}`);
    else window.history.replaceState(null, "", `${move.to}${search}${hash}`);
  }, [canonical, slug, pathname, router]);

  if (gone) return <div className="flex-1" aria-busy="true" />;
  if (resolved === null) return <Nowhere projectId={projectIdIn(pathname)} />;
  if (!container) {
    if (pathname.startsWith(settingsPath(slug))) return <SettingsLoading workspace />;
    return hydrated && pathname === homePath(slug) ? (
      <HomeLoading />
    ) : (
      <div className="flex-1" aria-busy="true" />
    );
  }
  return <ContainerProvider value={container}>{children}</ContainerProvider>;
}

/**
 * The same few words whether the workspace does not exist or is not the
 * caller's to see, so an address cannot be used to learn which one it is.
 *
 * Except for a project someone can open by another door — a link they were
 * given, a seat in the workspace it is really in: a teammate's copied address
 * takes them on to the one it answers to for them (`projects.home`). That
 * says nothing about the workspace named in the address, since the answer is
 * the same whatever it names.
 */
function Nowhere({ projectId }: { projectId: string | null }) {
  const router = useRouter();
  const home = useQuery(api.projects.home, projectId ? { projectId } : "skip");
  const there = projectId && home ? projectPath(home.slug, projectId) : null;

  useEffect(() => {
    if (!there) return;
    const { search, hash } = window.location;
    router.replace(`${there}${search}${hash}`);
  }, [there, router]);

  if (there || (projectId && home === undefined)) {
    return <div className="flex-1" aria-busy="true" />;
  }
  return <NothingHere />;
}

export function NothingHere() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <Link href="/" aria-label="Nootles" className="mb-4">
        <Wordmark className="text-muted" />
      </Link>
      <p className="text-[length:var(--text-body)] font-medium">Nothing here</p>
      <p className="max-w-xs text-[length:var(--text-ui)] text-pretty text-muted">
        This address doesn’t lead anywhere you can open. The link may be
        mistyped, or meant for another account.
      </p>
      <Link href="/" className="nt-row mt-2 px-2.5">
        Back to your projects
      </Link>
    </div>
  );
}
