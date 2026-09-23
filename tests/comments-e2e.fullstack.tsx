import { Suspense, useEffect } from "react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { api } from "../convex/_generated/api";
import { schema } from "../app/components/editor/schema";
import { createRoot } from "react-dom/client";
import { usePathname } from "next/navigation";
import { getFunctionName } from "convex/server";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { EditorRegistryProvider, useEditorRegistry, type LiveEditor } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider, usePageCommentsRegistry } from "../app/components/comments/registry";
import type { PageComments } from "../app/components/comments/PageComments";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";
import { ProjectsScreen } from "../app/components/ProjectsScreen";
import { SharedProject } from "../app/components/share/SharedProject";
import { activeThread, commentRanges } from "../app/components/editor/comments/commentDecorations";
import { pmBlockTexts } from "../app/lib/comments/pmText";
import { decodeNmlDocument } from "../app/lib/nml/yjs";
import { serializeDocument } from "../app/lib/nml/serialize";

/**
 * The in-browser half of the full-stack user simulation
 * (comments-e2e.fullstack.mjs): the app as its routes mount it — `/` the
 * projects screen, `/p/<id>` the workspace, `/share/<token>` the share route —
 * against a throwaway convex-local-backend, under `ConvexProviderWithAuth` as
 * the app's root provider mounts it, signed in with the token the runner put
 * in `window.__e2e` before the page loaded. Navigation is the
 * `next/navigation` stand-in's history router, so a claim's redirect and a
 * notice's link move through the app as they would in Next.
 *
 * `window.e2e` is for reading back what a person cannot see: the function
 * names this tab called, and the page's live comment ranges and comments
 * replica. Nothing a person does goes through it.
 */

type Boot = { url: string; jwt: string | null; identity: { userId: string; name: string } | null };

declare global {
  interface Window {
    __e2e: Boot;
    e2e: typeof harness;
  }
}

const boot = window.__e2e;
const called: string[] = [];
const client = new ConvexReactClient(boot.url, { skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false });
for (const method of ["watchQuery", "mutation", "query", "action"] as const) {
  const inner = (client[method] as (...args: unknown[]) => unknown).bind(client);
  Object.assign(client, {
    [method]: (ref: never, ...rest: unknown[]) => {
      called.push(getFunctionName(ref));
      return inner(ref, ...rest);
    },
  });
}

/** Clerk's side of the app's auth provider, answered with the runner's token. */
const auth = {
  isLoading: false,
  isAuthenticated: Boolean(boot.jwt),
  fetchAccessToken: async () => boot.jwt,
};
const useAuth = () => auth;

let tap: { comments: (pageId: string) => PageComments | null; editor: (pageId: string) => Promise<LiveEditor> } | null = null;

function Tap() {
  const comments = usePageCommentsRegistry();
  const editors = useEditorRegistry();
  useEffect(() => {
    tap = {
      comments: (pageId) => comments?.current(pageId as Id<"pages">) ?? null,
      editor: (pageId) => editors.editorFor(pageId as Id<"pages">),
    };
    return () => {
      tap = null;
    };
  }, [comments, editors]);
  return null;
}

function Shell() {
  const pathname = usePathname();
  const project = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  const token = /^\/share\/([^/]+)/.exec(pathname)?.[1];
  if (pathname === "/__seed") return null;
  if (project) {
    const projectId = decodeURIComponent(project) as Id<"projects">;
    return (
      <EditorRegistryProvider key={projectId}>
        <PageCommentsRegistryProvider>
          <Tap />
          <OpenPageProvider>
            <ReviewProvider projectId={projectId}>
              <Workspace projectId={projectId} />
            </ReviewProvider>
          </OpenPageProvider>
        </PageCommentsRegistryProvider>
      </EditorRegistryProvider>
    );
  }
  if (token) {
    return (
      <OpenPageProvider>
        <SharedProject token={decodeURIComponent(token)} />
      </OpenPageProvider>
    );
  }
  return (
    <Suspense>
      <ProjectsScreen />
    </Suspense>
  );
}

const harness = {
  called: () => [...called],
  /** A page's first content, born as the app births a document: through `ydoc.init`. */
  async seed(docId: string, blocks: [string, string][]) {
    const editor = BlockNoteEditor.create({ schema });
    const doc = blocksToYDoc(editor, blocks.map(([id, content]) => ({ id, type: "paragraph", content })) as never);
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const bytes = update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
    await client.mutation(api.ydoc.init, { docId, update: bytes });
  },
  /** Each thread's live range on this client, as the words it covers (null: unanchored). */
  async ranges(pageId: string): Promise<Record<string, string | null>> {
    const state = (await tap!.editor(pageId)).prosemirrorState;
    return Object.fromEntries(
      [...commentRanges(state)].map(([id, range]) => [id, range ? state.doc.textBetween(range.from, range.to) : null]),
    );
  },
  /** A block's words in this client's document — what a review's inline diff draws around. */
  async blockText(pageId: string, blockId: string): Promise<string | null> {
    const state = (await tap!.editor(pageId)).prosemirrorState;
    return pmBlockTexts(state.doc).find((b) => b.blockId === blockId)?.text ?? null;
  },
  async active(pageId: string): Promise<string | null> {
    return activeThread((await tap!.editor(pageId)).prosemirrorState);
  },
  /** This client's replica of the comments document, as NML text. */
  commentsNml(pageId: string): string | null {
    const doc = tap?.comments(pageId)?.doc;
    return doc ? serializeDocument(decodeNmlDocument(doc)) : null;
  },
  /** The threads this client's replica holds, as its cards read them. */
  threads(pageId: string) {
    return (tap?.comments(pageId)?.threads ?? []).map((t) => ({ id: t.id, exact: t.anchor.exact, blockId: t.anchor.blockId, status: t.status }));
  },
};

window.e2e = harness;
// What the swapped-in Clerk reads.
(window as unknown as { surfaces: { identity: Boot["identity"]; signIns: string[] } }).surfaces = { identity: boot.identity, signIns: [] };
createRoot(document.getElementById("app")!).render(
  <ConvexProviderWithAuth client={client} useAuth={useAuth}>
    <Shell />
  </ConvexProviderWithAuth>,
);
