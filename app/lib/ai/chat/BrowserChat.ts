import {
  AbstractChat,
  getToolName,
  isToolUIPart,
  type ChatInit,
  type ChatState,
  type ChatStatus,
} from "ai";
import type { AbMessage, ChatDraft, QueuedDraft } from "./types";

/**
 * The chat loop, running in the browser.
 *
 * `AbstractChat` is the SDK's transport-agnostic loop: it owns streaming,
 * client-side tool execution and automatic resubmission. `@ai-sdk/react` is only
 * a React binding over this same class, so implementing `ChatState` directly
 * costs a few dozen lines and avoids a dependency — and we need custom state
 * anyway, to hydrate a thread from Convex and to persist as it goes.
 */

/** A tool call the model has made that will not run until the user allows it. */
export type PendingApproval = {
  id: string;
  toolName: string;
  input: unknown;
};

export type ChatSnapshot = {
  messages: AbMessage[];
  status: ChatStatus;
  error: Error | undefined;
  /**
   * Whether a turn is still in progress. Wider than `status`, which goes back to
   * "ready" the moment a stream ends — and both a tool the browser has to answer
   * and a call waiting on the user end one, so the middle of a turn looks idle to
   * `status` alone. Wider at the front too: a send is under way from the moment
   * it is asked for, through the uploads and mention reads before the request,
   * so the gap between pressing Send and the stream opening is not an idle one.
   */
  busy: boolean;
  /**
   * What the turn is waiting to be allowed to do. A list because a step's draw
   * calls arrive as a salvo and pause together — one picker answers them all —
   * where a deletion still comes one at a time.
   */
  approvals: PendingApproval[];
  /** Asked mid-answer, and waiting for the answer to finish. In order. */
  queued: QueuedDraft[];
};

/** Whether a tool call has an answer the model can be handed. */
export function isAnswered(part: AbMessage["parts"][number]): boolean {
  return (
    !isToolUIPart(part) ||
    part.state === "output-available" ||
    part.state === "output-error" ||
    part.state === "output-denied"
  );
}

function pendingApprovals(messages: AbMessage[]): PendingApproval[] {
  const last = messages[messages.length - 1];
  if (last?.role !== "assistant") return [];
  const out: PendingApproval[] = [];
  for (const part of last.parts) {
    if (isToolUIPart(part) && part.state === "approval-requested") {
      out.push({ id: part.approval.id, toolName: getToolName(part), input: part.input });
    }
  }
  return out;
}

export class ChatStore implements ChatState<AbMessage> {
  private listeners = new Set<() => void>();
  private _messages: AbMessage[];
  private _status: ChatStatus = "ready";
  private _error: Error | undefined;
  private running = new Set<string>();
  private _queued: QueuedDraft[] = [];
  private _sending = false;
  /**
   * A frozen view handed to React. Rebuilt on every mutation so
   * `useSyncExternalStore` sees a new reference and re-renders, and stable
   * between mutations so it does not loop.
   */
  private snap: ChatSnapshot;
  private frame: number | null = null;

  constructor(initial: AbMessage[] = []) {
    this._messages = initial;
    this.snap = this.build();
  }

  private build(): ChatSnapshot {
    const approvals = pendingApprovals(this._messages);
    return {
      messages: this._messages,
      status: this._status,
      error: this._error,
      busy:
        this._sending ||
        this._status === "submitted" ||
        this._status === "streaming" ||
        this.running.size > 0 ||
        approvals.length > 0,
      approvals,
      queued: this._queued,
    };
  }

