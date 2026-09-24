import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { COMMENTS_REFUSED } from "@/app/lib/comments/policy";
import { WRITE_REFUSED } from "@/convex/roles";
import type { ConvexReactClient } from "convex/react";
import { acquireProvider, releaseProvider, YConvexProvider, type ProviderOptions } from "./YConvexProvider";

/**
 * `YConvexProvider`'s two opt-outs, for a page's comments document: no derived
 * writes (preview, context digest) and no presence — and what it does with a
 * change the server refuses, or a surface that may not write. Driven against an
 * in-memory stand-in for the three Convex calls the provider makes, which
 * records every function it is asked for — the assertion is on what reached
 * the wire.
 */

class Backend {
  seq = 0;
  log: Array<{ seq: number; update: ArrayBuffer }> = [];
  calls: string[] = [];
  /** The caller has lost the page: its presence query answers with an error. */
  revoked = false;
  /** How the next append fails: refused by the comments policy, or lost on the wire. */
  failNext: "refuse" | "offline" | null = null;
  /** The caller's pen is gone: every append is refused for who is asking. */
  penless = false;
  private watchers = new Set<() => void>();

  poke() {
    for (const watcher of this.watchers) watcher();
  }

  client(): ConvexReactClient {
    const read = (name: string, args: Record<string, unknown>) => {
      if (this.revoked) throw new Error(`[CONVEX Q(${name})] Server Error Uncaught Error: Not found`);
      if (name === "ydoc:meta") return { seq: this.seq, snapshotSeq: 0, snapshotParts: 0 };
      if (name === "ydoc:load") {
        return {
          seq: this.seq,
          snapshotSeq: 0,
          snapshotParts: 0,
          snapshot: null,
          updates: this.log.filter((row) => row.seq > (args.afterSeq as number)),
        };
      }
      if (name === "ydoc:updatesSince") return this.log.filter((row) => row.seq > (args.afterSeq as number));
      if (name === "presence:list") return [];
      throw new Error(`no query ${name}`);
    };
    return {
      watchQuery: (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        this.calls.push(`watch ${name}`);
        return {
          onUpdate: (callback: () => void) => {
            this.watchers.add(callback);
            return () => this.watchers.delete(callback);
          },
          localQueryResult: () => read(name, args),
        };
      },
      query: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        this.calls.push(`query ${name}`);
        return read(name, args);
      },
      mutation: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        this.calls.push(`mutation ${name}`);
        if (name === "ydoc:append") {
          const failure = this.failNext;
          this.failNext = null;
          if (failure === "refuse") throw new ConvexError({ code: COMMENTS_REFUSED, message: "Only a comment's author can change it." });
          if (failure === "offline") throw new Error("[CONVEX M(ydoc:append)] Connection lost");
          if (this.penless) throw new ConvexError({ code: WRITE_REFUSED, message: "Not found" });
          this.seq += 1;
          this.log.push({ seq: this.seq, update: args.update as ArrayBuffer });
          for (const watcher of this.watchers) watcher();
          return this.seq;
        }
        return null;
      },
    } as unknown as ConvexReactClient;
  }

  mutations(): string[] {
    return this.calls.filter((call) => call.startsWith("mutation ")).map((call) => call.slice(9));
  }
}

const COMMENTS: ProviderOptions = { derived: false, presence: false };

let backend: Backend;
const torn: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  backend = new Backend();
});

