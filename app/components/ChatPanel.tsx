"use client";

import { PanelRight } from "./Icons";

export function ChatPanel({
  width,
  onCollapse,
}: {
  width: number;
  onCollapse: () => void;
}) {
  return (
    <aside
      style={{ width }}
      className="flex h-full shrink-0 flex-col border-l border-border bg-surface"
    >
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="px-1 text-sm font-semibold tracking-tight">Chat</span>
        <button
          onClick={onCollapse}
          aria-label="Collapse chat"
          className="rounded p-1 text-muted hover:bg-black/5 hover:text-foreground"
        >
          <PanelRight />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-xs text-muted">
          The copilot lives here. Chat, diffs, and checkpoints arrive in a later
          phase.
        </p>
      </div>
      <div className="p-3">
        <div className="rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted">
          Ask auto-board…
        </div>
      </div>
    </aside>
  );
}
