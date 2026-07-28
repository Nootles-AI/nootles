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
      className="ab-panel"
      aria-label="Chat"
    >
      <div className="ab-panel-head">
        <span className="ab-panel-title">Chat</span>
        <button
          onClick={onCollapse}
          aria-label="Collapse chat"
          title="Collapse chat"
          className="ab-icon-btn"
        >
          <PanelRight />
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium">Copilot</p>
        <p className="max-w-[26ch] text-sm text-muted">
          Chat, diffs and checkpoints arrive in a later phase.
        </p>
      </div>

      {/* A real disabled control rather than a div dressed as one: it announces
          itself, and it will simply become enabled when chat ships. */}
      <div className="p-2">
        <textarea
          disabled
          rows={1}
          aria-label="Ask auto-board"
          placeholder="Ask auto-board…"
          className="w-full resize-none rounded-lg bg-sunken px-3 py-2 text-[13px] text-foreground placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-70"
        />
      </div>
    </aside>
  );
}