afterEach(() => {
  while (torn.length) torn.pop()!();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function open(options?: ProviderOptions) {
  const doc = new Y.Doc();
  const provider = new YConvexProvider(backend.client(), "doc-1", doc, options);
  torn.push(() => {
    provider.destroy();
    doc.destroy();
  });
  return provider;
}

/** Let queued microtasks and every timer up to `ms` run. */
async function settle(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("a comments document's provider", () => {
  it("syncs, and never watches or announces presence", async () => {
    const provider = open(COMMENTS);
    provider.connect();
    await provider.whenSynced;
    provider.awareness.setLocalStateField("user", { name: "Ada", color: "#333333" });
    provider.doc.getText("t").insert(0, "a thread");
    await settle(30_000);
    provider.disconnect();
    await settle(1_000);

    expect(backend.calls.filter((call) => call.startsWith("watch "))).toEqual(["watch ydoc:meta"]);
    expect(backend.mutations()).toEqual(["ydoc:append"]);
    expect(backend.log).toHaveLength(1);
  });

  it("writes no preview and no digest, on sync, on flush or on leaving", async () => {
    const provider = open(COMMENTS);
    provider.connect();
    await provider.whenSynced;
    for (let i = 0; i < 3; i++) {
      provider.doc.getText("t").insert(0, `edit ${i} `);
      await settle(5_000);
    }
    provider.disconnect();
    await settle(5_000);
    expect(backend.mutations().every((name) => name === "ydoc:append")).toBe(true);
    expect(backend.mutations().length).toBeGreaterThan(0);
  });

  it("still receives a peer's edits", async () => {
    const a = open(COMMENTS);
    a.connect();
    await a.whenSynced;
    const doc = new Y.Doc();
    const b = new YConvexProvider(backend.client(), "doc-1", doc, COMMENTS);
    torn.push(() => {
      b.destroy();
      doc.destroy();
    });
    b.connect();
    await b.whenSynced;
    a.doc.getText("t").insert(0, "from A");
    await settle(1_000);
    expect(b.doc.getText("t").toString()).toBe("from A");
  });
});

describe("a change the server refuses outright", () => {
  it("is dropped with a fresh doc synced from the server, and said, until the next change lands", async () => {
    const provider = open(COMMENTS);
    provider.connect();
    await provider.whenSynced;
    provider.doc.getText("t").insert(0, "kept");
    await settle(1_000);
    const before = provider.doc;
    const heard = vi.fn();
    provider.subscribe(heard);

    backend.failNext = "refuse";
    provider.doc.getText("t").insert(0, "forged ");
    await settle(1_000);
    expect(provider.doc).not.toBe(before);
    expect(provider.refusal).toBe("Only a comment's author can change it.");
    expect(heard).toHaveBeenCalled();
    await provider.whenSynced;
    expect(provider.doc.getText("t").toString()).toBe("kept");
    expect(backend.log).toHaveLength(1);
    expect(provider.hasUnsyncedChanges).toBe(false);

    // The fresh doc writes as any other; landing clears the refusal.
    provider.doc.getText("t").insert(4, " and more");
    await settle(1_000);
    expect(backend.log).toHaveLength(2);
    expect(provider.refusal).toBeNull();
    const peer = new Y.Doc();
    for (const row of backend.log) Y.applyUpdate(peer, new Uint8Array(row.update));
    expect(peer.getText("t").toString()).toBe("kept and more");
  });

  it("can be dismissed", async () => {
    const provider = open(COMMENTS);
    provider.connect();
    await provider.whenSynced;
    backend.failNext = "refuse";
    provider.doc.getText("t").insert(0, "x");
    await settle(1_000);
    expect(provider.refusal).not.toBeNull();
    provider.dismissRefusal();
    expect(provider.refusal).toBeNull();
  });

  it("any other failure keeps the change and retries it, as before", async () => {
    const provider = open(COMMENTS);
    provider.connect();
    await provider.whenSynced;
    const doc = provider.doc;
    backend.failNext = "offline";
    doc.getText("t").insert(0, "offline edit");
    await settle(5_000);
    expect(provider.doc).toBe(doc);
    expect(provider.refusal).toBeNull();
    expect(backend.log).toHaveLength(1);
  });
});

describe("a page's provider is unchanged", () => {
  it("watches presence, announces itself and says goodbye", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    provider.awareness.setLocalStateField("user", { name: "Ada", color: "#333333" });
    await settle(11_000);
    provider.disconnect();
    await settle(0);
    expect(backend.calls).toContain("watch presence:list");
    expect(backend.mutations()).toContain("presence:heartbeat");
    expect(backend.mutations()).toContain("presence:leave");
  });

  it("goes quiet, without throwing, when the page stops answering (access revoked)", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    backend.revoked = true;
    expect(() => backend.poke()).not.toThrow();
    await settle(11_000);
    expect(provider.awareness.getStates().size).toBe(1);
    provider.disconnect();
    await settle(0);
  });

  it("offers derived data on sync and behind its flushes", async () => {
    const derived = vi
      .spyOn(YConvexProvider.prototype as unknown as { writeDerived(o?: object): Promise<void> }, "writeDerived")
      .mockResolvedValue(undefined);
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    expect(derived).toHaveBeenCalledWith({ preview: false });
    provider.doc.getText("t").insert(0, "page text");
    await settle(5_000);
    expect(derived).toHaveBeenCalledTimes(2);
  });

  it("defaults both options on", () => {
    expect(open().options).toEqual({ derived: true, presence: true });
    expect(open(COMMENTS).options).toEqual({ derived: false, presence: false });
  });
});

describe("acquireProvider", () => {
  it("shares one instance per docId and refuses a second opinion about its options", async () => {
    const client = backend.client();
    const first = acquireProvider(client, "comments-1", COMMENTS);
    const again = acquireProvider(client, "comments-1", COMMENTS);
    expect(again).toBe(first);
    expect(() => acquireProvider(client, "comments-1")).toThrow(/different options/);
    releaseProvider("comments-1");
    releaseProvider("comments-1");
    await settle(0);
    // Released to the warm cache, it still answers for its own kind only.
    expect(() => acquireProvider(client, "comments-1", { derived: true, presence: false })).toThrow(/different options/);
    const warm = acquireProvider(client, "comments-1", COMMENTS);
    expect(warm).toBe(first);
    releaseProvider("comments-1");
    await settle(0);
  });
});

/** What the server's log holds, applied to a fresh doc. */
function stored(): string {
  const peer = new Y.Doc();
  for (const row of backend.log) Y.applyUpdate(peer, new Uint8Array(row.update));
  return peer.getText("t").toString();
}

describe("a tab whose pen is taken (NT-80)", () => {
  it("holds what it wrote once refused, stops sending, and says so", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    const text = provider.doc.getText("t");
    text.insert(0, "landed");
    await settle(1_000);
    expect(backend.log).toHaveLength(1);

    // The link ran out while the role query still showed the pen.
    backend.penless = true;
    text.insert(6, " then refused");
    await settle(1_000);
    const tried = backend.mutations().filter((name) => name === "ydoc:append").length;
    expect(provider.writeRefused).toBe(true);
    expect(provider.stranded).toBe(true);
    expect(provider.hasUnsyncedChanges).toBe(true);

    // No retry loop, and nothing more goes out however long the tab stays.
    text.insert(19, " and more");
    await settle(120_000);
    expect(backend.mutations().filter((name) => name === "ydoc:append")).toHaveLength(tried);
    // Kept, not thrown away: the words are still there to copy.
    expect(provider.doc).toBe(text.doc);
    expect(text.toString()).toBe("landed then refused and more");
    expect(stored()).toBe("landed");
  });

  it("sends everything it held once handed the pen back", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    backend.penless = true;
    provider.doc.getText("t").insert(0, "typed after the link ran out");
    await settle(1_000);
    expect(provider.stranded).toBe(true);

    // The owner moves the date: the role reads a viewer's, then the pen again.
    backend.penless = false;
    provider.setWritable(false);
    provider.setWritable(true);
    await settle(1_000);
    expect(stored()).toBe("typed after the link ran out");
    expect(provider.writeRefused).toBe(false);
    expect(provider.stranded).toBe(false);
    expect(provider.hasUnsyncedChanges).toBe(false);
  });

  it("offers what it held once more when asked, or when a surface mounts on it again — once each", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    backend.penless = true;
    provider.doc.getText("t").insert(0, "held");
    await settle(1_000);
    const appends = () => backend.mutations().filter((name) => name === "ydoc:append").length;
    expect(appends()).toBe(1);

    // Still refused: one more attempt each, and held again.
    provider.retryHeld();
    await settle(30_000);
    expect(appends()).toBe(2);
    provider.setWritable(true);
    await settle(30_000);
    expect(appends()).toBe(3);
    expect(provider.writeRefused).toBe(true);

    // The link was extended meanwhile: the next attempt lands.
    backend.penless = false;
    provider.retryHeld();
    await settle(1_000);
    expect(stored()).toBe("held");
    expect(provider.stranded).toBe(false);
  });

  it("holds a demoted writer's unsent change instead of sending it", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    provider.doc.getText("t").insert(0, "last words");
    provider.setWritable(false);
    await settle(60_000);
    expect(backend.mutations()).not.toContain("ydoc:append");
    expect(provider.stranded).toBe(true);
    expect(provider.hasUnsyncedChanges).toBe(true);
  });

  it("any other failure still retries, as before", async () => {
    const provider = open();
    provider.connect();
    await provider.whenSynced;
    backend.failNext = "offline";
    provider.doc.getText("t").insert(0, "offline edit");
    await settle(5_000);
    expect(provider.writeRefused).toBe(false);
    expect(stored()).toBe("offline edit");
  });
});

describe("a reader's document (NT-80)", () => {
  it("never sends what changes in it locally, and has nothing unsaved", async () => {
    const provider = open();
    provider.setWritable(false);
    provider.connect();
    await provider.whenSynced;
    // The NML compatibility mirror repairing a projection, three times over.
    for (const word of ["one ", "two ", "three "]) {
      provider.doc.getText("t").insert(0, word);
      await settle(20_000);
    }
    expect(backend.mutations()).not.toContain("ydoc:append");
    expect(provider.hasUnsyncedChanges).toBe(false);
    expect(provider.stranded).toBe(false);
    expect(provider.writeRefused).toBe(false);

    // Promoted, it sends them as one: causality is kept, not a word is lost.
    provider.setWritable(true);
    await settle(1_000);
    expect(backend.mutations().filter((name) => name === "ydoc:append")).toHaveLength(1);
    expect(stored()).toBe("three two one ");
  });
});
