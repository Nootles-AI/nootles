"use client";

import { useEffect, useRef } from "react";
import type { AbMessage } from "@/app/lib/ai/chat/types";

/**
 * The conversation.
 *
 * Assistant turns are unadorned prose in the document's own voice — no bubble,
 * no avatar — so the panel reads as part of the surface rather than as a chat
 * app bolted to its side. Only the user's turns get a container, which is what
 * makes the alternation legible without decoration.
 */
export function ChatTranscript({
  messages,
  busy,
  error,
}: {
  messages: AbMessage[];
  busy: boolean;
  error?: Error;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Follow the stream, but only when already at the bottom: yanking someone
  // back down while they are reading an earlier answer is worse than not
  // following at all.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const distance =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    if (distance < 120) endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (!messages.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm font-medium">Ask about this project</p>
        <p className="max-w-[28ch] text-[13px] text-muted">
          Questions are answered from what the pages actually say.
        </p>
      </div>
    );
  }

  return (
    <div ref={scrollerRef} className="ab-transcript">
      {messages.map((message) => (
        <div key={message.id} className={`ab-turn is-${message.role}`}>
          {message.parts.map((part, i) =>
            part.type === "text" ? (
              <p key={i} className="ab-turn-text">
                {part.text}
              </p>
            ) : null,
          )}
        </div>
      ))}

      {busy && <div className="ab-turn-pending">Thinking…</div>}
      {error && <div className="ab-turn-error">{error.message}</div>}
      <div ref={endRef} />
    </div>
  );
}
