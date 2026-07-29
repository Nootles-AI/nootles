"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatOnToolCallCallback,
} from "ai";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useOpenPage } from "@/app/components/OpenPageContext";
import { useReview } from "@/app/components/ReviewContext";
import { useEditorRegistry } from "@/app/components/editor/EditorRegistry";
import { BrowserChat, ChatStore, isAnswered } from "./BrowserChat";
import { withAttachmentUrls, type ReadyAttachment } from "./attachments";
import { runClientTool, type ToolContext } from "./clientTools";
import { resolveMentions, type MentionPick } from "./mentions";
import type { MentionData } from "./parts";
import { isClientTool } from "./tools";
import type { AbMessage, ChatMode } from "./types";

/** What the composer hands over: the words, and what was attached to them. */
export type ChatDraft = {
  text: string;
  attachments: ReadyAttachment[];
  mentions: MentionPick[];
};

const EMPTY = {
  messages: [] as AbMessage[],
  status: "ready" as const,
  error: undefined,
  busy: false,
  approval: null,
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
  projectId,
  pageId,
  mode,
}: {
  threadId: Id<"chatThreads"> | null;
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
  mode: ChatMode;
}) {
  const persisted = useQuery(
    api.chat.messages.list,
    threadId ? { threadId } : "skip",
  );
  const putMessage = useMutation(api.chat.messages.put);
  const renameThread = useMutation(api.chat.threads.rename);
  const convex = useConvex();
  const { open } = useOpenPage();
  const registry = useEditorRegistry();
  const review = useReview();

  const [built, setBuilt] = useState<{ key: string; chat: BrowserChat } | null>(null);

  // Read by callbacks that outlive the render that created them. Declared first
  // so it is up to date before the effect below builds anything from it.
  const latest = useRef({
    threadId,
    projectId,
    pageId,
    mode,
    persisted,
    putMessage,
    renameThread,
    convex,
    open,
    registry,
    review,
  });
  useEffect(() => {
    latest.current = {
      threadId,
      projectId,
      pageId,
      mode,
      persisted,
      putMessage,
      renameThread,
      convex,
      open,
      registry,
      review,
    };
  });

  // Wait for history before building, or the first question would reach the
  // model without the conversation it belongs to.
  const hydrated = !threadId || persisted !== undefined;
  const key = threadId ?? "none";

  // A chat is only ever the one built for the thread on screen. The instance
  // and its key travel together because the commit that re-keys is a commit
  // before the one that rebuilds — and the old instance has already been
  // cancelled by then, so a message sent into it would stream into a store
  // nothing reads and be persisted under no thread at all.
  const chat = built?.key === key ? built.chat : null;

  // Built when it is needed rather than when the chat was, and its page read
  // later still — `open_page` leaves the new page behind in a React commit, so
  // a context that captured it would be one reading the old one.
  const makeContext = useCallback(
    (): ToolContext => ({
      convex: latest.current.convex,
      projectId: latest.current.projectId,
      review: latest.current.review,
      openPageId: () => latest.current.pageId,
      openPage: latest.current.open,
      editorFor: (pageId) => latest.current.registry.editorFor(pageId),
    }),
    [],
  );

  useEffect(() => {
    if (!hydrated) return;

    const initial = (latest.current.persisted ?? []).map((row) => ({
      id: row.uiId,
      role: row.role,
      parts: withAttachmentUrls(row.parts, row.attachmentUrls),
      metadata: row.metadata,
    })) as AbMessage[];

    // Bound, not read at write time: React runs every cleanup before it runs the
    // next effect, so a write still in flight would otherwise land in whichever
    // thread the user has just switched to.
    const boundThreadId = latest.current.threadId;

    const persist = (message: AbMessage) => {
      if (!boundThreadId) return;
      // A call with no result is a question the model was never answered, and
      // replayed from the database it strands every later turn in the thread.
      // `answer` writes the message again once the result is in.
      const parts = message.parts.filter(isAnswered);
      if (!parts.some((part) => part.type !== "step-start")) return;
      void latest.current.putMessage({
        threadId: boundThreadId,
        uiId: message.id,
        role: "assistant",
        parts,
        metadata: message.metadata,
      });
    };

    let queue = Promise.resolve();

    const next: BrowserChat = new BrowserChat({
      store: new ChatStore(initial),
      transport: new DefaultChatTransport({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ messages }) => ({
          body: {
            messages,
            mode: latest.current.mode,
            projectId: latest.current.projectId,
            pageId: latest.current.pageId,
          },
        }),
      }),
      // Fires for every tool call, including the ones the route answered
      // itself — those already have their result and must be left alone.
      onToolCall: ({ toolCall }) => {
        if (!isClientTool(toolCall.toolName)) return;
        // Counted from the moment it ARRIVES, not from when the queue reaches
        // it. The stream has already ended by then, so between two tools of one
        // step nothing else is running — and a turn that momentarily looks
        // finished is a turn whose review is settled while the agent is still
        // editing into it.
        next.store.toolStarted(toolCall.toolCallId);
        // Queued, not fired: a step routinely carries several client tools, and
        // they are not independent — the page `read_open_page` is meant to read
        // is the one the `open_page` before it opened. Rejections take the
        // failure branch too, so a tool that threw does not strand the rest.
        const run = answer(next, makeContext(), toolCall, persist);
        queue = queue.then(run, run);
      },
      // A tool the browser answered, or a call the user allowed, is the middle
      // of a turn: the model has to be handed the outcome to carry on with.
      // Both conditions insist on the whole step being settled, so a step that
      // reads a page AND asks to delete one resumes once, when both are.
      sendAutomaticallyWhen: (options) =>
        lastAssistantMessageIsCompleteWithToolCalls(options) ||
        lastAssistantMessageIsCompleteWithApprovalResponses(options),
      onFinish: ({ message }) => persist(message),
    });

    setBuilt({ key, chat: next });
    // Switching threads mid-answer abandons that answer; leaving it running
    // would stream tokens into a transcript nobody is looking at.
    return () => {
      void next.cancel();
    };
  }, [key, hydrated, makeContext]);

  const store = chat?.store;
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => store?.subscribe(listener) ?? noop, [store]),
    () => store?.getSnapshot() ?? EMPTY,
    () => EMPTY,
  );

  /**
   * The turn a review belongs to, and when it is over — which is NOT when
   * `sendMessage` resolves. A client tool ends the request that carried it and
   * the browser resumes with a new one, so one turn is several requests, and
   * `busy` is the only thing that spans all of them.
   */
  const turn = useRef<{ chatPromptId: string; started: boolean } | null>(null);
  useEffect(() => {
    const current = turn.current;
    if (!current) return;
    if (snapshot.busy) {
      current.started = true;
      return;
    }
    if (!current.started) return;
    turn.current = null;
    void latest.current.review.endTurn(current.chatPromptId);
  }, [snapshot.busy]);

  const send = useCallback(
    async (draft: ChatDraft) => {
      const { threadId: id, projectId: pid, pageId: page, mode: m } = latest.current;
      // Never into a turn that is still running: the loop hands a tool result to
      // whatever message is last, and that would now be this one.
      if (!chat || !id || !hasContent(draft) || chat.store.getSnapshot().busy) return;

      // Read here, before anything is written down: a mention means the page as
      // it stands at the moment the user asked, and the agent is about to start
      // moving between pages and changing them.
      const mentions = await resolveMentions(draft.mentions, makeContext());
      const { parts, attachments } = userParts(draft, mentions);

      // Written before the turn runs, with an id minted here rather than by the
      // SDK. `sendMessage` only resolves once the answer is finished, and the
      // answer is persisted on the way out of it — so a user row written after
      // that await would be given the later `seq` of the two, and the thread
      // would reload, and be re-sent to the model, answer before question.
      const chatPromptId = crypto.randomUUID();
      const message = {
        id: crypto.randomUUID(),
        role: "user" as const,
        parts,
        metadata: { pageIdAtSend: page ?? undefined, mode: m, chatPromptId },
      };
      void latest.current.putMessage({
        threadId: id,
        uiId: message.id,
        role: "user",
        parts: message.parts,
        metadata: message.metadata,
        chatPromptId,
        pageIdAtSend: page ?? undefined,
        ...(attachments.length ? { attachments } : {}),
      });

      turn.current = { chatPromptId, started: false };
      void latest.current.review.beginTurn({ threadId: id, projectId: pid, chatPromptId });
      await chat.sendMessage(message);
    },
    [chat, makeContext],
  );

  /** The first thing asked names the thread, the way Cursor titles a chat. */
  const nameThreadFrom = useCallback((text: string) => {
    const { threadId: id, renameThread: rename } = latest.current;
    if (!id) return;
    const title = text.trim().replace(/\s+/g, " ").slice(0, 60);
    if (title) void rename({ threadId: id, title });
  }, []);

  /**
   * The user's answer to a call the agent may not make alone. Read from the
   * store rather than closed over, so the answer can only ever belong to the
   * request currently on screen.
   */
  const answerApproval = useCallback(
    (approved: boolean) => {
      const approval = chat?.store.getSnapshot().approval;
      if (!chat || !approval) return;
      void chat.addToolApprovalResponse({
        id: approval.id,
        approved,
        ...(approved ? {} : { reason: DECLINED }),
      });
    },
    [chat],
  );

  const stop = useCallback(() => void chat?.cancel(), [chat]);

  return {
    messages: snapshot.messages,
    error: snapshot.error,
    busy: snapshot.busy,
    approval: snapshot.approval,
    send,
    nameThreadFrom,
    answerApproval,
    stop,
    ready: hydrated && !!chat,
  };
}

