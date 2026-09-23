import { useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { channelAdmits, type ProjectRole } from "../convex/roles";
import { schema } from "../app/components/editor/schema";
import { EditorRegistryProvider, useEditorRegistry } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider, usePageCommentsRegistry } from "../app/components/comments/registry";
import type { PageComments } from "../app/components/comments/PageComments";
import type { LiveEditor } from "../app/components/editor/EditorRegistry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";
import { SharedProject } from "../app/components/share/SharedProject";
import { marginStats } from "../app/components/comments/CommentMargin";
import { activeThread } from "../app/components/editor/comments/commentDecorations";
import { createComment, pageText } from "../app/lib/ai/chat/commentTools";
import { pmBlockTexts } from "../app/lib/comments/pmText";
import { anchorForQuote } from "../app/lib/comments/resolve";
import { CommentsStore, readThreads } from "../app/lib/comments/store";
import { commentText, emptyCommentsDocument } from "../app/lib/comments/types";
import { createNmlYDoc } from "../app/lib/nml/yjs";

/**
 * The comment UI (margin cards, composer, panel, dots) for a person at a
 * browser, over a stand-in Convex shared by every tab of the run.
 *
 * The REAL workspace mounts — `Workspace` → `PageSurface` →
 * `PageCommentsProvider` → `CommentsLayer` → the production `Editor` — with
 * nothing swapped but the transport: `convex/react` talks to the `Backend`
 * below, and real `YConvexProvider`s sync the page and its comments document
 * through it. Each tab's backend relays every update it accepts to the runner
 * (`uiRelay`), which hands it to every other tab (`ui.receive`), so two people
 * in two browsers see one conversation. The runner also mints the comments
 * document once for everyone (`uiEnsure`) and answers the notice mutation
 * (`uiNotice`), refusing a mention of someone who cannot open the project.
 *
 * The gate is the real one's rule: the channel is decided by which document
 * id was named, the verdict by `auth.channelAdmits` on the visitor's role.
 */

type Visitor = "ada" | "cam" | "guest";

declare global {
  interface Window {
    uiRelay: (docId: string, update: string) => Promise<void>;
    uiFetch: () => Promise<{ logs: Record<string, string[]>; commentsDocId: string | null }>;
    uiEnsure: (birth: string) => Promise<{ docId: string; birth: string }>;
    uiNotice: (who: string, name: string, args: Record<string, unknown>) => Promise<{ refused?: string[] }>;
    __cardRenders?: number;
    ui: typeof ui;
  }
}

const PROJECT = "project_1" as Id<"projects">;
const PAGE = "page_1" as Id<"pages">;
const PAGE_DOC = "page-doc-1";
const LINK = "tok-comment";
const COMMENTS_DOC = "comments-doc-1";

const PARAGRAPHS: [string, string][] = [
  ["p_intro", "Launch plan for the autumn release, drafted for the whole team to read before Monday."],
  ["p_ship", "Ship it by Friday if the tests pass and the design review signs off."],
  ["p_risk", "The main risk is the migration, which touches every stored document."],
  ["p_owner", "Ada owns the rollout and Cam owns the written announcement."],
  ["p_budget", "Budget stays flat; the extra hosting cost is covered by the old plan."],
  ["p_notes", "Questions go in the comments rather than in the chat, so they stay beside the words."],
  ["p_detail", "The rollout runs in three waves: staff first, then a tenth of accounts, then everyone. Each wave waits a day for the error rate to settle, and any wave can be paused from the console without a deploy."],
  ["p_after", "After launch we review what the comments taught us and fold it into the next plan."],
];

type Person = { userId: string; name: string; imageUrl: null };
const OLIVE: Person = { userId: "user_olive", name: "Olive Owner", imageUrl: null };
const ADA: Person = { userId: "user_ada", name: "Ada Editor", imageUrl: null };
const CAM: Person = { userId: "user_cam", name: "Cam Commenter", imageUrl: null };
/** On Ada's list, but the server refuses her: her link was revoked. */
const DEE: Person = { userId: "user_dee", name: "Dee Departed", imageUrl: null };

const IDENTITY: Record<Visitor, Person | null> = { ada: ADA, cam: CAM, guest: null };
const ROLE: Record<Visitor, ProjectRole | null> = { ada: "editor", cam: "commenter", guest: null };

const toB64 = (bytes: Uint8Array) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toBuffer = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

