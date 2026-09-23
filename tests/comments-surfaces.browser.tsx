import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { getFunctionName } from "convex/server";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { channelAdmits, type ProjectRole } from "../convex/auth";
import { schema } from "../app/components/editor/schema";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider } from "../app/components/comments/registry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";
import { SharedProject } from "../app/components/share/SharedProject";
import { createNmlYDoc } from "../app/lib/nml/yjs";
import { CommentsStore, readThreads } from "../app/lib/comments/store";
import { emptyCommentsDocument } from "../app/lib/comments/types";

/**
 * The commenting surfaces of a page, for every kind of visitor, over a
 * stand-in Convex.
 *
 * The REAL workspace mounts (`Workspace` → `PageSurface` →
 * `PageCommentsProvider` → `Editor`), as does the real share route
 * (`SharedProject` → `SharedEditor`); the runner swaps only each page's editor
 * import for one that also renders a small comment surface driven off
 * `usePageComments` and `useCommentableSelection` — the parts a later wave
 * dresses. Everything reaches this backend through the real `convex/react`
 * and real `YConvexProvider`s.
 *
 * The backend holds the page's Yjs log and its comments document's, and gates
 * every write the way `convex/prosemirror.ts` does: the channel is decided by
 * which document id was named, the verdict by `auth.channelAdmits` on the
 * visitor's role, and an operator standing in writes nothing at all. Every
 * call is recorded, so the runner can assert what a surface did NOT attempt.
 */

export type Visitor = "owner" | "editor" | "commenter" | "viewer" | "standIn" | "guest";
type Call = { kind: "query" | "mutation"; name: string; docId?: string; refused?: string };

const PROJECT = "project_1" as Id<"projects">;
const PAGE = "page_1" as Id<"pages">;
const PAGE_DOC = "page-doc-1";
const COMMENTS_DOC = "comments-doc-1";
const LINK = "tok-comment";

export const PAGE_TEXT = "Ship it by Friday if the tests pass.";
export const SECOND_TEXT = "A second paragraph to read.";

const IDENTITY: Record<Visitor, { userId: string; name: string } | null> = {
  owner: { userId: "user_owner", name: "Olive Owner" },
  editor: { userId: "user_editor", name: "Eddie Editor" },
  commenter: { userId: "user_commenter", name: "Cora Commenter" },
  viewer: { userId: "user_viewer", name: "Vic Viewer" },
  // The operator's session carries the impersonated subject.
  standIn: { userId: "user_commenter", name: "Cora Commenter" },
  guest: null,
};

/** What `roleForProject` resolves for each visitor; a stand-in keeps the role it stands in for. */
const ROLE: Record<Visitor, ProjectRole | null> = {
  owner: "owner",
  editor: "editor",
  commenter: "commenter",
  viewer: "viewer",
  standIn: "commenter",
  guest: null,
};

function toBuffer(update: Uint8Array): ArrayBuffer {
  return update.buffer.slice(update.byteOffset, update.byteOffset + update.byteLength) as ArrayBuffer;
}

function pageBirth(): ArrayBuffer {
  const editor = BlockNoteEditor.create({ schema });
  const doc = blocksToYDoc(editor, [
    { id: "p_ship", type: "paragraph", content: PAGE_TEXT },
    { id: "p_second", type: "paragraph", content: SECOND_TEXT },
  ] as never);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return toBuffer(update);
}

/** A comments document born server-side, optionally holding the owner's thread. */
async function commentsBirth(withThread: boolean): Promise<ArrayBuffer[]> {
  const doc = createNmlYDoc(emptyCommentsDocument(COMMENTS_DOC));
  const rows = [toBuffer(Y.encodeStateAsUpdate(doc))];
  if (withThread) {
    const before = Y.encodeStateVector(doc);
    await new CommentsStore(doc, { actor: { userId: "user_owner", kind: "human" }, authorize: () => true }).createThread({
      anchor: { blockId: "p_second", exact: "second", prefix: "A ", suffix: " paragraph to read.", offsetHint: 2 },
      body: "The owner's standing question",
      authorId: "user_owner",
      threadId: "thread_seed",
    });
    rows.push(toBuffer(Y.encodeStateAsUpdate(doc, before)));
  }
  doc.destroy();
  return rows;
}

