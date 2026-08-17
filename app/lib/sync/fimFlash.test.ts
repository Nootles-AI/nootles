import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import type { EditorView } from "prosemirror-view";
import { armFlash, flashBlocksInView } from "@/app/components/editor/arrivalFlash";
import type { YConvexProvider } from "./YConvexProvider";
import { watchFimFlash } from "./fimFlash";

vi.mock("@/app/components/editor/arrivalFlash", () => ({
  armFlash: vi.fn(),
  flashBlocksInView: vi.fn(),
}));

/**
 * The watcher runs inside a Yjs observer on a value ANY peer can write.
 * These pin the properties that keep it safe there: hostile shapes never
 * throw (a throw would disrupt applying the update that carried them),
 * markers never replay, own markers never flash, and id lists stay bounded.
 */

const FLASH_MAP = "nt:flash";

/** A provider-shaped origin: the watcher only reads `.doc` and compares identity. */
const providerFor = (doc: Y.Doc) => ({ doc }) as unknown as YConvexProvider;

/** Ship everything `to` hasn't seen, applied with the given origin — a sync flush. */
const relay = (from: Y.Doc, to: Y.Doc, origin: unknown) => {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), origin);
};

/** A view whose doc contains exactly these block ids. */
const viewWith = (ids: string[]) =>
  ({
    state: {
      doc: {
        descendants(cb: (node: { attrs: { id?: string }; isTextblock: boolean }) => unknown) {
          for (const id of ids) cb({ attrs: { id }, isTextblock: false });
        },
      },
    },
  }) as unknown as EditorView;

const flushDeferred = () => new Promise((r) => setTimeout(r, 1));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("watchFimFlash", () => {
  test("arms unseen blocks inside the observer window", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    watchFimFlash(provider, () => viewWith([]));

    peer.getMap(FLASH_MAP).set("last", { ids: ["a", "b"], n: 1, by: peer.clientID });
    relay(peer, local, provider);

    expect(armFlash).toHaveBeenCalledExactlyOnceWith(["a", "b"]);
    expect(flashBlocksInView).not.toHaveBeenCalled();
  });

  test("late-flashes blocks already on screen, deferred out of the observer", async () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    const view = viewWith(["a"]);
    watchFimFlash(provider, () => view);

    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 1, by: peer.clientID });
    relay(peer, local, provider);

    expect(flashBlocksInView).not.toHaveBeenCalled();
    await flushDeferred();
    expect(flashBlocksInView).toHaveBeenCalledExactlyOnceWith(view, ["a"]);
    expect(armFlash).not.toHaveBeenCalled();
  });

  test("updates applied with a foreign origin are not remote arrivals", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    watchFimFlash(providerFor(local), () => viewWith([]));

    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 1, by: peer.clientID });
    relay(peer, local, null);

    expect(armFlash).not.toHaveBeenCalled();
  });

  test("a marker by this client never flashes here", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    watchFimFlash(provider, () => viewWith([]));

    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 1, by: local.clientID });
    relay(peer, local, provider);

    expect(armFlash).not.toHaveBeenCalled();
  });

  test("a marker already in the doc does not replay on the first remote edit", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    peer.getMap(FLASH_MAP).set("last", { ids: ["old"], n: 1, by: peer.clientID });
    relay(peer, local, provider); // lands before anyone watches

    watchFimFlash(provider, () => viewWith([]));
    peer.getMap("unrelated").set("k", 1);
    relay(peer, local, provider);

    expect(armFlash).not.toHaveBeenCalled();
  });

  test("the same accept never replays", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    watchFimFlash(provider, () => viewWith([]));

    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 7, by: peer.clientID });
    relay(peer, local, provider);
    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 7, by: peer.clientID });
    relay(peer, local, provider);

    expect(armFlash).toHaveBeenCalledTimes(1);
  });

  test("hostile marker shapes never throw and never flash", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    watchFimFlash(provider, () => viewWith([]));

    for (const junk of [
      null,
      "junk",
      42,
      { ids: 5, n: 1, by: 1 },
      { ids: "a", n: 1, by: 1 },
      { ids: [1, 2, 3], n: 1, by: 1 },
      { n: 1, by: 1 },
    ]) {
      peer.getMap(FLASH_MAP).set("last", junk);
      expect(() => relay(peer, local, provider)).not.toThrow();
    }
    expect(armFlash).not.toHaveBeenCalled();
    expect(flashBlocksInView).not.toHaveBeenCalled();
  });

  test("id lists are capped, and non-string ids are dropped", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    watchFimFlash(provider, () => viewWith([]));

    const ids = [7, ...Array.from({ length: 1000 }, (_, i) => `id-${i}`)];
    peer.getMap(FLASH_MAP).set("last", { ids, n: 1, by: peer.clientID });
    relay(peer, local, provider);

    const armed = vi.mocked(armFlash).mock.calls[0][0];
    expect(armed).toHaveLength(256);
    expect(armed[0]).toBe("id-0");
  });

  test("unwatch detaches the observer", () => {
    const peer = new Y.Doc();
    const local = new Y.Doc();
    const provider = providerFor(local);
    const stop = watchFimFlash(provider, () => viewWith([]));
    stop();

    peer.getMap(FLASH_MAP).set("last", { ids: ["a"], n: 1, by: peer.clientID });
    relay(peer, local, provider);

    expect(armFlash).not.toHaveBeenCalled();
  });
});