  /**
   * The snapshot is rebuilt at once — anything reading `getSnapshot()` after a
   * mutation must see it — but React is told once a frame. A stream writes the
   * message several times between two paints, and each telling costs a render
   * of the whole transcript.
   */
  private emit() {
    this.snap = this.build();
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      for (const listener of this.listeners) listener();
    });
  }

  get status() {
    return this._status;
  }
  set status(value: ChatStatus) {
    this._status = value;
    this.emit();
  }

  get error() {
    return this._error;
  }
  set error(value: Error | undefined) {
    this._error = value;
    this.emit();
  }

  get messages() {
    return this._messages;
  }
  set messages(value: AbMessage[]) {
    this._messages = value;
    this.emit();
  }

  pushMessage = (message: AbMessage) => {
    this._messages = [...this._messages, message];
    this.emit();
  };

  popMessage = () => {
    this._messages = this._messages.slice(0, -1);
    this.emit();
  };

  /** Keeps the first `count` messages and forgets the rest — the rewind. */
  truncateTo = (count: number) => {
    this._messages = this._messages.slice(0, count);
    this.emit();
  };

  replaceMessage = (index: number, message: AbMessage) => {
    const next = this._messages.slice();
    // A fresh object because the SDK keeps mutating the message it handed us as
    // more of the stream arrives; without this React would compare a value to
    // itself and skip the render. Shallow on purpose — the parts are read at
    // render time either way, where a deep clone would copy every tool result
    // in the turn, whole pages of HTML among them, once per chunk.
    next[index] = { ...message, parts: message.parts.slice() };
    this._messages = next;
    this.emit();
  };

  /** A client tool the loop is waiting on, keyed by its call id. */
  toolStarted = (toolCallId: string) => {
    this.running.add(toolCallId);
    this.emit();
  };

  toolSettled = (toolCallId: string) => {
    this.running.delete(toolCallId);
    this.emit();
  };

  toolsAbandoned = () => {
    this.running.clear();
    this.emit();
  };

  /**
   * A turn the hook has begun but has not yet handed to the loop.
   *
   * Sending is not instant — attachments upload and mentions are read off the
   * pages first — and through all of it the loop's own status is "ready". The
   * queue drains on `busy` falling, so without this the wait would read as a
   * turn already over and the next question would go out beside this one.
   */
  sendStarted = () => {
    this._sending = true;
    this.emit();
  };

  sendSettled = () => {
    this._sending = false;
    this.emit();
  };

  /** A question asked mid-answer. It keeps its place; nothing is resolved yet. */
  enqueue = (draft: ChatDraft) => {
    this._queued = [...this._queued, { id: crypto.randomUUID(), draft }];
    this.emit();
  };

  /** Thought better of before its turn came. */
  unqueue = (id: string) => {
    const next = this._queued.filter((item) => item.id !== id);
    if (next.length === this._queued.length) return;
    this._queued = next;
    this.emit();
  };

  /** The next one to send, removed as it is taken so it cannot be taken twice. */
  takeQueued = (): QueuedDraft | null => {
    const [head, ...rest] = this._queued;
    if (!head) return null;
    this._queued = rest;
    this.emit();
    return head;
  };

  clearQueue = () => {
    if (!this._queued.length) return;
    this._queued = [];
    this.emit();
  };

  /**
   * Forgets calls that were never answered — a tool the browser abandoned, a
   * deletion nobody allowed. They are also what the thread is saved without, so
   * this is the transcript catching up with its own record; leaving them would
   * re-send the model a question with no answer, which providers reject.
   */
  dropUnansweredCalls = () => {
    const last = this._messages[this._messages.length - 1];
    if (last?.role !== "assistant") return;
    const parts = last.parts.filter(isAnswered);
    if (parts.length === last.parts.length) return;
    this._messages = [...this._messages.slice(0, -1), { ...last, parts }];
    this.emit();
  };

  /**
   * The SDK's own copy of a message it is about to stream into — taken once a
   * request rather than once a chunk, so it can afford to be deep.
   */
  snapshot = <T,>(value: T): T => structuredClone(value);

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snap;
}

export class BrowserChat extends AbstractChat<AbMessage> {
  readonly store: ChatStore;
  private cancellations = 0;

  constructor({
    store,
    ...init
  }: Omit<ChatInit<AbMessage>, "messages"> & { store: ChatStore }) {
    super({ ...init, state: store });
    this.store = store;
  }

  /**
   * Which turn is current. Work that outlives the turn it started in — a client
   * tool still running when the user pressed Stop — compares against this
   * before touching the loop.
   */
  get turn() {
    return this.cancellations;
  }

  /**
   * Abandons the turn in progress. `stop()` alone cannot: it aborts a request,
   * and between a client tool's call arriving and its result going back there
   * is no request to abort.
   *
   * What was waiting behind it goes too. A queued question was written to follow
   * THIS answer, and stopping is how "no, not that" is said — draining the queue
   * into the silence that follows would start the very turn that was stopped.
   */
  cancel = async () => {
    this.cancellations++;
    this.store.clearQueue();
    this.store.toolsAbandoned();
    await this.stop();
    this.store.dropUnansweredCalls();
  };
}
