import { useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Id } from "../convex/_generated/dataModel";
import { Sidebar } from "../app/components/Sidebar";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { ReviewProvider } from "../app/components/ReviewContext";
import { DrawerScrim, LeftDrawer, drawerLayer } from "../app/components/Drawer";
import { Menu, MenuItem } from "../app/components/Menu";
import { ThreadPicker } from "../app/components/chat/ThreadPicker";
import { FullscreenShot } from "../app/components/editor/storyboard/FullscreenShot";
import { shotHeight } from "../app/components/editor/storyboard/types";
import type { BoardApi } from "../app/components/editor/canvas/render/CanvasSurface";

/**
 * NT-76: every menu a summoned panel opens must paint over that panel.
 *
 * The real `Sidebar` in the real compact drawer (`LeftDrawer`), a panel
 * wearing the chat drawer's layer with the chat's real `Menu` and
 * `ThreadPicker` in it, and the storyboard's real `FullscreenShot` with the
 * canvas bar it brings — or, as the control, the sidebar in the wide rail's
 * markup. `convex/react`, `@clerk/nextjs` and `next/navigation`
 * are swapped at bundle time (see the runner) for an in-memory stand-in.
 */

type Mode = "drawer" | "rail";
type Call = { kind: "query" | "mutation"; name: string; args: unknown };

const PROJECT = "project_1" as Id<"projects">;
const OWNER = "user_owner";

function createBackend() {
  const calls: Call[] = [];
  const unknown = new Set<string>();
  const pages = [
    { _id: "page_1", _creationTime: 1, projectId: PROJECT, title: "Meeting notes", docId: "doc_1", order: 0 },
    { _id: "page_2", _creationTime: 2, projectId: PROJECT, title: "Roadmap", docId: "doc_2", order: 1 },
  ];
  const answer = (name: string): unknown => {
    switch (name) {
      case "projects:get":
        return { _id: PROJECT, _creationTime: 1, ownerId: OWNER, title: "Launch plan", createdAt: 1 };
      case "projects:myRole":
        return "owner";
      case "pages:listByProject":
        return pages;
      case "folders:listByProject":
        return [];
      case "share:links":
        return {
          viewer: null,
          commenter: null,
          editor: null,
          expiresAt: { viewer: null, commenter: null, editor: null },
          allowed: true,
          defaultDays: null,
        };
      case "share:collaborators":
      case "share:incomingRequests":
        return [];
      case "impersonation:current":
        return null;
      case "profiles:get":
        return { hintsSeen: [] };
      case "chat/turns:unreviewed":
      case "github/repos:listForProject":
      case "files/context:listForProject":
      case "notion/context:listForProject":
      case "ai/context:list":
        return [];
      case "entitlements:mine":
        return { left: null };
      // A personal project on its owner's paid plan: no workspace to answer.
      case "entitlements:forContainer":
        return {
          container: { kind: "account" },
          plan: "pro",
          features: { unmetered: true, auditLog: false, comments: true, guestDailyAiUsd: 1 },
          entitlement: { plan: "pro", source: "subscription", left: null, used: null },
          guestAi: null,
        };
    }
    unknown.add(name);
    return undefined;
  };
  return {
    calls,
    unknown,
    subscribe: () => () => {},
    read(name: string, args: unknown) {
      calls.push({ kind: "query", name, args });
      return answer(name);
    },
    async mutate(name: string, args: unknown) {
      calls.push({ kind: "mutation", name, args });
      return null;
    },
  };
}

declare global {
  var drawerHarness: {
    backend: ReturnType<typeof createBackend>;
    mount: (mode: Mode) => void;
    picked: string[];
    selected: string[];
    ratio: string | null;
    keysShown: number;
  };
}

/** The wide rail's markup in `Workspace`, for the control. */
function Rail({ children }: { children: ReactNode }) {
  return (
    <div className="nt-shell flex h-screen w-full overflow-hidden">
      <div className="nt-rail-slot" data-open style={{ width: 256 }}>
        <div className="nt-rail-face" data-on style={{ width: 256 }}>
          {children}
        </div>
      </div>
      <div className="nt-well relative isolate flex min-w-0 flex-1" />
    </div>
  );
}

const THREADS = [
  { _id: "thread_1" as Id<"chatThreads">, title: "Plan the launch", updatedAt: Date.now() },
  { _id: "thread_2" as Id<"chatThreads">, title: "Draft the brief", updatedAt: Date.now() },
];

