import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { ConvexReactClient } from "convex/react";
import { YConvexProvider } from "./YConvexProvider";

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
