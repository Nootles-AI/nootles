"use client";

import { Paperclip } from "../Icons";

/**
 * The chat rail as a guest sees it: the same frame, the same composer, none of
 * the machinery. It exists so an editable share link looks like the workspace
 * it is — and so reaching for the chat is an edit attempt like any other,
 * answered by the sign-in modal rather than by a rail that simply isn't there.
 *
 * Every control routes to `onIntercept`; nothing here ever sends anything.
 */
export function GuestChatRail({ onIntercept }: { onIntercept: () => void }) {
  return (
    <aside
      style={{ width: 320 }}
      className="nt-panel relative nt-rail-r"
      aria-label="Chat"
    >
      <div className="nt-panel-head">
        <div className="nt-row min-w-0 flex-1">
          <span className="nt-row-label text-muted">Chat</span>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-[13px] text-muted">
          Sign in to ask about this project or have the assistant edit it.
        </p>
      </div>

      <div
        className="nt-composer"
        onPointerDownCapture={(e) => {
          e.preventDefault();
          onIntercept();
        }}
      >
        <textarea
          rows={1}
          readOnly
          value=""
          aria-label="Ask Nootles (sign in to chat)"
          placeholder="Ask, or describe a change…"
          className="nt-composer-input"
          onFocus={onIntercept}
        />
        <div className="nt-composer-actions">
          <div className="flex items-center gap-1">
            <button
              className="nt-composer-attach"
              aria-label="Attach a file (sign in to chat)"
              title="Attach a file"
            >
              <Paperclip width={14} height={14} />
            </button>
          </div>
          <button className="nt-composer-send" disabled title="Send">
            Send
          </button>
        </div>
      </div>
    </aside>
  );
}