function ChatDrawer() {
  const [picking, setPicking] = useState(false);
  const note = (what: string) => globalThis.drawerHarness.picked.push(what);
  const layer = drawerLayer("right");
  // Nested as `Workspace` nests the one ChatPanel when narrow: the right rail's
  // slot, a `contents` face, and the panel wearing the drawer's layer.
  return (
    <div className="nt-shell flex h-screen w-full overflow-hidden">
      <div className="nt-well relative isolate flex min-w-0 flex-1" />
      <div className="nt-rail-slot is-right">
        <div className="contents">
    <aside id="chat-drawer" className={`nt-panel ${layer.className}`} style={{ ...layer.style, width: 288 }}>
      <div className="nt-panel-head">
        <button id="threads" className="nt-icon-btn" onClick={() => setPicking(true)}>
          Chats
        </button>
      </div>
      {picking && (
        <ThreadPicker
          threads={THREADS}
          activeId={null}
          onPick={(id) => note(`thread:${id}`)}
          onClose={() => setPicking(false)}
        />
      )}
      <div style={{ padding: 16 }}>
        {/* The transcript's Rewind, which is this `Menu`. */}
        <Menu
          side="bottom"
          label="Rewind to before this message"
          trigger={(props) => (
            <button {...props} id="rewind" className="nt-rewind">
              Rewind
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem onClick={() => { note("rewind:both"); close(); }}>Notes and conversation</MenuItem>
              <MenuItem onClick={() => { note("rewind:conversation"); close(); }}>Conversation only</MenuItem>
            </>
          )}
        </Menu>
      </div>
    </aside>
        </div>
      </div>
      <DrawerScrim label="Close panel" onClose={() => note("scrim")} />
    </div>
  );
}

/** The storyboard's full-size shot: the real view, its real canvas and bar. */
function FullShot() {
  const [ratio, setRatio] = useState<BoardApi["ratio"]>("16:9");
  const board: BoardApi = {
    ratio,
    shots: 3,
    setRatio: (next) => {
      globalThis.drawerHarness.ratio = next;
      setRatio(next);
    },
    addShot: () => {},
    cols: 3,
    most: 3,
    pinned: false,
    pin: () => {},
    unpin: () => {},
  };
  return (
    <FullscreenShot
      scene=""
      frameH={shotHeight(ratio)}
      board={board}
      onScene={() => {}}
      onClaim={() => {}}
      onClose={() => globalThis.drawerHarness.picked.push("shot:closed")}
    />
  );
}

function Fixture({ mode }: { mode: Mode }) {
  const split = useRef<HTMLElement | null>(null);
  const sidebar = (
    <Sidebar
      width={mode === "drawer" ? "288px" : "100%"}
      projectId={PROJECT}
      selectedPageId={"page_1" as Id<"pages">}
      otherPageId={null}
      splitZone={split}
      onOpenAside={() => {}}
      onSelectPage={(id) => globalThis.drawerHarness.selected.push(id)}
      onCollapse={() => {}}
      onFind={() => {}}
      onShowKeys={() => {
        globalThis.drawerHarness.keysShown++;
      }}
    />
  );
  if (mode === "rail") return <Rail>{sidebar}</Rail>;
  return (
    <div className="nt-shell flex h-screen w-full overflow-hidden">
      <div className="nt-well relative isolate flex min-w-0 flex-1" />
      <LeftDrawer label="Close panel" onClose={() => globalThis.drawerHarness.picked.push("scrim")}>
        {sidebar}
      </LeftDrawer>
    </div>
  );
}

let root: ReturnType<typeof createRoot> | null = null;
globalThis.drawerHarness = {
  backend: createBackend(),
  picked: [],
  selected: [],
  ratio: null,
  keysShown: 0,
  mount(mode) {
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    root.render(
      <OpenPageProvider>
        <EditorRegistryProvider>
          <ReviewProvider projectId={PROJECT}>
            <Fixture mode={mode} />
          </ReviewProvider>
        </EditorRegistryProvider>
      </OpenPageProvider>,
    );
  },
};

/** The other two rooms are mounted on their own, one per scenario. */
Object.assign(globalThis.drawerHarness, {
  mountChat() {
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    root.render(<ChatDrawer />);
  },
  mountShot() {
    root?.unmount();
    root = createRoot(document.getElementById("app")!);
    root.render(<FullShot />);
  },
});
