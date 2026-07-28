"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useMediaQuery } from "@/app/lib/useMediaQuery";
import { Sidebar } from "./Sidebar";
import { PageSurface } from "./PageSurface";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";
import { PanelLeft, PanelRight } from "./Icons";

const LEFT = { def: 256, min: 200, max: 480 };
const RIGHT = { def: 320, min: 260, max: 560 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/* Below this the three fixed panels leave no usable column for the document
   (462px of chrome against a 560px viewport left 2px of text), so they stop
   being in-flow and become overlays the user summons. */
const COMPACT = "(max-width: 1023px)";

export function Workspace() {
  // /projects links back as /?project=<id>, so the URL seeds the selection and
  // an explicit in-app switch overrides it.
  const fromUrl = useSearchParams().get("project") as Id<"projects"> | null;
  const [projectId, setProjectId] = useState<Id<"projects"> | null>(null);
  const [pageId, setPageId] = useState<Id<"pages"> | null>(null);

  const [leftWidth, setLeftWidth] = useState(LEFT.def);
  const [rightWidth, setRightWidth] = useState(RIGHT.def);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);

  const compact = useMediaQuery(COMPACT);
  // Narrow: panels are overlays, and overlays start closed.
  const showLeft = leftOpen && !compact;
  const showRight = rightOpen && !compact;
  const openDrawer = compact ? drawer : null;

  // Restore persisted layout on the client. Defaults render first (so SSR and
  // the first client render match — no hydration mismatch), then we sync from
  // localStorage on mount; set-state-in-effect is the correct pattern here.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const s = (k: string) => localStorage.getItem(k);
    const lw = Number(s("ab:leftWidth"));
    const rw = Number(s("ab:rightWidth"));
    if (lw) setLeftWidth(clamp(lw, LEFT.min, LEFT.max));
    if (rw) setRightWidth(clamp(rw, RIGHT.min, RIGHT.max));
    if (s("ab:leftOpen") === "0") setLeftOpen(false);
    if (s("ab:rightOpen") === "0") setRightOpen(false);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    localStorage.setItem("ab:leftWidth", String(leftWidth));
    localStorage.setItem("ab:rightWidth", String(rightWidth));
    localStorage.setItem("ab:leftOpen", leftOpen ? "1" : "0");
    localStorage.setItem("ab:rightOpen", rightOpen ? "1" : "0");
  }, [leftWidth, rightWidth, leftOpen, rightOpen]);

  useEffect(() => {
    if (!openDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openDrawer]);

  const onResizeLeft = useCallback(
    (clientX: number) => setLeftWidth(clamp(clientX, LEFT.min, LEFT.max)),
    [],
  );
  const onResizeRight = useCallback(
    (clientX: number) =>
      setRightWidth(clamp(window.innerWidth - clientX, RIGHT.min, RIGHT.max)),
    [],
  );

  // Selection is derived, not synced via effects: `projectId`/`pageId` are the
  // user's explicit overrides; when unset (or stale for the current project) we
  // fall back to the first available item. This avoids set-state-in-effect
  // cascades.
  const projects = useQuery(api.projects.list);
  const effectiveProjectId = projectId ?? fromUrl ?? projects?.[0]?._id ?? null;

  const pages = useQuery(
    api.pages.listByProject,
    effectiveProjectId ? { projectId: effectiveProjectId } : "skip",
  );
  const sortedPages = pages
    ? [...pages].sort((a, b) => a.order - b.order)
    : undefined;
  const effectivePageId =
    pageId && sortedPages?.some((p) => p._id === pageId)
      ? pageId
      : (sortedPages?.[0]?._id ?? null);

  const sidebar = (
    <Sidebar
      width={compact ? 288 : leftWidth}
      selectedProjectId={effectiveProjectId}
      selectedPageId={effectivePageId}
      onSelectProject={(id) => {
        setProjectId(id);
        setPageId(null);
      }}
      onSelectPage={(id) => {
        setPageId(id);
        setDrawer(null);
      }}
      onCollapse={() => (compact ? setDrawer(null) : setLeftOpen(false))}
    />
  );

  const chat = (
    <ChatPanel
      width={compact ? 288 : rightWidth}
      onCollapse={() => (compact ? setDrawer(null) : setRightOpen(false))}
    />
  );

  return (
    <div className="flex h-screen w-full overflow-hidden">
      {showLeft ? (
        <>
          {sidebar}
          <ResizeHandle onResize={onResizeLeft} ariaLabel="Resize sidebar" />
        </>
      ) : (
        <EdgeRail
          side="left"
          onClick={() => (compact ? setDrawer("left") : setLeftOpen(true))}
          label="Open sidebar"
          expanded={openDrawer === "left"}
        />
      )}

      <div className="flex min-w-0 flex-1">
        {effectivePageId ? (
          <PageSurface pageId={effectivePageId} />
        ) : (
          <EmptyWorkspace hasProjects={!!projects && projects.length > 0} />
        )}
      </div>

      {showRight ? (
        <>
          <ResizeHandle onResize={onResizeRight} ariaLabel="Resize chat" />
          {chat}
        </>
      ) : (
        <EdgeRail
          side="right"
          onClick={() => (compact ? setDrawer("right") : setRightOpen(true))}
          label="Open chat"
          expanded={openDrawer === "right"}
        />
      )}

      {openDrawer && (
        <>
          <button
            aria-label="Close panel"
            onClick={() => setDrawer(null)}
            className="fixed inset-0 bg-foreground/15"
            style={{ zIndex: "var(--z-overlay)" }}
          />
          <div
            className={`fixed inset-y-0 ${
              openDrawer === "left" ? "left-0" : "right-0"
            } shadow-2xl`}
            style={{ zIndex: "var(--z-modal)" }}
          >
            {openDrawer === "left" ? sidebar : chat}
          </div>
        </>
      )}
    </div>
  );
}

function EmptyWorkspace({ hasProjects }: { hasProjects: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-sm font-medium">
        {hasProjects ? "No page open" : "Nothing here yet"}
      </p>
      <p className="max-w-xs text-sm text-muted">
        {hasProjects
          ? "Pick a page from the sidebar, or press + to start a new one."
          : "Create a project from the switcher at the bottom of the sidebar."}
      </p>
    </div>
  );
}

/**
 * The rail shown in place of a collapsed panel. Its padding matches the panel's
 * own `--inset`, so the toggle button keeps its size and its distance from the
 * edge whether the panel is open or closed, instead of jumping.
 */
function EdgeRail({
  side,
  onClick,
  label,
  expanded,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
  expanded: boolean;
}) {
  return (
    <div
      className={`flex h-full shrink-0 flex-col bg-surface p-2 ${
        side === "left" ? "border-r border-border" : "border-l border-border"
      }`}
    >
      <button
        onClick={onClick}
        aria-label={label}
        aria-expanded={expanded}
        title={label}
        className="ab-icon-btn"
      >
        {side === "left" ? <PanelLeft /> : <PanelRight />}
      </button>
    </div>
  );
}
