import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { YConvexProvider } from "./YConvexProvider";
import { handOffSession, HANDOFF_TTL_MS } from "./presenceSession";

/**
 * How a returning collaborator gets back onto the carets and the canvas
 * (NT-26). `applyPresence` is the whole reconciliation: presence rows in,
 * y-protocols awareness out. It is driven directly here because the rest of
 * the provider is the network, and none of this bug lives there.
 */

type Row = {
  sessionId: string;
  clientId: number;
  state: ArrayBuffer;
  updatedAt: number;
};

/** A provider with no network: `applyPresence` never reaches the client. */
const offline = {} as ConvexReactClient;

const torn: Array<() => void> = [];

function observer() {
  const doc = new Y.Doc();
  const provider = new YConvexProvider(offline, "doc-1", doc);
  torn.push(() => {
    provider.destroy();
    doc.destroy();
  });
  return provider;
}

function peer(name = "Peer") {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  awareness.setLocalState({ user: { name, color: "#c03" } });
  torn.push(() => {
    awareness.destroy();
    doc.destroy();
  });
  return awareness;
}

/** Every heartbeat is a fresh row write, so `updatedAt` always moves. */
let tick = 0;

/** The peer's heartbeat, exactly as `sendAwareness` writes it. */
function heartbeat(from: Awareness, updatedAt = Date.now() + tick++): Row {
  const encoded = encodeAwarenessUpdate(from, [from.clientID]);
  return {
    sessionId: `session-${from.clientID}`,
    clientId: from.clientID,
    state: encoded.buffer.slice(
      encoded.byteOffset,
      encoded.byteOffset + encoded.byteLength,
    ) as ArrayBuffer,
    updatedAt,
  };
}

function apply(provider: YConvexProvider, rows: Row[]) {
  (provider as unknown as { applyPresence(rows: Row[]): void }).applyPresence(rows);
}

/** Who this provider would draw a caret and a canvas ghost for. */
const shown = (provider: YConvexProvider) => [...provider.awareness.getStates().keys()];

const sees = (provider: YConvexProvider, who: Awareness) =>
  provider.awareness.getStates().has(who.clientID);

/** y-protocols' own renewal timer, which bumps a still client's clock. */
const renew = (who: Awareness) => who.setLocalState(who.getLocalState());

const STALE_MS = 30_000;

afterEach(() => {
  while (torn.length) torn.pop()!();
});