class Backend {
  readonly calls: Call[] = [];
  private logs = new Map<string, ArrayBuffer[]>();
  private watchers = new Map<string, Set<() => void>>();
  commentsDocId: string | null = null;

  constructor(
    readonly visitor: Visitor,
    pageUpdate: ArrayBuffer,
    comments: ArrayBuffer[] | null,
  ) {
    this.logs.set(PAGE_DOC, [pageUpdate]);
    if (comments) {
      this.logs.set(COMMENTS_DOC, comments);
      this.commentsDocId = COMMENTS_DOC;
    }
  }

  private get role(): ProjectRole | null {
    return ROLE[this.visitor];
  }

  private notify(key: string) {
    for (const watcher of [...(this.watchers.get(key) ?? [])]) watcher();
  }

  private row(): Doc<"pages"> {
    return {
      _id: PAGE,
      _creationTime: 1,
      projectId: PROJECT,
      title: "Launch plan",
      order: 0,
      docId: PAGE_DOC,
      yjs: true,
      ...(this.commentsDocId ? { commentsDocId: this.commentsDocId } : {}),
    } as Doc<"pages">;
  }

  /** The gate's channel for a docId: which column it matched, never its spelling. */
  private channelOf(docId: string): "document" | "comments" | null {
    if (docId === PAGE_DOC) return "document";
    if (docId === this.commentsDocId) return "comments";
    return null;
  }

  private checkRead(docId: string) {
    const channel = this.channelOf(docId);
    if (!channel || !channelAdmits({ channel, access: "read", role: this.role, linkLive: true })) {
      throw new Error("Not found");
    }
  }

  private checkWrite(docId: string): string | null {
    if (this.visitor === "standIn") return "This session is read-only.";
    const channel = this.channelOf(docId);
    if (!channel || !channelAdmits({ channel, access: "write", role: this.role, linkLive: true })) return "Not found";
    return null;
  }

  /** `undefined` is a query still loading — the answer for anything this page need not know. */
  read(name: string, args: Record<string, unknown>): unknown {
    const docId = args.docId as string | undefined;
    switch (name) {
      case "projects:myRole":
        // `myRole` tells a stand-in "viewer" (convex/projects.ts).
        return this.visitor === "standIn" ? "viewer" : this.role;
      case "pages:listByProject":
        return [this.row()];
      case "pages:get":
        return this.row();
      case "share:view":
        return {
          projectId: PROJECT,
          role: "commenter",
          title: "Launch plan",
          pages: [{ _id: PAGE, title: "Launch plan", docId: PAGE_DOC, folderId: undefined, order: 0 }],
          folders: [],
        };
      case "comments:docFor":
        return this.role ? this.commentsDocId : null;
      case "presence:list":
        return [];
      case "nmlMigration:nmlServeEnabled":
        return false;
      case "ydoc:state":
        return "yjs";
      case "ydoc:meta":
      case "ydoc:load":
      case "ydoc:updatesSince":
      case "ydoc:snapshot": {
        this.checkRead(docId!);
        const log = this.logs.get(docId!)!;
        const seq = log.length;
        const after = (args.afterSeq as number | undefined) ?? 0;
        const updates = log.map((update, i) => ({ seq: i + 1, update })).filter((row) => row.seq > after);
        if (name === "ydoc:meta") return { seq, snapshotSeq: 0, snapshotParts: 0 };
        if (name === "ydoc:snapshot") return null;
        if (name === "ydoc:updatesSince") return updates;
        return { seq, snapshotSeq: 0, snapshotParts: 0, snapshot: null, updates };
      }
    }
    return undefined;
  }

