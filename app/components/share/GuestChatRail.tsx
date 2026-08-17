"use client";

import { Paperclip } from "../Icons";
import { writingKey } from "./intent";

/**
 * The chat rail as a guest sees it: the same frame, the same composer, none of
 * the machinery. It exists so an editable share link looks like the workspace
 * it is — and so reaching for the chat is an edit attempt like any other,
 * answered by the sign-in modal rather than by a rail that simply isn't there.
 *
 * Every control routes to `onIntercept`; nothing here ever sends anything.
 * Except the keyboard passing through: Tab is navigation, not writing, so the
 * modal waits for a writing key or a paste rather than seizing focus itself.
 */
export function GuestChatRail({ onIntercept }: { onIntercept: () => void }) {
  return (
    <aside
      style={{ width: 320 }}
      className="nt-panel relative nt-rail-r"
      aria-label="Chat"
    >
      <div className="nt-panel-head">
        <span className="nt-panel-title min-w-0 flex-1 text-muted">Chat</span>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <p className="text-[13px] text-muted">
          Sign in to ask about this project or have the assistant edit it.
        </p>
      </div>

      {/* Focus never lands in a box that can't take input; a mouse press
          answers immediately, a finger on the completed tap — on touch the
          same press may be the start of a scroll. The click capture also
          answers for the attach button, however it was activated. */}
      <div
        className="nt-composer"
        onPointerDownCapture={(e) => {
          e.preventDefault();
          if (e.pointerType !== "touch") onIntercept();
        }}
        onClickCapture={onIntercept}
      >
        <textarea
          rows={1}
          readOnly
          value=""
          aria-label="Ask Nootles (sign in to chat)"
          placeholder="Ask, or describe a change…"
          className="nt-composer-input"
          onKeyDown={(e) => {
            if (!writingKey(e)) return;
            e.preventDefault();
            onIntercept();
          }}
          onPaste={(e) => {
            e.preventDefault();
            onIntercept();
          }}
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
