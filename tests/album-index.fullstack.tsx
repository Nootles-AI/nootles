import { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";
import { albumIndex } from "../app/lib/ai/albumRead";
import type { AnyBlock } from "../app/lib/ai/projection";

/**
 * The in-browser half of album-index.fullstack.mjs: the real `albumIndex` —
 * what the agent's page read appends for an expanded album — on a real
 * `ConvexReactClient` signed in to a throwaway convex-local-backend. The
 * contact sheet decodes real pictures from the fixture origin; only the model
 * behind `/api/album/index` is stood in for, by the runner.
 *
 * `dropColourWrites(n)` makes the next `n` `imageMeta:put` calls fail the way
 * a write that never lands does, which is the only thing a caller of
 * `albumIndex` can see of one: a rejected promise.
 */

let client: ConvexReactClient | null = null;
let dropping = 0;

const album = {
  connect(url: string, jwt: string) {
    client = new ConvexReactClient(url);
    client.setAuth(async () => jwt);
    const real = client.mutation.bind(client);
    client.mutation = ((ref: Parameters<typeof real>[0], ...rest: unknown[]) => {
      if (dropping > 0 && getFunctionName(ref) === "imageMeta:put") {
        dropping--;
        return Promise.reject(new Error("colour write dropped by the harness"));
      }
      return (real as (...args: unknown[]) => Promise<unknown>)(ref, ...rest);
    }) as typeof client.mutation;
  },
  dropColourWrites(n: number) {
    dropping = n;
  },
  read(blocks: AnyBlock[], expand: string[]) {
    if (!client) throw new Error("connect first");
    return albumIndex(client, blocks, expand);
  },
};

declare global {
  interface Window {
    album: typeof album;
  }
}
window.album = album;
document.getElementById("app")!.dataset.ready = "true";
