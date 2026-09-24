import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { getFunctionName } from "convex/server";
import type { ConvexReactClient } from "convex/react";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { createRemoteCarets } from "../app/lib/sync/remoteCarets";
import { remoteScrollExtension } from "../app/lib/sync/remoteScroll";
import { YConvexProvider } from "../app/lib/sync/YConvexProvider";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

type Editor = typeof schema.BlockNoteEditor;

type PresenceRow = {
  sessionId: string;
  clientId: number;
  userId: string | null;
  user: { name: string; color: string };
  state: ArrayBuffer;
  updatedAt: number;
};

/**
 * Convex, as far as `YConvexProvider` can tell: the `ydocs` update log and the
 * `presence` table, with the two watches the provider subscribes to. Standing
 * in for the backend rather than for the provider is the point — `applyPresence`,
 * the staleness horizon and the heartbeat cadence are the code under test.
 *
 * A function this stand-in does not know is logged as a console error before
 * it throws, and the runner fails on console errors. The provider swallows a
 * failed pull and waits for the next wake, so a throw alone is silent: when
 * #150 moved the first read to `ydoc.load`, this fixture's `whenSynced` simply
 * never resolved and the run hung before its first check (NT-74).
 */
class Backend {
  private seq = 0;
  private log: Array<{ seq: number; update: ArrayBuffer }> = [];
  private rows = new Map<string, PresenceRow>();
  private metaWatchers = new Set<() => void>();
  private presenceWatchers = new Set<() => void>();

  /** Sessions whose tab is suspended: their heartbeats never reach the table. */
  readonly suspended = new Set<string>();

  meta() {
    return { seq: this.seq, snapshotSeq: 0, snapshotParts: 0 };
  }

  since(afterSeq: number) {
    return this.log.filter((row) => row.seq > afterSeq).map((row) => ({ ...row }));
  }

  /** `ydoc.load`: meta and the log tail in one answer. No snapshot is ever folded here. */
  load(afterSeq: number) {
    return { ...this.meta(), snapshot: null, updates: this.since(afterSeq) };
  }

  list(): PresenceRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  append(update: ArrayBuffer) {
    this.seq += 1;
    this.log.push({ seq: this.seq, update });
    for (const watcher of this.metaWatchers) watcher();
    return this.seq;
  }

  heartbeat(row: Omit<PresenceRow, "userId" | "updatedAt">) {
    if (this.suspended.has(row.sessionId)) return;
    this.rows.set(row.sessionId, { ...row, userId: null, updatedAt: Date.now() });
    this.wake();
  }

  leave(sessionId: string) {
    this.rows.delete(sessionId);
    this.wake();
  }

  /** A suspended tab's row simply ages past the client's staleness horizon. */
  age(sessionId: string, by: number) {
    const row = this.rows.get(sessionId);
    if (row) row.updatedAt -= by;
    this.wake();
  }

  wake() {
    for (const watcher of this.presenceWatchers) watcher();
  }

  client(): ConvexReactClient {
    const stand = {
      watchQuery: (reference: unknown, args: { docId: string; afterSeq?: number }) => {
        const name = getFunctionName(reference as never);
        const watchers = name === "presence:list" ? this.presenceWatchers : this.metaWatchers;
        return {
          onUpdate: (callback: () => void) => {
            watchers.add(callback);
            return () => watchers.delete(callback);
          },
          localQueryResult: () => this.read(name, args),
        };
      },
      query: async (reference: unknown, args: Record<string, unknown>) =>
        this.read(getFunctionName(reference as never), args),
      mutation: async (reference: unknown, args: Record<string, unknown>) => {
        const name = getFunctionName(reference as never);
        if (name === "ydoc:append") {
          const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [
            args.update as ArrayBuffer,
          ];
          let last = this.seq;
          for (const chunk of chunks) last = this.append(chunk);
          return last;
        }
        if (name === "presence:heartbeat") {
          this.heartbeat(args as never);
          return null;
        }
        if (name === "presence:leave") {
          this.leave(args.sessionId as string);
          return null;
        }
        // The preview and the context digest a flush leaves behind: derived
        // data, not under test, taken as the server would take them.
        if (name === "previews:set") return null;
        if (name === "context/pages:digest") return true;
        return unknown("mutation", name);
      },
    };
    return stand as unknown as ConvexReactClient;
  }

