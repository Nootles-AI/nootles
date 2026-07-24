"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Sidebar } from "./Sidebar";
import { PageSurface } from "./PageSurface";
import { ChatPanel } from "./ChatPanel";
import { ResizeHandle } from "./ResizeHandle";
import { PanelLeft, PanelRight } from "./Icons";

const LEFT = { def: 256, min: 200, max: 480 };
const RIGHT = { def: 320, min: 260, max: 560 };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function Workspace() {
  const [projectId, setProjectId] = useState<Id<"projects"> | null>(null);
  const [pageId, setPageId] = useState<Id<"pages"> | null>(null);

  const [leftWidth, setLeftWidth] = useState(LEFT.def);
  const [rightWidth, setRightWidth] = useState(RIGHT.def);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

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
  const effectiveProjectId = projectId ?? projects?.[0]?._id ?? null;

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

  return (
    <div className="flex h-screen w-full">
      {leftOpen ? (
        <>
          <Sidebar
            width={leftWidth}
            selectedProjectId={effectiveProjectId}
            selectedPageId={effectivePageId}
            onSelectProject={(id) => {
              setProjectId(id);
              setPageId(null);
            }}
            onSelectPage={setPageId}
            onCollapse={() => setLeftOpen(false)}
          />
          <ResizeHandle onResize={onResizeLeft} ariaLabel="Resize sidebar" />
        </>
      ) : (
        <EdgeToggle
          side="left"
          onClick={() => setLeftOpen(true)}
          label="Open sidebar"
        />
      )}

      <main className="flex min-w-0 flex-1">
        {effectivePageId ? (
          <PageSurface pageId={effectivePageId} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted">
            {projects && projects.length === 0
              ? "Create a project to get started."
              : "Select or create a page."}
          </div>
        )}
      </main>

      {rightOpen ? (
        <>
          <ResizeHandle onResize={onResizeRight} ariaLabel="Resize chat" />
          <ChatPanel width={rightWidth} onCollapse={() => setRightOpen(false)} />
        </>
      ) : (
        <EdgeToggle
          side="right"
          onClick={() => setRightOpen(true)}
          label="Open chat"
        />
      )}
    </div>
  );
}

function EdgeToggle({
  side,
  onClick,
  label,
}: {
  side: "left" | "right";
  onClick: () => void;
  label: string;
}) {
  return (
    <div
      className={`flex h-full w-9 shrink-0 flex-col items-center bg-surface pt-2.5 ${
        side === "left" ? "border-r border-border" : "border-l border-border"
      }`}
    >
      <button
        onClick={onClick}
        aria-label={label}
        title={label}
        className="rounded p-1 text-muted hover:bg-black/5 hover:text-foreground"
      >
        {side === "left" ? <PanelLeft /> : <PanelRight />}
      </button>
    </div>
  );
}
