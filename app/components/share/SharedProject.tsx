"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { track } from "@/app/lib/telemetry";
import { Wordmark } from "../Brand";
import { ArrowLeft, PanelLeft } from "../Icons";
import { CurrentPageProvider, useOpenPage } from "../OpenPageContext";
import { PagesProvider } from "../PagesContext";
import { ReadOnlyContext } from "../editor/readOnly";
import { Facepile } from "../presence/Facepile";
import { GuestChatRail } from "./GuestChatRail";
import { SharedEditor } from "./SharedEditor";
import { SignInToEdit } from "./SignInToEdit";

/* The same threshold as the workspace: below it the rails become drawers. */
const COMPACT = "(max-width: 1023px)";

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
  const [asking, setAsking] = useState(false);

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
        // The link died between loading and claiming; the surface will show
        // the not-shared state on the next query result.
        claimed.current = false;
      });
  }, [isLoaded, isSignedIn, shared, claim, token, router]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // Loading, or signed in and about to leave for the workspace — either way,
  // the skeleton mirrors the page column so the content lands in place.
  if (shared === undefined || !isLoaded || isSignedIn) {
    return (
      <div className="flex h-screen w-full items-start" aria-busy="true">
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
      </div>
    );
  }

  if (shared === null) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 px-6 text-center">
        <Wordmark className="mb-4 text-muted" aria-label="Nootles" />
        <p className="text-sm font-medium">This project isn&apos;t shared</p>
        <p className="max-w-xs text-sm text-muted">
          The link may have been turned off. Ask whoever sent it to share the
          project again.
        </p>
      </div>
    );
  }

  const editable = shared.role === "editor";
  const pages = shared.pages;
  // Resolved the way the workspace resolves it: a stale or foreign id falls
  // back to the first page rather than blanking the surface.
  const current = pages.find((p) => p._id === main.page) ?? pages[0] ?? null;

  /** A keystroke that means "I am writing", as opposed to navigating. */
  const writingKey = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    return e.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(e.key);
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
        <ul className="space-y-px">
          {pages.map((pg) => (
            <li key={pg.docId}>
              <button
                onClick={() => {
                  open(pg._id);
                  setDrawer(false);
                }}
                aria-current={current?._id === pg._id ? "page" : undefined}
                className={`nt-row w-full${
                  current?._id === pg._id ? " is-selected" : ""
                }`}
              >
                <span className="nt-row-label">{pg.title || "Untitled"}</span>
              </button>
            </li>
          ))}
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
        {/* Centred on the bar itself, not on what the wordmark leaves over. */}
        <span className="absolute left-1/2 top-1/2 max-w-[40%] -translate-x-1/2 -translate-y-1/2 truncate text-sm font-medium">
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
        <div className="nt-guest-banner" role="status">
          <span>This is an editable file.</span>
          <button onClick={() => setAsking(true)}>
            Sign up or log in to edit
          </button>
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
              <div
                onPointerDownCapture={
                  editable ? () => setAsking(true) : undefined
                }
                onKeyDownCapture={
                  editable
                    ? (e) => {
                        if (writingKey(e)) setAsking(true);
                      }
                    : undefined
                }
              >
                <h1 className="w-full text-[length:var(--text-title)] font-semibold tracking-[-0.02em] text-balance">
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