  private read(name: string, args: Record<string, unknown>) {
    if (name === "ydoc:meta") return this.meta();
    if (name === "ydoc:load") return this.load(args.afterSeq as number);
    if (name === "ydoc:updatesSince") return this.since(args.afterSeq as number);
    if (name === "ydoc:snapshot") return null;
    if (name === "presence:list") return this.list();
    return unknown("query", name);
  }
}

function unknown(kind: string, name: string): never {
  const message = `fixture backend has no ${kind} ${name}`;
  console.error(message);
  throw new Error(message);
}

const backend = new Backend();
const DOC_ID = "page-nt26";

type Person = {
  provider: YConvexProvider;
  editor: Editor;
  root: Root;
};

/** One person: their own Y.Doc, provider, editor and caret layer. */
async function join(
  role: "a" | "b",
  user: { name: string; color: string },
): Promise<Person> {
  const doc = new Y.Doc();
  const provider = new YConvexProvider(backend.client(), DOC_ID, doc);
  provider.connect();
  await provider.whenSynced;

  // The composition from `useYjsEditor.ts`.
  const carets = createRemoteCarets(provider.awareness);
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema,
      extensions: [remoteScrollExtension],
      collaboration: {
        fragment: provider.doc.getXmlFragment("prosemirror"),
        user,
        provider: { awareness: provider.awareness },
        showCursorLabels: "always",
        renderCursor: carets.render,
      },
    } as never),
  ) as unknown as Editor;
  provider.awareness.setLocalStateField("user", user);

  const root = createRoot(document.getElementById(role)!);
  root.render(
    <div className="nt-pane" style={{ padding: 24 }}>
      <BlockNoteView
        editor={editor}
        theme="light"
        className="nt-editor"
        sideMenu={false}
        slashMenu={false}
        formattingToolbar={false}
      />
    </div>,
  );
  carets.attach();
  return { provider, editor, root };
}

/**
 * A: the observer, whose screen every check reads. B: the collaborator who
 * goes away and comes back. Only B is ever focused — y-prosemirror clears a
 * blurred editor's cursor from awareness, and A does not need its own caret
 * to draw B's.
 */
let a: Person;
let b: Person;

async function mount() {
  a = await join("a", { name: "Ada", color: "#3366cc" });
  b = await join("b", { name: "Bram", color: "#cc3366" });
}

/** The private heartbeat the keepalive sends every 10s, on demand. */
const beat = (person: Person) =>
  (person.provider as unknown as { sendAwareness(): void }).sendAwareness();

/** B's tab suspends: it writes no row, and the one it left ages out. */
function away() {
  backend.suspended.add(b.provider.sessionId);
  backend.age(b.provider.sessionId, 31_000);
}

/** B's tab wakes and heartbeats again — at the clock it fell asleep on. */
function back() {
  backend.suspended.delete(b.provider.sessionId);
  beat(b);
}

/** What A's screen shows of other people. */
const seen = () =>
  [...document.querySelectorAll("#a .nt-remote-caret")].map((caret) => ({
    name: caret.querySelector(".nt-remote-caret-name")?.textContent ?? null,
    color: (caret as HTMLElement).style.getPropertyValue("--copresence"),
    unfurled: caret.hasAttribute("data-active"),
  }));

/** Whom A's awareness holds, which is what the facepile and canvas read. */
const known = () =>
  [...a.provider.awareness.getStates().entries()]
    .filter(([clientId]) => clientId !== a.provider.doc.clientID)
    .map(([, state]) => (state as { user?: { name?: string } }).user?.name ?? null);

declare global {
  interface Window {
    nt: {
      mount: typeof mount;
      away: typeof away;
      back: typeof back;
      seen: typeof seen;
      known: typeof known;
      beat: () => void;
      /** B's awareness clock — the thing y-protocols orders updates by. */
      clock: () => number | undefined;
      /** y-protocols' renewal timer, which a live tab runs every ~15s. */
      renew: () => void;
      text: () => string;
      bBlockId: () => string | undefined;
    };
  }
}

window.nt = {
  mount,
  away,
  back,
  seen,
  known,
  beat: () => beat(b),
  clock: () => b.provider.awareness.meta.get(b.provider.doc.clientID)?.clock,
  renew: () => b.provider.awareness.setLocalState(b.provider.awareness.getLocalState()),
  text: () => a.editor.document.map((block) => JSON.stringify(block.content)).join(" "),
  bBlockId: () => b.editor.document[0]?.id,
};
