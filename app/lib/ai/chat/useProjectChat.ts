"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DefaultChatTransport } from "ai";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BrowserChat, ChatStore } from "./BrowserChat";
import type { AbMessage, ChatMode } from "./types";

const EMPTY = {
  messages: [] as AbMessage[],
  status: "ready" as const,
  error: undefined,
};

/**
 * Binds one thread to a `BrowserChat`.
 *
 * The chat is built in an effect rather than during render. It is not a derived
 * value — it owns a transport, an abort signal and a subscription, and the
 * project's rule against set-state-in-effect is about values you can compute
 * from props, not about constructing something with a lifecycle. Building it
 * during render would also mean reading refs there, which the lint forbids.
 */
export function useProjectChat({
  threadId,
  pageId,
  mode,
}: {
  threadId: Id<"chatThreads"> | null;
  pageId: Id<"pages"> | null;
  mode: ChatMode;
}) {
  const persisted = useQuery(
    api.chat.messages.list,
    threadId ? { threadId } : "skip",
  );
  const putMessage = useMutation(api.chat.messages.put);
  const renameThread = useMutation(api.chat.threads.rename);

  const [chat, setChat] = useState<BrowserChat | null>(null);

  // Read by callbacks that outlive the render that created them. Declared first
  // so it is up to date before the effect below builds anything from it.
  const latest = useRef({
    threadId,
    pageId,
    mode,
    persisted,
    putMessage,
    renameThread,
  });
  useEffect(() => {
    latest.current = { threadId, pageId, mode, persisted, putMessage, renameThread };
  });

  // Wait for history before building, or the first question would reach the
  // model without the conversation it belongs to.
  const hydrated = !threadId || persisted !== undefined;
  const key = threadId ?? "none";

  useEffect(() => {
    if (!hydrated) return;

    const initial = (latest.current.persisted ?? []).map((row) => ({
      id: row.uiId,
      role: row.role,
      parts: row.parts,
      metadata: row.metadata,
    })) as AbMessage[];

    const next = new BrowserChat({
      store: new ChatStore(initial),
      transport: new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            mode: latest.current.mode,
            pageId: latest.current.pageId,
          },
        }),
      }),
      onFinish: ({ message }) => {
        const { threadId: id, putMessage: put } = latest.current;
        if (!id) return;
        void put({
          threadId: id,
          uiId: message.id,
          role: "assistant",
          parts: message.parts,
          metadata: message.metadata,
        });
      },
    });

    setChat(next);
    // Switching threads mid-answer abandons that answer; leaving it running
    // would stream tokens into a transcript nobody is looking at.
    return () => {
      void next.stop();
    };
  }, [key, hydrated]);

  const store = chat?.store;
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => store?.subscribe(listener) ?? noop, [store]),
    () => store?.getSnapshot() ?? EMPTY,
    () => EMPTY,
  );

  const send = useCallback(
    async (text: string) => {
      const { threadId: id, pageId: page, mode: m } = latest.current;
      if (!chat || !id || !text.trim()) return;

      await chat.sendMessage({
        text,
        metadata: { pageIdAtSend: page ?? undefined, mode: m },
      });

      // Persisted from the store, not from `text`: the SDK owns the message id,
      // and that id is what makes the write idempotent on a retry.
      const sent = [...chat.messages].reverse().find((m2) => m2.role === "user");
      if (sent) {
        void latest.current.putMessage({
          threadId: id,
          uiId: sent.id,
          role: "user",
          parts: sent.parts,
          metadata: sent.metadata,
          pageIdAtSend: page ?? undefined,
        });
      }
    },
    [chat],
  );

  /** The first thing asked names the thread, the way Cursor titles a chat. */
  const nameThreadFrom = useCallback((text: string) => {
    const { threadId: id, renameThread: rename } = latest.current;
    if (!id) return;
    const title = text.trim().replace(/\s+/g, " ").slice(0, 60);
    if (title) void rename({ threadId: id, title });
  }, []);

  const stop = useCallback(() => void chat?.stop(), [chat]);

  return {
    messages: snapshot.messages,
    status: snapshot.status,
    error: snapshot.error,
    send,
    nameThreadFrom,
    stop,
    ready: hydrated && !!chat,
  };
}

const noop = () => {};