describe("applyPresence", () => {
  it("shows a peer on their first heartbeat", () => {
    const o = observer();
    const p = peer("Ada");
    apply(o, [heartbeat(p)]);
    expect(sees(o, p)).toBe(true);
    expect(o.awareness.getStates().get(p.clientID)).toEqual({
      user: { name: "Ada", color: "#c03" },
    });
  });

  it("takes a peer down once their row stops being rewritten", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    expect(sees(o, p)).toBe(false);
  });

  it("brings a returning peer back on their very next heartbeat", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    expect(sees(o, p)).toBe(false);

    // The peer was suspended, so their awareness clock did not move while they
    // were gone: this is the same state at the same clock. Before NT-26 this
    // heartbeat was dropped and they stayed invisible for up to ~25s more.
    apply(o, [heartbeat(p)]);
    expect(sees(o, p)).toBe(true);
  });

  it("brings back a peer y-protocols' own 30s timeout removed", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p)]);
    // The same helper the Awareness check interval calls, with its origin.
    removeAwarenessStates(o.awareness, [p.clientID], "timeout");
    expect(sees(o, p)).toBe(false);

    apply(o, [heartbeat(p)]);
    expect(sees(o, p)).toBe(true);
  });

  it("announces the return as an arrival, so carets and ghosts repaint", () => {
    const o = observer();
    const p = peer();
    const changes: string[] = [];
    o.awareness.on(
      "change",
      ({ added, removed }: { added: number[]; removed: number[] }) => {
        if (added.includes(p.clientID)) changes.push("added");
        if (removed.includes(p.clientID)) changes.push("removed");
      },
    );
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    apply(o, [heartbeat(p)]);
    expect(changes).toEqual(["added", "removed", "added"]);
  });

  it("announces it on `update` too, which is the canvas ghosts' channel", () => {
    const o = observer();
    const p = peer();
    const added: number[] = [];
    o.awareness.on("update", ({ added: arrived }: { added: number[] }) => {
      added.push(...arrived);
    });
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    apply(o, [heartbeat(p)]);
    expect(added).toEqual([p.clientID, p.clientID]);
  });

  it("carries the peer's latest state back, not the one they left on", () => {
    const o = observer();
    const p = peer("Grace");
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);

    p.setLocalState({ user: { name: "Grace", color: "#c03" }, cursor: { pos: 42 } });
    apply(o, [heartbeat(p)]);
    expect(o.awareness.getStates().get(p.clientID)).toEqual({
      user: { name: "Grace", color: "#c03" },
      cursor: { pos: 42 },
    });
  });

  it("still ignores a row that is itself stale", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    expect(sees(o, p)).toBe(false);
  });

  it("keeps clock ordering for a peer who never went away", () => {
    const o = observer();
    const p = peer("Alan");
    const old = heartbeat(p);
    p.setLocalState({ user: { name: "Alan", color: "#c03" }, cursor: { pos: 7 } });
    const fresh = heartbeat(p, old.updatedAt + 1);

    apply(o, [old]);
    apply(o, [fresh]);
    // A duplicate row redelivered after the newer one must not wind them back.
    apply(o, [{ ...old, updatedAt: fresh.updatedAt + 1 }]);
    expect(o.awareness.getStates().get(p.clientID)).toEqual({
      user: { name: "Alan", color: "#c03" },
      cursor: { pos: 7 },
    });
  });

  it("never drops this client's own clock", () => {
    const o = observer();
    const mine = o.awareness.clientID;
    const before = o.awareness.meta.get(mine)?.clock;
    apply(o, [heartbeat(peer())]);
    expect(o.awareness.meta.get(mine)?.clock).toBe(before);
    expect(o.awareness.getLocalState()).not.toBeNull();
  });

  it("skips this session's own row", () => {
    const o = observer();
    const p = peer();
    const row = heartbeat(p);
    apply(o, [{ ...row, sessionId: o.sessionId }]);
    expect(shown(o)).toEqual([o.awareness.clientID]);
  });

  it("reconciles a roomful independently", () => {
    const o = observer();
    const a = peer("A");
    const b = peer("B");
    apply(o, [heartbeat(a), heartbeat(b)]);
    expect(sees(o, a) && sees(o, b)).toBe(true);

    // A drops out, B keeps going, then A comes back at an unmoved clock.
    apply(o, [heartbeat(a, Date.now() - STALE_MS - 1), heartbeat(b)]);
    expect(sees(o, a)).toBe(false);
    expect(sees(o, b)).toBe(true);

    apply(o, [heartbeat(a), heartbeat(b)]);
    expect(sees(o, a) && sees(o, b)).toBe(true);
  });

  it("survives repeated leave/return cycles", () => {
    const o = observer();
    const p = peer();
    for (let i = 0; i < 5; i++) {
      apply(o, [heartbeat(p)]);
      expect(sees(o, p)).toBe(true);
      apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
      expect(sees(o, p)).toBe(false);
    }
    apply(o, [heartbeat(p)]);
    expect(sees(o, p)).toBe(true);
  });

  it("does not need the peer's renewal timer to have run", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p)]);
    const clockAway = p.meta.get(p.clientID)!.clock;
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    apply(o, [heartbeat(p)]);
    expect(p.meta.get(p.clientID)!.clock).toBe(clockAway);
    expect(sees(o, p)).toBe(true);
  });

  it("still lets a renewed clock through afterwards", () => {
    const o = observer();
    const p = peer();
    apply(o, [heartbeat(p)]);
    apply(o, [heartbeat(p, Date.now() - STALE_MS - 1)]);
    apply(o, [heartbeat(p)]);
    renew(p);
    p.setLocalState({ user: { name: "Peer", color: "#c03" }, cursor: { pos: 3 } });
    apply(o, [heartbeat(p, Date.now() + 1)]);
    expect(o.awareness.getStates().get(p.clientID)).toMatchObject({ cursor: { pos: 3 } });
  });
});

/** `sessionStorage` as a tab has it: one per tab, copied by "Duplicate tab". */
class TabStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  /** What a duplicated tab starts with. */
  copy() {
    const copy = new TabStorage();
    copy.items = new Map(this.items);
    return copy;
  }
}

