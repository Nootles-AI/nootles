import { beforeAll, describe, expect, it } from "vitest";
import { BrowserChat, ChatStore } from "./BrowserChat";
import type { ChatDraft } from "./types";

// The store notifies React on a frame; the snapshot it notifies about is built
// at once, which is what everything here reads.
beforeAll(() => {
  globalThis.requestAnimationFrame ??= ((run: FrameRequestCallback) =>
    setTimeout(() => run(0), 0) as unknown as number) as typeof requestAnimationFrame;
});

const draft = (text: string): ChatDraft => ({ text, attachments: [], mentions: [] });
const waiting = (store: ChatStore) =>
  store.getSnapshot().queued.map((item) => item.draft.text);

describe("the chat's queue", () => {
  it("keeps what was asked mid-answer, in order", () => {
    const store = new ChatStore();
    store.enqueue(draft("first"));
    store.enqueue(draft("second"));
    expect(waiting(store)).toEqual(["first", "second"]);
  });

  it("does not itself mean the chat is busy", () => {
    const store = new ChatStore();
    store.enqueue(draft("later"));
    expect(store.getSnapshot().busy).toBe(false);
  });

  it("gives them back one at a time, oldest first", () => {
    const store = new ChatStore();
    store.enqueue(draft("first"));
    store.enqueue(draft("second"));

    expect(store.takeQueued()?.draft.text).toBe("first");
    expect(waiting(store)).toEqual(["second"]);
    expect(store.takeQueued()?.draft.text).toBe("second");
    expect(store.takeQueued()).toBeNull();
  });

  it("lets one be taken back without disturbing the rest", () => {
    const store = new ChatStore();
    store.enqueue(draft("first"));
    store.enqueue(draft("second"));
    store.enqueue(draft("third"));

    const second = store.getSnapshot().queued[1].id;
    store.unqueue(second);
    expect(waiting(store)).toEqual(["first", "third"]);

    // An id that is no longer there is not an error; the row is simply gone.
    store.unqueue(second);
    expect(waiting(store)).toEqual(["first", "third"]);
  });

  it("holds the same array until the queue actually moves", () => {
    const store = new ChatStore();
    store.enqueue(draft("first"));
    const before = store.getSnapshot().queued;
    store.status = "streaming";
    // The drain effect keys off this reference; a new one every emit would run
    // it on every token of the answer it is waiting for.
    expect(store.getSnapshot().queued).toBe(before);
  });
});

describe("a send that has not reached the wire", () => {
  it("counts as busy, so the queue does not overtake it", () => {
    const store = new ChatStore();
    expect(store.getSnapshot().busy).toBe(false);
    store.sendStarted();
    expect(store.getSnapshot().busy).toBe(true);
    store.sendSettled();
    expect(store.getSnapshot().busy).toBe(false);
  });

  it("is not the whole of busy — a streaming answer still is", () => {
    const store = new ChatStore();
    store.sendStarted();
    store.status = "streaming";
    store.sendSettled();
    expect(store.getSnapshot().busy).toBe(true);
  });
});

describe("Stop", () => {
  it("drops the questions that were waiting behind the turn", async () => {
    const store = new ChatStore();
    const chat = new BrowserChat({
      store,
      transport: {
        sendMessages: async () => new ReadableStream(),
        reconnectToStream: async () => null,
      },
    });
    store.enqueue(draft("and then this"));
    store.toolStarted("call-1");

    await chat.cancel();

    expect(waiting(store)).toEqual([]);
    expect(store.getSnapshot().busy).toBe(false);
  });
});
