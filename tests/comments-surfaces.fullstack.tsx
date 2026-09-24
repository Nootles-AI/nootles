import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { getFunctionName } from "convex/server";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider } from "../app/components/comments/registry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";
import { SharedProject } from "../app/components/share/SharedProject";
import { readThreads } from "../app/lib/comments/store";
import { readYDocUpdates } from "../app/lib/sync/ydocRead";

/**
 * The in-browser half of the full-stack run (comments-surfaces.fullstack.mjs):
 * the real workspace and share route against a throwaway convex-local-backend,
 * signed in with tokens from the runner's own issuer. Every function call is
 * the real one, gated by the real `convex/prosemirror.ts` and `convex/auth.ts`.
 */

type Config = {
  url: string;
  /** Null for a signed-out visitor. */
  jwt: string | null;
  identity: { userId: string; name: string } | null;
  projectId?: string;
  token?: string;
};

let client: ConvexReactClient | undefined;
let root: Root | undefined;
const called: string[] = [];

/** The client, recording the name of every function the surfaces reach for. */
function recording(inner: ConvexReactClient): ConvexReactClient {
  const watchQuery = inner.watchQuery.bind(inner);
  const mutation = inner.mutation.bind(inner);
  const query = inner.query.bind(inner);
  Object.assign(inner, {
    watchQuery: (ref: never, ...rest: never[]) => {
      called.push(getFunctionName(ref));
      return watchQuery(ref, ...rest);
    },
    mutation: (ref: never, ...rest: never[]) => {
      called.push(getFunctionName(ref));
      return mutation(ref, ...rest);
    },
    query: (ref: never, ...rest: never[]) => {
      called.push(getFunctionName(ref));
      return query(ref, ...rest);
    },
  });
  return inner;
}

function connect(cfg: Config): ConvexReactClient {
  const made = new ConvexReactClient(cfg.url, { skipConvexDeploymentUrlCheck: true });
  if (cfg.jwt) {
    const jwt = cfg.jwt;
    made.setAuth(async () => jwt);
  }
  return recording(made);
}

function toBuffer(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

const harness = {
  identity: null as Config["identity"],
  signIns: [] as string[],

  /** Connect without mounting anything — the owner's reading and seeding hands. */
  connect(cfg: Config) {
    harness.identity = cfg.identity;
    client = connect(cfg);
  },

  /** The page's first content, born as the app births a document: through `ydoc.init`. */
  async seedPage(docId: string, blocks: { id: string; text: string }[]) {
    const editor = BlockNoteEditor.create({ schema });
    const doc = blocksToYDoc(editor, blocks.map((b) => ({ id: b.id, type: "paragraph", content: b.text })) as never);
    const update = toBuffer(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    return client!.mutation(api.ydoc.init, { docId, update });
  },

  mount(cfg: Config) {
    harness.connect(cfg);
    // Clerk's side of the app's auth provider, answered with the runner's
    // token: the workspace asks `useConvexAuth` whether anyone is signed in.
    const auth = { isLoading: false, isAuthenticated: Boolean(cfg.jwt), fetchAccessToken: async () => cfg.jwt };
    const useAuth = () => auth;
    root = createRoot(document.getElementById("app")!);
    root.render(
      <ConvexProviderWithAuth client={client!} useAuth={useAuth}>
        {cfg.token ? (
          <OpenPageProvider>
            <SharedProject token={cfg.token} />
          </OpenPageProvider>
        ) : (
          <EditorRegistryProvider>
            <PageCommentsRegistryProvider>
              <OpenPageProvider>
                <ReviewProvider projectId={cfg.projectId as Id<"projects">}>
                  <Workspace projectId={cfg.projectId as Id<"projects">} />
                </ReviewProvider>
              </OpenPageProvider>
            </PageCommentsRegistryProvider>
          </EditorRegistryProvider>
        )}
      </ConvexProviderWithAuth>,
    );
  },

  called: () => [...called],

  /** A raw append from this tab's identity — what the surface itself never tries. */
  async forceAppend(docId: string): Promise<string> {
    const doc = new Y.Doc();
    doc.getMap("forged").set("by", harness.identity?.userId ?? "nobody");
    try {
      await client!.mutation(api.ydoc.append, { docId, update: toBuffer(Y.encodeStateAsUpdate(doc)) });
      return "accepted";
    } catch (error) {
      return `refused: ${(error as Error).message.split("\n")[0]}`;
    }
  },

  async commentsDocId(pageId: string): Promise<string | null> {
    return client!.query(api.comments.docFor, { pageId: pageId as Id<"pages"> });
  },

  async pageSeq(docId: string): Promise<number> {
    return (await client!.query(api.ydoc.meta, { docId }))?.seq ?? 0;
  },

  /** The comments document as stored, decoded afresh with this tab's identity. */
  async storedThreads(pageId: string) {
    const docId = await harness.commentsDocId(pageId);
    if (!docId) return [];
    const doc = new Y.Doc();
    for (const update of await readYDocUpdates(client!, docId)) Y.applyUpdate(doc, new Uint8Array(update));
    const threads = readThreads(doc).map((thread) => ({
      exact: thread.anchor.exact,
      blockId: thread.anchor.blockId,
      authors: thread.comments.map((comment) => comment.authorId),
    }));
    doc.destroy();
    return threads;
  },
};

declare global {
  interface Window {
    full: typeof harness;
  }
}
window.full = harness;
// What the swapped-in Clerk reads (declared on `Window` by the stand-in entry).
(window as unknown as { surfaces: { identity: Config["identity"]; signIns: string[] } }).surfaces = {
  get identity() {
    return harness.identity;
  },
  signIns: harness.signIns,
};
document.getElementById("app")?.setAttribute("data-ready", "true");