/** A provider on `docId` whose client records what it is asked to send. */
function tab(docId = "doc-1") {
  const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    mutation: async (reference: unknown, args: Record<string, unknown>) => {
      const name = getFunctionName(reference as never);
      sent.push({ name, args });
      return null;
    },
  } as unknown as ConvexReactClient;
  const doc = new Y.Doc();
  const provider = new YConvexProvider(client, docId, doc);
  torn.push(() => {
    provider.destroy();
    doc.destroy();
  });
  return { provider, sent };
}

/** The page going away, as `pagehide` tells the provider. */
const hide = (provider: YConvexProvider) =>
  (provider as unknown as { onPageHide(): void }).onPageHide();

/** The page coming back, as `pageshow` tells the provider. */
const show = (provider: YConvexProvider, persisted: boolean) =>
  (provider as unknown as { onPageShow(event: { persisted: boolean }): void }).onPageShow({ persisted });

describe("a refreshed tab keeps its presence identity (NT-137)", () => {
  let storage: TabStorage;
  const inTab = (s: TabStorage) => {
    storage = s;
    vi.stubGlobal("sessionStorage", s);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("the page after a refresh reuses the session the page before it handed over", () => {
    inTab(new TabStorage());
    const before = tab().provider;
    const id = before.sessionId;
    hide(before);
    const after = tab().provider;
    expect(after.sessionId).toBe(id);
  });

  it("and so never shows its own pre-refresh caret, even when the goodbye was lost", () => {
    inTab(new TabStorage());
    const before = tab().provider;
    before.awareness.setLocalState({ user: { name: "Alice", color: "#c03" }, cursor: { pos: 4 } });
    const oldRow = heartbeat(before.awareness);
    hide(before); // no site URL here, so no beacon — and the socket is gone

    const after = tab().provider;
    apply(after, [{ ...oldRow, sessionId: before.sessionId }]);
    expect(shown(after)).toEqual([after.awareness.clientID]);
  });

  it("a new provider mints a fresh session when nothing was handed over", () => {
    inTab(new TabStorage());
    const one = tab().provider;
    const two = tab().provider;
    expect(one.sessionId).not.toBe(two.sessionId);
  });

  it("a handover is taken once — a second provider gets a fresh session", () => {
    inTab(new TabStorage());
    const before = tab().provider;
    hide(before);
    const first = tab().provider;
    const second = tab().provider;
    expect(first.sessionId).toBe(before.sessionId);
    expect(second.sessionId).not.toBe(before.sessionId);
    expect(storage.items.size).toBe(0);
  });

  it("a duplicated tab never shares a live tab's session", () => {
    inTab(new TabStorage());
    const original = tab().provider;
    hide(original);
    const reloaded = tab().provider; // the original tab, refreshed: it took the handover
    const live = reloaded.sessionId;
    inTab(storage.copy()); // "Duplicate tab" copies sessionStorage as it is now
    const duplicate = tab().provider;
    expect(live).toBe(original.sessionId);
    expect(duplicate.sessionId).not.toBe(live);
  });

  it("is per document", () => {
    inTab(new TabStorage());
    const page = tab("doc-1").provider;
    hide(page);
    expect(tab("doc-2").provider.sessionId).not.toBe(page.sessionId);
    expect(tab("doc-1").provider.sessionId).toBe(page.sessionId);
  });

  it("ignores a handover old enough that the row it names is stale anyway", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    inTab(new TabStorage());
    handOffSession("doc-1", "s-old");
    vi.setSystemTime(Date.now() + HANDOFF_TTL_MS);
    expect(tab().provider.sessionId).not.toBe("s-old");
    expect(storage.items.size).toBe(0);
  });

  it("ignores a handover from the future (a clock moved back)", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    inTab(new TabStorage());
    handOffSession("doc-1", "s-future");
    vi.setSystemTime(Date.now() - 1000);
    expect(tab().provider.sessionId).not.toBe("s-future");
  });

  it("ignores a malformed handover", () => {
    for (const raw of ["not json", "null", "{}", JSON.stringify({ sessionId: "", at: Date.now() }), JSON.stringify({ sessionId: 3, at: Date.now() })]) {
      const s = new TabStorage();
      s.setItem("nootles:presence-session:doc-1", raw);
      inTab(s);
      const id = tab().provider.sessionId;
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(8);
    }
  });

  it("works without sessionStorage, and when it refuses access", () => {
    vi.stubGlobal("sessionStorage", undefined);
    const lone = tab().provider;
    hide(lone);
    expect(tab().provider.sessionId).not.toBe(lone.sessionId);

    const refusing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    vi.stubGlobal("sessionStorage", refusing);
    const one = tab().provider;
    expect(() => hide(one)).not.toThrow();
    expect(tab().provider.sessionId).not.toBe(one.sessionId);
  });

  it("comes back from the back/forward cache as itself, withdrawing the handover and announcing again", () => {
    inTab(new TabStorage());
    const { provider, sent } = tab();
    (provider as unknown as { connected: boolean }).connected = true;
    provider.awareness.setLocalState({ user: { name: "Alice", color: "#c03" } });
    hide(provider);
    expect(storage.items.size).toBe(1);
    sent.length = 0;
    show(provider, true);
    expect(storage.items.size).toBe(0);
    expect(sent.map((m) => m.name)).toEqual(["presence:heartbeat"]);
    expect(sent[0].args.sessionId).toBe(provider.sessionId);
    (provider as unknown as { connected: boolean }).connected = false;
  });

  it("a first load (not from the cache) changes nothing", () => {
    inTab(new TabStorage());
    const { provider, sent } = tab();
    handOffSession("doc-1", provider.sessionId);
    show(provider, false);
    expect(storage.items.size).toBe(1);
    expect(sent).toEqual([]);
  });
});

