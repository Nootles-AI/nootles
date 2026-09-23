"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatOnToolCallCallback,
} from "ai";
import { useConvex, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { track } from "@/app/lib/telemetry";
import { useOpenPage } from "@/app/components/OpenPageContext";
import { useReview } from "@/app/components/ReviewContext";
import { useEditorRegistry } from "@/app/components/editor/EditorRegistry";
import { usePageCommentsRegistry } from "@/app/components/comments/registry";
import { AI } from "../aiConfig";
import {
  BrowserChat,
  ChatStore,
  isAnswered,
  type PendingApproval,
} from "./BrowserChat";
import { withAttachmentUrls } from "./attachments";
import { runClientTool, type ToolContext } from "./clientTools";
import { chatDigest, type Person } from "./commentTools";
import { duplicateMutationResult, isRepeatedMutation } from "./toolReplay";
import type { DrawChoice } from "../drawStyles";
import { resolveMentions } from "./mentions";
import type { MentionData } from "./parts";
import { isClientTool } from "./tools";
import type { AbMessage, ChatDraft, QueuedDraft } from "./types";

const EMPTY = {
  messages: [] as AbMessage[],
  status: "ready" as const,
  error: undefined,
  busy: false,
  approvals: [] as PendingApproval[],
  queued: [] as QueuedDraft[],
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
}: {
  threadId: Id<"chatThreads"> | null;
  projectId: Id<"projects">;
  pageId: Id<"pages"> | null;
}) {
  const persisted = useQuery(
    api.chat.messages.list,
    threadId ? { threadId } : "skip",
  );
  const putMessage = useMutation(api.chat.messages.put);
  const truncateFrom = useMutation(api.chat.messages.truncateFrom);
  const renameThread = useMutation(api.chat.threads.rename);
  const convex = useConvex();
  const { open } = useOpenPage();
  const registry = useEditorRegistry();
  const review = useReview();
  const comments = usePageCommentsRegistry();
  // Who a comment on the open page may name, and what each is called — so the
  // model reads names rather than account ids, and mentions by name.
  // The answer is the project's, whichever page asks, so the last one stands in
  // while a newly opened page's copy loads.
  const mentionable = useQuery(api.commentNotices.mentionable, pageId ? { pageId } : "skip");

  const [built, setBuilt] = useState<{ key: string; chat: BrowserChat } | null>(
    null,
  );

  // The style the user last confirmed for drawings, carried on every later
  // request body. A ref rather than state: nothing renders from it — the
  // picker keeps its own — and it is read inside the transport callback.
  const drawStyle = useRef<DrawChoice | null>(null);

  // Read by callbacks that outlive the render that created them. Declared first
  // so it is up to date before the effect below builds anything from it.
  const latest = useRef({
    threadId,
    projectId,
    pageId,
    persisted,
    putMessage,
    truncateFrom,
    renameThread,
    convex,
    open,
    registry,
    review,
    comments,
    people: mentionable ?? NO_PEOPLE,
  });
  useEffect(() => {
    latest.current = {
      threadId,
      projectId,
      pageId,
      persisted,
      putMessage,
      truncateFrom,
      renameThread,
      convex,
      open,
      registry,
      review,
      comments,
      people: mentionable ?? latest.current.people,
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
      commentsFor: async (pageId) =>
        (await latest.current.comments?.settled(pageId, AI.chat.editorWaitMs)) ?? null,
      people: () => latest.current.people,
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
        prepareSendMessagesRequest: ({ messages }) => {
          const { pageId: page, comments: registry, people: named } = latest.current;
          // The open page's threads, for the route's comments gate to take or
          // leave. Read per request: a resumed turn may be on another page.
          const digest = chatDigest(page ? (registry?.current(page) ?? null) : null, named);
          return {
            body: {
              messages,
              projectId: latest.current.projectId,
              pageId: page,
              // What the conversation is charged against. Bound like `persist`'s
              // copy rather than read from `latest`: a request must be billed to
              // the thread that sent it, not to whichever one is open when it
              // lands.
              threadId: boundThreadId,
              // The style the picker settled, if any turn here has drawn: the
              // approved draw calls execute on the resume request, and this is
              // how the route knows what the user chose.
              ...(drawStyle.current ? { drawStyle: drawStyle.current } : {}),
              ...(digest ? { comments: digest } : {}),
            },
          };
        },
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
    useCallback(
      (listener: () => void) => store?.subscribe(listener) ?? noop,
      [store],
    ),
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

  /**
   * The send itself, once it is this draft's turn to go.
   *
   * Split from `send` so that a draft that waited takes exactly the path a
   * typed one does — read, addressed and billed here, against the document the
   * answer it waited for has just finished changing rather than against the one
   * it was written over. It does not ask whether anything is ahead of it: that
   * is `send`'s question, and the queue has already answered it.
   */
  const sendNow = useCallback(
    async (draft: ChatDraft) => {
      const { threadId: id, projectId: pid, pageId: page } = latest.current;
      if (!chat || !id) return;

      // Busy from here rather than from the request. Everything below is awaits,
      // and a send that reads as idle until the stream opens is one the queue
      // would drain a second question into.
      chat.store.sendStarted();
      try {
        // Read here, before anything is written down: a mention means the page
        // as it stands at the moment the user asked, and the agent is about to
        // start moving between pages and changing them.
        const mentions = await resolveMentions(draft.mentions, makeContext());
        const { parts, attachments } = userParts(draft, mentions);

        // Written before the turn runs, with an id minted here rather than by
        // the SDK. `sendMessage` only resolves once the answer is finished, and
        // the answer is persisted on the way out of it — so a user row written
        // after that await would be given the later `seq` of the two, and the
        // thread would reload, and be re-sent to the model, answer before
        // question.
        const chatPromptId = crypto.randomUUID();
        const message = {
          id: crypto.randomUUID(),
          role: "user" as const,
          parts,
          metadata: { pageIdAtSend: page ?? undefined, chatPromptId },
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
        void latest.current.review.beginTurn({
          threadId: id,
          projectId: pid,
          chatPromptId,
        });
        track("chat_prompt_sent", { attachments: attachments.length });
        await chat.sendMessage(message);
      } finally {
        chat.store.sendSettled();
      }
    },
    [chat, makeContext],
  );

  const send = useCallback(
    async (draft: ChatDraft) => {
      if (!chat || !latest.current.threadId || !hasContent(draft)) return;

      // Anything ahead of it means it waits. A turn still running, because the
      // loop hands a tool result to whatever message is last and that would now
      // be this one — and asking mid-answer is how a person corrects an agent
      // that has already started, so refusing the words is not an option. Or
      // questions already waiting on a turn that has just this instant ended,
      // which is a queue with a gap in it rather than a queue.
      const { busy, queued } = chat.store.getSnapshot();
      if (busy || queued.length) {
        chat.store.enqueue(draft);
        track("chat_prompt_queued", { waiting: queued.length });
        return;
      }

      await sendNow(draft);
    },
    [chat, sendNow],
  );

  /**
   * The queue drains itself.
   *
   * Not a derived value being written back — a question waiting for a turn to
   * end is a fact this hook owns, and the turn ending is the event. `busy` is
   * re-read off the store rather than taken from the render this effect belongs
   * to: `sendNow` makes the chat busy synchronously, so a stale "ready" here
   * would be two questions on the wire at once.
   */
  useEffect(() => {
    if (!chat || snapshot.busy || !snapshot.queued.length) return;
    if (chat.store.getSnapshot().busy) return;
    const next = chat.store.takeQueued();
    if (next) void sendNow(next.draft);
  }, [chat, sendNow, snapshot.busy, snapshot.queued]);

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
   * request currently on screen. Draw calls are not answered here — they have
   * their own question, with a style attached.
   */
  const answerApproval = useCallback(
    (approved: boolean) => {
      if (!chat) return;
      const pending = chat.store
        .getSnapshot()
        .approvals.filter((a) => a.toolName !== "draw");
      for (const approval of pending) {
        void chat.addToolApprovalResponse({
          id: approval.id,
          approved,
          ...(approved ? {} : { reason: DECLINED }),
        });
      }
    },
    [chat],
  );

  /**
   * The style the user settled for the drawings now waiting — one answer for
   * the whole salvo, so a board is one style rather than nine. Null leaves
   * them undrawn. The choice is remembered on the thread's request body,
   * because the approved calls only execute on the resume request and that is
   * where the route reads it from.
   */
  const answerDraws = useCallback(
    (choice: DrawChoice | null) => {
      if (!chat) return;
      const pending = chat.store
        .getSnapshot()
        .approvals.filter((a) => a.toolName === "draw");
      if (!pending.length) return;
      if (choice) drawStyle.current = choice;
      for (const approval of pending) {
        void chat.addToolApprovalResponse(
          choice
            ? { id: approval.id, approved: true }
            : { id: approval.id, approved: false, reason: UNDRAWN },
        );
      }
    },
    [chat],
  );

  /**
   * Stop. Ends the turn and drops what was waiting behind it — see
   * `BrowserChat.cancel`.
   */
  const stop = useCallback(() => {
    if (!chat) return;
    track("chat_turn_stopped", { dropped: chat.store.getSnapshot().queued.length });
    void chat.cancel();
  }, [chat]);

  /** Taking a waiting question back out of the queue. */
  const unqueue = useCallback((id: string) => chat?.store.unqueue(id), [chat]);

  /**
   * Puts the conversation back to just before a message was sent.
   *
   * Both halves, because the transcript on screen is not read back from the
   * database — the store is the live copy and the rows are its record. The
   * store goes first so nothing on screen outlives the thread it belongs to,
   * and the turn is cancelled because rewinding past an answer still arriving
   * would leave it streaming into a message that no longer exists.
   */
  const rewind = useCallback(
    async (uiId: string) => {
      const { threadId: id } = latest.current;
      if (!chat || !id) return;
      const index = chat.messages.findIndex((m) => m.id === uiId);
      if (index < 0) return;
      await chat.cancel();
      chat.store.truncateTo(index);
      await latest.current.truncateFrom({ threadId: id, uiId });
    },
    [chat],
  );

  return {
    messages: snapshot.messages,
    error: snapshot.error,
    busy: snapshot.busy,
    approvals: snapshot.approvals,
    queued: snapshot.queued,
    send,
    nameThreadFrom,
    answerApproval,
    answerDraws,
    stop,
    unqueue,
    rewind,
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
      attachments.push({
        storageId: file.storageId,
        partIndex: parts.length,
        mediaType,
        filename,
      });
      parts.push({ type: "file", mediaType, filename, url: file.url });
    } else {
      parts.push({
        type: "data-attachment",
        data: { filename, mediaType, text: file.text },
      });
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

/** A refused drawing is a decision, not a failure to route around. */
const UNDRAWN =
  "The user chose not to draw this. Carry on without the drawing, and do not " +
  "call draw again for it unless they ask.";

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
      const output = await toolOutput(toolCall, ctx, chat.messages);
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
  messages: AbMessage[],
): Promise<ToolOutput> {
  const call = { tool: toolCall.toolName, toolCallId: toolCall.toolCallId };
  if (isRepeatedMutation(messages, toolCall)) {
    return { ...call, output: duplicateMutationResult(toolCall.toolName) };
  }
  try {
    return {
      ...call,
      output: await runClientTool(toolCall.toolName, toolCall.input, ctx, {
        toolCallId: toolCall.toolCallId,
      }),
    };
  } catch (e) {
    // A model recovers from a tool that failed; it cannot recover from one that
    // never answered, which leaves the turn hanging forever.
    return { ...call, state: "output-error", errorText: (e as Error).message };
  }
}

const noop = () => {};

const NO_PEOPLE: Person[] = [];