/** Worth sending if it says something or carries something. */
function hasContent(draft: ChatDraft): boolean {
  return Boolean(draft.text.trim() || draft.attachments.length);
}

type StoredAttachment = {
  storageId: Id<"_storage">;
  partIndex: number;
  mediaType: string;
  filename: string;
};

/**
 * The message as parts, in the order it is meant to be read: what came with the
 * question, then the question.
 *
 * An image is the one thing that does not travel inside the message — it is a
 * file part pointing at storage, and the sidecar records which part that was,
 * because the URL in it is stale by the next read.
 */
function userParts(
  draft: ChatDraft,
  mentions: MentionData[],
): { parts: AbMessage["parts"]; attachments: StoredAttachment[] } {
  const parts: AbMessage["parts"] = [];
  const attachments: StoredAttachment[] = [];

  for (const file of draft.attachments) {
    const { filename, mediaType } = file;
    if (file.kind === "image") {
      attachments.push({ storageId: file.storageId, partIndex: parts.length, mediaType, filename });
      parts.push({ type: "file", mediaType, filename, url: file.url });
    } else {
      parts.push({ type: "data-attachment", data: { filename, mediaType, text: file.text } });
    }
  }
  for (const data of mentions) parts.push({ type: "data-mention", data });

  // An empty text part is not the same as no text part — providers reject one.
  const text = draft.text.trim();
  if (text) parts.push({ type: "text", text });
  return { parts, attachments };
}