describe("leaving as the page goes (NT-137)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sends the goodbye by beacon to the deployment's site, naming this incarnation", () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://quick-cobra-443.convex.site/");
    const beacons: Array<[string, unknown]> = [];
    vi.stubGlobal("navigator", { sendBeacon: (url: string, body: unknown) => (beacons.push([url, body]), true) });
    const { provider, sent } = tab();
    hide(provider);
    expect(beacons).toHaveLength(1);
    expect(beacons[0][0]).toBe("https://quick-cobra-443.convex.site/presence/leave");
    // A string body: text/plain, a simple request with no preflight.
    expect(typeof beacons[0][1]).toBe("string");
    expect(JSON.parse(beacons[0][1] as string)).toEqual({
      docId: "doc-1",
      sessionId: provider.sessionId,
      clientId: provider.doc.clientID,
    });
    expect(sent).toEqual([]);
  });

  it("falls back to the websocket when the browser declines the beacon", () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://quick-cobra-443.convex.site");
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    const { provider, sent } = tab();
    hide(provider);
    expect(sent).toEqual([
      { name: "presence:leave", args: { docId: "doc-1", sessionId: provider.sessionId, clientId: provider.doc.clientID } },
    ]);
  });

  it("falls back to the websocket when the build names no site", () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "");
    const sendBeacon = vi.fn(() => true);
    vi.stubGlobal("navigator", { sendBeacon });
    const { provider, sent } = tab();
    hide(provider);
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(sent.map((m) => m.name)).toEqual(["presence:leave"]);
  });

  it("an in-app disconnect still leaves over the websocket, naming this incarnation", () => {
    const { provider, sent } = tab();
    (provider as unknown as { connected: boolean }).connected = true;
    provider.disconnect();
    expect(sent).toEqual([
      { name: "presence:leave", args: { docId: "doc-1", sessionId: provider.sessionId, clientId: provider.doc.clientID } },
    ]);
  });

  it("a comments document, which has no presence, never touches the session store", () => {
    const storage = new TabStorage();
    vi.stubGlobal("sessionStorage", storage);
    const doc = new Y.Doc();
    const sent: string[] = [];
    const client = { mutation: async () => void sent.push("m") } as unknown as ConvexReactClient;
    const provider = new YConvexProvider(client, "comments-1", doc, { presence: false, derived: false });
    (provider as unknown as { connected: boolean }).connected = true;
    provider.disconnect();
    provider.destroy();
    doc.destroy();
    expect(storage.items.size).toBe(0);
    expect(sent).toEqual([]);
  });
});