function pageBirth(): Uint8Array {
  const editor = BlockNoteEditor.create({ schema });
  const doc = blocksToYDoc(
    editor,
    PARAGRAPHS.map(([id, content]) => ({ id, type: "paragraph", content })) as never,
  );
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/** The comments document as the server mints it: its empty root, update #1. */
function commentsBirth(docId: string): Uint8Array {
  const doc = createNmlYDoc(emptyCommentsDocument(docId));
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

class Backend {
  private logs = new Map<string, ArrayBuffer[]>();
  private watchers = new Map<string, Set<() => void>>();
  commentsDocId: string | null;
  mentionable: Person[];

  constructor(
    readonly visitor: Visitor,
    fetched: Awaited<ReturnType<Window["uiFetch"]>>,
  ) {
    for (const [docId, updates] of Object.entries(fetched.logs)) {
      this.logs.set(docId, updates.map((u) => toBuffer(fromB64(u))));
    }
    this.commentsDocId = fetched.commentsDocId;
    const me = IDENTITY[visitor]?.userId;
    this.mentionable = [OLIVE, ADA, CAM, ...(visitor === "ada" ? [DEE] : [])].filter((p) => p.userId !== me);
  }

  private get role(): ProjectRole | null {
    return ROLE[this.visitor];
  }

  notify(key: string) {
    for (const watcher of [...(this.watchers.get(key) ?? [])]) watcher();
  }

  /** An update another tab's backend accepted. */
  receive(docId: string, update: Uint8Array) {
    const log = this.logs.get(docId);
    if (!log) return;
    log.push(toBuffer(update));
    this.notify(`ydoc:meta|${docId}`);
    this.notify(`ydoc:updatesSince|${docId}`);
  }

  minted(docId: string, birth: Uint8Array) {
    if (this.commentsDocId) return;
    this.logs.set(docId, [toBuffer(birth)]);
    this.commentsDocId = docId;
    this.notify(`comments:docFor|${PAGE}`);
    this.notify(`pages:get|${PAGE}`);
    this.notify(`pages:listByProject|`);
  }

  revoke(userId: string) {
    this.mentionable = this.mentionable.filter((p) => p.userId !== userId);
    this.notify(`commentNotices:mentionable|${PAGE}`);
  }

  private row(): Doc<"pages"> {
    return {
      _id: PAGE,
      _creationTime: 1,
      projectId: PROJECT,
      title: "Autumn launch",
      order: 0,
      docId: PAGE_DOC,
      yjs: true,
      ...(this.commentsDocId ? { commentsDocId: this.commentsDocId } : {}),
    } as Doc<"pages">;
  }

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

  read(name: string, args: Record<string, unknown>): unknown {
    const docId = args.docId as string | undefined;
    switch (name) {
      case "projects:myRole":
        return this.role;
      case "pages:listByProject":
        return [this.row()];
      case "pages:get":
        return this.row();
      case "share:view":
        return {
          projectId: PROJECT,
          role: "commenter",
          title: "Autumn launch",
          pages: [{ _id: PAGE, title: "Autumn launch", docId: PAGE_DOC, folderId: undefined, order: 0 }],
          folders: [],
        };
      case "comments:docFor":
        return this.role ? this.commentsDocId : null;
      case "commentNotices:mentionable":
        return this.role ? this.mentionable : [];
      case "commentNotices:authors":
        return this.role
          ? [OLIVE, ADA, CAM, DEE].filter((person) => (args.userIds as string[]).includes(person.userId))
          : [];
      case "commentNotices:inbox":
        return [];
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
    await new Promise((resolve) => setTimeout(resolve, 5));
    switch (name) {
      case "ydoc:append": {
        const channel = this.channelOf(docId!);
        if (!channel || !channelAdmits({ channel, access: "write", role: this.role, linkLive: true })) {
          ui.refusals.push(`${channel}:${docId}`);
          throw new Error("Not found");
        }
        const log = this.logs.get(docId!)!;
        const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer];
        for (const chunk of chunks) {
          log.push(chunk);
          await window.uiRelay(docId!, toB64(new Uint8Array(chunk)));
        }
        this.notify(`ydoc:meta|${docId}`);
        return log.length;
      }
      case "comments:ensureDoc": {
        if (!channelAdmits({ channel: "comments", access: "write", role: this.role, linkLive: true })) {
          throw new Error("Not found");
        }
        const { docId: minted, birth } = await window.uiEnsure(toB64(commentsBirth(COMMENTS_DOC)));
        this.minted(minted, fromB64(birth));
        return minted;
      }
      case "commentNotices:event": {
        const me = IDENTITY[this.visitor]!;
        const answer = await window.uiNotice(me.userId, name, args);
        if (answer.refused?.length) {
          throw new ConvexError({ code: "outsider", userIds: answer.refused, message: "They can't open this project." });
        }
        return null;
      }
      case "commentNotices:markPageSeen": {
        await window.uiNotice(IDENTITY[this.visitor]!.userId, name, args);
        return null;
      }
    }
    return null;
  }

  client(): ConvexReactClient {
    return {
      watchQuery: (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
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
      query: async (reference: unknown, args: Record<string, unknown>) =>
        this.read(getFunctionName(reference as never), args),
      mutation: (reference: unknown, args: Record<string, unknown>) =>
        this.mutate(getFunctionName(reference as never), args),
      action: async () => null,
      setAuth() {},
      clearAuth() {},
      connectionState: () => ({ isWebSocketConnected: false, hasInflightRequests: false }),
    } as unknown as ConvexReactClient;
  }

  /** The stored comments log, decoded afresh — what every replica converges to. */
  storedThreads() {
    if (!this.commentsDocId) return [];
    const doc = new Y.Doc();
    for (const update of this.logs.get(this.commentsDocId)!) Y.applyUpdate(doc, new Uint8Array(update));
    const threads = readThreads(doc).map((t) => ({
      id: t.id,
      exact: t.anchor.exact,
      blockId: t.anchor.blockId,
      status: t.status,
      orphaned: t.orphanedAt !== undefined,
      comments: t.comments.map((c) => ({
        text: commentText(c.content),
        authorId: c.authorId,
        ...(c.via ? { via: c.via } : {}),
        ...(c.editedAt !== undefined ? { edited: true } : {}),
      })),
    }));
    doc.destroy();
    return threads;
  }

  storedPageText(): string {
    const doc = new Y.Doc();
    for (const update of this.logs.get(PAGE_DOC)!) Y.applyUpdate(doc, new Uint8Array(update));
    const text = doc.getXmlFragment("prosemirror").toString().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    doc.destroy();
    return text;
  }
}

/** Reaches into the mounted app for what a harness needs and a person never sees. */
let tap: { comments: () => PageComments | null; editor: () => Promise<LiveEditor> } | null = null;

function Tap() {
  const comments = usePageCommentsRegistry();
  const editors = useEditorRegistry();
  useEffect(() => {
    tap = { comments: () => comments?.current(PAGE) ?? null, editor: () => editors.editorFor(PAGE) };
    return () => {
      tap = null;
    };
  }, [comments, editors]);
  return null;
}

let root: Root | undefined;
let backend: Backend | null = null;

const ui = {
  identity: null as Person | null,
  signIns: [] as string[],
  refusals: [] as string[],
  PARAGRAPHS,
  async mount(visitor: Visitor) {
    const fetched = await window.uiFetch();
    if (!fetched.logs[PAGE_DOC]?.length) {
      const birth = pageBirth();
      await window.uiRelay(PAGE_DOC, toB64(birth));
      fetched.logs[PAGE_DOC] = [toB64(birth)];
    }
    backend = new Backend(visitor, fetched);
    ui.identity = IDENTITY[visitor];
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    root.render(
      <ConvexProvider client={backend.client()}>
        {visitor === "guest" ? (
          <OpenPageProvider>
            <SharedProject token={LINK} />
          </OpenPageProvider>
        ) : (
          <EditorRegistryProvider>
            <PageCommentsRegistryProvider>
              <Tap />
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
  receive(docId: string, update: string) {
    backend?.receive(docId, fromB64(update));
  },
  minted(docId: string, birth: string) {
    backend?.minted(docId, fromB64(birth));
  },
  revoke(userId: string) {
    backend?.revoke(userId);
  },
  stored: () => backend?.storedThreads() ?? [],
  storedPageText: () => backend?.storedPageText() ?? "",
  renders: () => window.__cardRenders ?? 0,
  margin: () => ({ ...marginStats }),
  async active(): Promise<string | null> {
    const editor = await tap!.editor();
    return activeThread(editor.prosemirrorState);
  },
  /** A thread the assistant starts, through its real tool and the person's store. */
  async assistantComment(input: { blockId: string; quote: string; text: string }) {
    const comments = tap!.comments()!;
    const editor = await tap!.editor();
    return createComment(
      { comments, people: [OLIVE, ADA, CAM], notify: (event) => backend!.mutate("commentNotices:event", event) },
      input,
      pageText(editor),
      `call_${Date.now()}`,
    );
  },
  /** A collaborator's edit landing in this editor: `word` in `blockId` deleted. */
  async deleteWords(blockId: string, word: string) {
    const view = (await tap!.editor()).prosemirrorView!;
    const block = pmBlockTexts(view.state.doc).find((b) => b.blockId === blockId)!;
    const at = block.text.indexOf(word);
    view.dispatch(view.state.tr.delete(block.map.posAt[at], block.map.posAt[at + word.length - 1] + 1));
  },
  /** `n` threads on words of the page, written as the signed-in person — a busy page. */
  async seedThreads(words: [string, string][]) {
    const comments = tap!.comments()!;
    const store = comments.store ?? (await comments.ensureStore());
    const editor = await tap!.editor();
    const blocks = pmBlockTexts(editor.prosemirrorState.doc);
    for (const [blockId, exact] of words) {
      const minted = anchorForQuote({ blockId, exact }, blocks);
      if (!minted.ok) throw new Error(`${exact} is not in ${blockId}`);
      await new CommentsStore(store.doc, { actor: { userId: ui.identity!.userId, kind: "human" }, authorize: () => true }).createThread({
        anchor: minted.anchor,
        body: `A note on ${exact}`,
        authorId: ui.identity!.userId,
      });
    }
  },
};

window.ui = ui;
// The Clerk fixture (comments-surfaces.shared.mjs) reads who is signed in here.
(window as unknown as { surfaces: typeof ui }).surfaces = ui;
