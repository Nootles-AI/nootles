import { AbstractChat, type ChatInit, type ChatState, type ChatStatus } from "ai";
import type { AbMessage } from "./types";

/**
 * The chat loop, running in the browser.
 *
 * `AbstractChat` is the SDK's transport-agnostic loop: it owns streaming,
 * client-side tool execution and automatic resubmission. `@ai-sdk/react` is only
 * a React binding over this same class, so implementing `ChatState` directly
 * costs a few dozen lines and avoids a dependency — and we need custom state
 * anyway, to hydrate a thread from Convex and to persist as it goes.
 */

export type ChatSnapshot = {
  messages: AbMessage[];
  status: ChatStatus;
  error: Error | undefined;
};

export class ChatStore implements ChatState<AbMessage> {
  private listeners = new Set<() => void>();
  private _messages: AbMessage[];
  private _status: ChatStatus = "ready";
  private _error: Error | undefined;
  /**
   * A frozen view handed to React. Rebuilt on every mutation so
   * `useSyncExternalStore` sees a new reference and re-renders, and stable
   * between mutations so it does not loop.
   */
  private snap: ChatSnapshot;

  constructor(initial: AbMessage[] = []) {
    this._messages = initial;
    this.snap = this.build();
  }

  private build(): ChatSnapshot {
    return { messages: this._messages, status: this._status, error: this._error };
  }

  private emit() {
    this.snap = this.build();
    for (const listener of this.listeners) listener();
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

  replaceMessage = (index: number, message: AbMessage) => {
    const next = this._messages.slice();
    // Cloned because the SDK keeps mutating the message it handed us as more
    // of the stream arrives; without this React would compare a value to
    // itself and skip the render.
    next[index] = this.snapshot(message);
    this._messages = next;
    this.emit();
  };

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

  constructor({
    store,
    ...init
  }: Omit<ChatInit<AbMessage>, "messages"> & { store: ChatStore }) {
    super({ ...init, state: store });
    this.store = store;
  }
}