/** Reaches the model as the tool's result, so it is written to be acted on. */
const DECLINED =
  "The user did not allow this. Tell them it was not done, and do not ask again unless they raise it.";

type ToolCall = Parameters<ChatOnToolCallCallback<AbMessage>>[0]["toolCall"];
type ToolOutput = Parameters<BrowserChat["addToolOutput"]>[0];

/**
 * Prepares a tool the browser owns, to be run when the queue reaches it.
 *
 * What the call belongs to is read now rather than then: `turn` is what tells a
 * tool its conversation was abandoned, and read late it would be the turn that
 * replaced the one this call came from — so Stop would no longer stop anything
 * still waiting in the queue.
 *
 * Counted as running for as long as it takes — from `onToolCall`, so a step's
 * second tool is already counted when its first settles: the loop's own status
 * says "ready" throughout, because a client tool call ends the request that
 * carried it and nothing is on the wire until the result goes back.
 *
 * The message is written again afterwards because `onFinish` fired while the
 * tool was still running, and saved a call with no result. It is found by id
 * rather than taken from the end of the list — supplying the output can start
 * the next request, which appends to it.
 */
function answer(
  chat: BrowserChat,
  ctx: ToolContext,
  toolCall: ToolCall,
  persist: (message: AbMessage) => void,
): () => Promise<void> {
  const turn = chat.turn;
  const owner = chat.messages[chat.messages.length - 1]?.id;

  return async () => {
    try {
      if (chat.turn !== turn) return;
      const output = await toolOutput(toolCall, ctx);
      // The turn was abandoned while the tool ran. Handing the result back would
      // start a fresh request for a conversation nobody is watching.
      if (chat.turn !== turn) return;
      await chat.addToolOutput(output);

      const message = chat.messages.find((m) => m.id === owner);
      if (message) persist(message);
    } finally {
      chat.store.toolSettled(toolCall.toolCallId);
    }
  };
}

async function toolOutput(
  toolCall: ToolCall,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const call = { tool: toolCall.toolName, toolCallId: toolCall.toolCallId };
  try {
    return { ...call, output: await runClientTool(toolCall.toolName, toolCall.input, ctx) };
  } catch (e) {
    // A model recovers from a tool that failed; it cannot recover from one that
    // never answered, which leaves the turn hanging forever.
    return { ...call, state: "output-error", errorText: (e as Error).message };
  }
}

const noop = () => {};
