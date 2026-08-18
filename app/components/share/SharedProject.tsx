"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { track } from "@/app/lib/telemetry";
import { Wordmark } from "../Brand";
import { ArrowLeft, ChevronRight, FileDoc, Folder, PanelLeft } from "../Icons";
import { CurrentPageProvider, useOpenPage } from "../OpenPageContext";
import { PagesProvider } from "../PagesContext";
import { flattenTree } from "../sidebarTree";
import { ReadOnlyContext } from "../editor/readOnly";
import { Facepile } from "../presence/Facepile";
import { GuestChatRail } from "./GuestChatRail";
import { SharedEditor } from "./SharedEditor";
import { SignInToEdit } from "./SignInToEdit";
import { following, writingKey } from "./intent";

/* The same threshold as the workspace: below it the rails become drawers. */
const COMPACT = "(max-width: 1023px)";

/* The sidebar's own step, so a shared tree indents exactly as its owner's does. */
const INDENT = 12;

/**
 * One project reached by share link, before any sign-in.
 *
 * Two faces, decided by which link this is. A viewer link is the quiet
 * read-only page it always was. An editor link dresses as the workspace —
 * rail, document, chat — because that is what it becomes the moment the guest
 * signs in; the banner says so, and any reach for the pen (a press into the
 * document, the chat, a key) answers with the sign-in modal instead of
 * silence.
 *
 * A visitor who is already signed in never sees any of it: the link claims
 * the project for them and carries them to the real workspace.
 */
