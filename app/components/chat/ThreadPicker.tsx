"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Check, Trash } from "../Icons";

type Thread = {
  _id: Id<"chatThreads">;
  title: string;
  updatedAt: number;
};

/** Relative, because "which one was I just in" is the only question asked here. */
function ago(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function ThreadPicker({
  threads,
  activeId,
  onPick,
  onClose,
}: {
  threads: Thread[];
  activeId: Id<"chatThreads"> | null;
  onPick: (id: Id<"chatThreads"> | null) => void;
  onClose: () => void;
}) {
  const removeThread = useMutation(api.chat.threads.remove);

  return (
    <>
      <div className="fixed inset-0" style={{ zIndex: "var(--z-dropdown)" }} onMouseDown={onClose} />
      <div
        role="menu"
        aria-label="Chats"
        className="ab-menu absolute left-2 right-2 top-10 max-h-80 overflow-y-auto"
      >
        {!threads.length && (
          <div className="px-2 py-1.5 text-[13px] text-muted">No chats yet.</div>
        )}
        {threads.map((thread) => (
          <div key={thread._id} className="ab-thread-row">
            <button
              role="menuitem"
              className="ab-menu-item flex-1"
              onClick={() => {
                onPick(thread._id);
                onClose();
              }}
            >
              <span className="ab-thread-check">
                {thread._id === activeId && <Check width={13} height={13} />}
              </span>
              <span className="ab-row-label">{thread.title || "New chat"}</span>
              <span className="ab-thread-age">{ago(thread.updatedAt)}</span>
            </button>
            <button
              className="ab-icon-btn ab-thread-delete"
              aria-label={`Delete ${thread.title || "New chat"}`}
              title="Delete chat"
              onClick={() => {
                // Switching away first: deleting the open thread would otherwise
                // leave the transcript showing a conversation that is gone.
                if (thread._id === activeId) onPick(null);
                void removeThread({ threadId: thread._id });
              }}
            >
              <Trash width={14} height={14} />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