  async mutate(name: string, args: Record<string, unknown>): Promise<unknown> {
    const docId = args.docId as string | undefined;
    const call: Call = { kind: "mutation", name, ...(docId ? { docId } : {}) };
    this.calls.push(call);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const refuse = (reason: string) => {
      call.refused = reason;
      throw new Error(reason);
    };
    switch (name) {
      case "ydoc:append": {
        const refused = this.checkWrite(docId!);
        if (refused) return refuse(refused);
        const log = this.logs.get(docId!)!;
        for (const chunk of (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer]) log.push(chunk);
        this.notify(`ydoc:meta|${docId}`);
        return log.length;
      }
      case "comments:ensureDoc": {
        if (this.visitor === "standIn") return refuse("This session is read-only.");
        if (!channelAdmits({ channel: "comments", access: "write", role: this.role, linkLive: true })) return refuse("Not found");
        if (!this.commentsDocId) {
          this.logs.set(COMMENTS_DOC, await commentsBirth(false));
          this.commentsDocId = COMMENTS_DOC;
          this.notify(`comments:docFor|${PAGE}`);
          this.notify(`pages:get|${PAGE}`);
        }
        return this.commentsDocId;
      }
    }
    // Presence, previews and the rest of what a mounted workspace sends.
    return null;
  }

  client(): ConvexReactClient {
    return {
      watchQuery: (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        this.calls.push({ kind: "query", name, ...(args.docId ? { docId: args.docId as string } : {}) });
        const key = `${name}|${String(args.docId ?? args.pageId ?? "")}`;
        return {
          onUpdate: (callback: () => void) => {
            const set = this.watchers.get(key) ?? new Set();
            set.add(callback);
            this.watchers.set(key, set);
            return () => set.delete(callback);
          },
          localQueryResult: () => this.read(name, args),
        };
      },
      query: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        this.calls.push({ kind: "query", name, ...(args.docId ? { docId: args.docId as string } : {}) });
        return this.read(name, args);
      },
      mutation: (reference: unknown, args: Record<string, unknown>) =>
        this.mutate(getFunctionName(reference as never), args),
      action: async () => null,
      setAuth() {},
      clearAuth() {},
      connectionState: () => ({ isWebSocketConnected: false, hasInflightRequests: false }),
    } as unknown as ConvexReactClient;
  }

  /** Every thread in the stored comments log, decoded afresh. */
  storedThreads() {
    if (!this.commentsDocId) return [];
    const doc = new Y.Doc();
    for (const update of this.logs.get(this.commentsDocId)!) Y.applyUpdate(doc, new Uint8Array(update));
    const threads = readThreads(doc).map((thread) => ({ id: thread.id, exact: thread.anchor.exact, comments: thread.comments.length }));
    doc.destroy();
    return threads;
  }

  /** The page's stored text, decoded afresh from its log. */
  storedPageText(): string {
    const doc = new Y.Doc();
    for (const update of this.logs.get(PAGE_DOC)!) Y.applyUpdate(doc, new Uint8Array(update));
    const text = doc.getXmlFragment("prosemirror").toString().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    doc.destroy();
    return text;
  }
}

declare global {
  interface Window {
    surfaces: {
      identity: { userId: string; name: string } | null;
      backend: Backend | null;
      signIns: string[];
      mount(visitor: Visitor, options?: { seedThread?: boolean }): Promise<void>;
      calls(): Call[];
      storedThreads(): ReturnType<Backend["storedThreads"]>;
      storedPageText(): string;
    };
  }
}

let root: Root | undefined;

window.surfaces = {
  identity: null,
  backend: null,
  signIns: [],
  async mount(visitor, options = {}) {
    const backend = new Backend(visitor, pageBirth(), options.seedThread ? await commentsBirth(true) : null);
    window.surfaces.backend = backend;
    window.surfaces.identity = IDENTITY[visitor];
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    const client = backend.client();
    root.render(
      <ConvexProvider client={client}>
        {visitor === "guest" ? (
          <OpenPageProvider>
            <SharedProject token={LINK} />
          </OpenPageProvider>
        ) : (
          // The provider stack `app/p/[projectId]/page.tsx` puts above the workspace.
          <EditorRegistryProvider>
            <PageCommentsRegistryProvider>
              <OpenPageProvider>
                <ReviewProvider projectId={PROJECT}>
                  <Workspace projectId={PROJECT} />
                </ReviewProvider>
              </OpenPageProvider>
            </PageCommentsRegistryProvider>
          </EditorRegistryProvider>
        )}
      </ConvexProvider>,
    );
  },
  calls: () => window.surfaces.backend?.calls ?? [],
  storedThreads: () => window.surfaces.backend?.storedThreads() ?? [],
  storedPageText: () => window.surfaces.backend?.storedPageText() ?? "",
};