export function SharedProject({ token }: { token: string }) {
  const shared = useQuery(api.share.view, { token });
  const { isLoaded, isSignedIn } = useAuth();
  const claim = useMutation(api.share.claim);
  const router = useRouter();
  // One column here, so the workspace's second pane never comes into it.
  const { main, open, back } = useOpenPage();
  const compact = useMediaQuery(COMPACT);
  const [drawer, setDrawer] = useState(false);
  // Folders the guest has closed. Not remembered between visits: a link is
  // read in one sitting, and it should always open showing the whole shape.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [claimFailed, setClaimFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // What kind of press is in flight, so a touch can be told apart from a
  // mouse at click time — a finger down is usually the start of a scroll,
  // not a reach for the pen, so touch waits for the tap to complete.
  const pressType = useRef("mouse");

  // Clerk's script can be blocked outright (privacy extensions, corporate
  // proxies). The document itself comes from Convex, so after a grace period
  // stop holding the page hostage to the auth check and open as signed-out;
  // if the script does land later, the signed-in hand-off still runs.
  const [authLate, setAuthLate] = useState(false);
  useEffect(() => {
    if (isLoaded) return;
    const grace = setTimeout(() => setAuthLate(true), 3000);
    return () => clearTimeout(grace);
  }, [isLoaded]);

  // Imperative hand-off, not derived state: the moment we know who this is,
  // the share surface's job is to record the claim and get out of the way.
  const claimed = useRef(false);
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !shared || claimed.current) return;
    claimed.current = true;
    void claim({ token })
      .then((projectId) => {
        track("share_claimed", { role: shared.role });
        router.replace(`/p/${projectId}`);
      })
      .catch(() => {
        // A link revoked mid-flight resolves itself: the query flips to null
        // and the not-shared state renders. Anything else — a dropped
        // connection, a server hiccup — re-runs nothing on its own, so it
        // must become a real state rather than a skeleton that never ends.
        claimed.current = false;
        setClaimFailed(true);
      });
  }, [isLoaded, isSignedIn, shared, claim, token, router, attempt]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // A dead link needs no auth to say so — before the Clerk gate, so it still
  // answers if the auth script is slow or blocked.
  if (shared === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <Link href="/" aria-label="Nootles" className="mb-4">
          <Wordmark className="text-muted" />
        </Link>
        <p className="text-sm font-medium">This project isn&apos;t shared</p>
        <p className="max-w-xs text-sm text-muted">
          The link may have been turned off. Ask whoever sent it to share the
          project again.
        </p>
      </div>
    );
  }

  // Loading, or signed in and about to leave for the workspace — either way,
  // the skeleton mirrors the shared chrome — header, rail, page column — so
  // the content lands in place rather than jumping right by a rail's width.
  const skeleton = (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      aria-busy="true"
    >
      <header
        className="relative flex h-12 shrink-0 items-center gap-2 px-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {/* Holds the hamburger's place, so the wordmark doesn't slide. */}
        {compact && <div className="w-8 shrink-0" aria-hidden />}
        <Link href="/" aria-label="Nootles" className="shrink-0">
          <Wordmark />
        </Link>
      </header>
      <div className="flex min-h-0 flex-1">
        {!compact && (
          <div className="nt-panel" style={{ width: 256 }} aria-hidden />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-auto">
          <div
            className="w-full px-6 py-12 sm:px-14 sm:py-20"
            style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
          >
            <div className="nt-skeleton h-8 w-1/2" />
            <div className="mt-8 space-y-3">
              <div className="nt-skeleton h-4 w-full" />
              <div className="nt-skeleton h-4 w-11/12" />
              <div className="nt-skeleton h-4 w-2/3" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );

  if (shared === undefined || (!isLoaded && !authLate)) return skeleton;

  if (isSignedIn) {
    if (!claimFailed) return skeleton;
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <Link href="/" aria-label="Nootles" className="mb-4">
          <Wordmark className="text-muted" />
        </Link>
        <p className="text-sm font-medium">Couldn&apos;t open this project</p>
        <p className="max-w-xs text-sm text-muted">
          Something went wrong on the way in — the connection may have
          dropped.
        </p>
        <button
          onClick={() => {
            setClaimFailed(false);
            setAttempt((n) => n + 1);
          }}
          className="nt-row nt-solid mt-2 px-3 font-medium"
        >
          Try again
        </button>
      </div>
    );
  }

  const editable = shared.role === "editor";
  const pages = shared.pages;
  // Resolved the way the workspace resolves it: a stale or foreign id falls
  // back to the first page rather than blanking the surface.
  const current = pages.find((p) => p._id === main.page) ?? pages[0] ?? null;

  // The owner's shape, read-only: the same tree, the same order, the same
  // rows — only the verbs that would change any of it are missing.
  const rows = flattenTree(shared.folders, pages, collapsed);
  const toggleFolder = (id: Id<"folders">) => {
    setCollapsed((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const rail = (
    <aside
      className="nt-panel nt-rail-l"
      style={{ width: compact ? 288 : 256 }}
      aria-label="Pages"
    >
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <div className="nt-section-label">
          <span>Pages</span>
        </div>
        <ul role="tree" aria-label="Pages and folders" className="space-y-px">
          {rows.map((row) => {
            const indent = {
              paddingLeft: `calc(var(--inset) + ${row.depth * INDENT}px)`,
            };
            if (row.kind === "folder") {
              return (
                <li key={row.folder._id} role="none">
                  <button
                    onClick={() => toggleFolder(row.folder._id)}
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={row.expanded}
                    aria-selected={false}
                    className="nt-row w-full"
                    style={indent}
                  >
                    <span className="nt-row-twist">
                      <ChevronRight
                        width={12}
                        height={12}
                        className={`nt-row-chevron${
                          row.expanded ? " is-open" : ""
                        }`}
                      />
                    </span>
                    <Folder width={14} height={14} className="nt-row-icon" />
                    <span className="nt-row-label">
                      {row.folder.title || "Untitled"}
                    </span>
                  </button>
                </li>
              );
            }
            const pg = row.page;
            const here = current?._id === pg._id;
            return (
              <li key={pg._id} role="none">
                <button
                  onClick={() => {
                    open(pg._id);
                    setDrawer(false);
                  }}
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-current={here ? "page" : undefined}
                  aria-selected={here}
                  className={`nt-row w-full${here ? " is-selected" : ""}`}
                  style={indent}
                >
                  <span className="nt-row-twist" />
                  <FileDoc width={14} height={14} className="nt-row-icon" />
                  <span className="nt-row-label">{pg.title || "Untitled"}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );

  return (
    <PagesProvider pages={pages}>
    <div className="flex h-screen w-full flex-col overflow-hidden">
      <header
        className="relative flex h-12 shrink-0 items-center gap-2 px-4"
        style={{ borderBottom: "1px solid var(--border)" }}
      >
        {compact && (
          <button
            onClick={() => setDrawer(true)}
            aria-label="Open pages"
            title="Pages"
            className="nt-icon-btn"
          >
            <PanelLeft />
          </button>
        )}
        <Link href="/" aria-label="Nootles" className="shrink-0">
          <Wordmark />
        </Link>
        {/* Centred on the bar itself, not on what the wordmark leaves over —
            except on compact, where the centre would run under the facepile;
            there it takes the room the wordmark leaves, truncating. */}
        <span
          className={
            compact
              ? "min-w-0 flex-1 truncate text-sm font-medium"
              : "absolute left-1/2 top-1/2 max-w-[40%] -translate-x-1/2 -translate-y-1/2 truncate text-sm font-medium"
          }
          title={shared.title || "Untitled project"}
        >
          {shared.title || "Untitled project"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Facepile docId={current?.docId ?? null} />
          {editable ? (
            <button
              onClick={() => setAsking(true)}
              className="nt-row shrink-0 px-2.5 text-muted"
            >
              Sign in
            </button>
          ) : (
            <span className="shrink-0 text-[13px] text-muted">Read-only</span>
          )}
        </div>
      </header>

      {editable && (
        <div className="nt-guest-banner">
          <span>This project is editable.</span>
          <button onClick={() => setAsking(true)}>Sign in to edit</button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {!compact && rail}

        <main className="flex min-w-0 flex-1 flex-col overflow-auto">
          {current ? (
            <div
              className="w-full px-6 py-12 sm:px-14 sm:py-20"
              style={{ maxWidth: "calc(var(--measure) + 7rem)" }}
            >
              {/* Following a chip somewhere needs a way home — same rule as
                  the workspace: present only once there is a back to mean. */}
              {main.canGoBack && (
                <div className="mb-6 flex justify-start">
                  <button
                    onClick={() => back("main")}
                    aria-label="Back to previous page"
                    title="Back to previous page"
                    className="nt-icon-btn"
                  >
                    <ArrowLeft />
                  </button>
                </div>
              )}
              {/* A mouse press answers on the way down; a finger waits for
                  the tap, because on touch the same press is how the page is
                  scrolled. */}
              <div
                onPointerDownCapture={
                  editable
                    ? (e) => {
                        pressType.current = e.pointerType;
                        if (e.pointerType !== "touch" && !following(e.target)) {
                          setAsking(true);
                        }
                      }
                    : undefined
                }
                onClickCapture={
                  editable
                    ? (e) => {
                        if (pressType.current === "touch" && !following(e.target)) {
                          setAsking(true);
                        }
                      }
                    : undefined
                }
                onKeyDownCapture={
                  editable
                    ? (e) => {
                        if (writingKey(e) && !following(e.target)) {
                          setAsking(true);
                        }
                      }
                    : undefined
                }
              >
                <h1 className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance break-words">
                  {current.title || "Untitled"}
                </h1>
                <div className="mt-8">
                  <ReadOnlyContext value={true}>
                    <CurrentPageProvider pageId={current._id}>
                      <SharedEditor key={current.docId} docId={current.docId} />
                    </CurrentPageProvider>
                  </ReadOnlyContext>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-muted">
              This project has no pages.
            </div>
          )}
        </main>

        {editable && !compact && (
          <GuestChatRail onIntercept={() => setAsking(true)} />
        )}
      </div>

      {compact && drawer && (
        <>
          <button
            aria-label="Close pages"
            onClick={() => setDrawer(false)}
            className="fixed inset-0 bg-foreground/15"
            style={{ zIndex: "var(--z-overlay)" }}
          />
          <div
            className="fixed inset-y-0 left-0 shadow-2xl"
            style={{ zIndex: "var(--z-modal)" }}
          >
            {rail}
          </div>
        </>
      )}

      {asking && <SignInToEdit token={token} onClose={() => setAsking(false)} />}
    </div>
    </PagesProvider>
  );
}
