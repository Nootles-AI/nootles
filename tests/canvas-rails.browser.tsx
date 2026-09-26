import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { getFunctionName } from "convex/server";
import { ConvexProviderWithAuth, type ConvexReactClient } from "convex/react";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { schema } from "../app/components/editor/schema";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider } from "../app/components/comments/registry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";

/**
 * The REAL workspace, with one page holding one diagram, over an in-memory
 * stand-in Convex — for the shell's rails as a diagram takes them
 * (tests/canvas-rails.browser.mjs). Nothing is swapped but the transport and
 * the modules the comment harnesses swap (`comments-surfaces.shared.mjs`).
 */

const PROJECT = "project_1" as Id<"projects">;
const PAGE = "page_1" as Id<"pages">;
const PAGE_DOC = "page-doc-1";
const OWNER = { userId: "user_owner", name: "Olive Owner", imageUrl: null };

const DIAGRAM =
  '<nt-diagram h="220"><nt-rect id="r1" x="60" y="40" w="120" h="70" style="background: #f4c7c3"></nt-rect></nt-diagram>';

function pageBirth(): Uint8Array {
  const editor = BlockNoteEditor.create({ schema });
  const doc = blocksToYDoc(editor, [
    { id: "p_intro", type: "paragraph", content: "A diagram on the page." },
    { id: "diagram", type: "canvas", props: { data: DIAGRAM } },
    { id: "p_after", type: "paragraph", content: "And text after it." },
  ] as never);
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

class Backend {
  private log: ArrayBuffer[];
  private watchers = new Map<string, Set<() => void>>();

  constructor() {
    const birth = pageBirth();
    this.log = [birth.buffer.slice(birth.byteOffset, birth.byteOffset + birth.byteLength) as ArrayBuffer];
  }

  private notify(key: string) {
    for (const watcher of [...(this.watchers.get(key) ?? [])]) watcher();
  }

  private row(): Doc<"pages"> {
    return {
      _id: PAGE,
      _creationTime: 1,
      projectId: PROJECT,
      title: "Diagrams",
      order: 0,
      docId: PAGE_DOC,
      yjs: true,
    } as Doc<"pages">;
  }

  read(name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case "projects:myRole":
        return "owner";
      case "pages:listByProject":
        return [this.row()];
      case "pages:get":
        return this.row();
      case "comments:docFor":
        return null;
      case "commentNotices:mentionable":
      case "commentNotices:authors":
      case "commentNotices:inbox":
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
        if (args.docId !== PAGE_DOC) throw new Error("Not found");
        const seq = this.log.length;
        const after = (args.afterSeq as number | undefined) ?? 0;
        const updates = this.log.map((update, i) => ({ seq: i + 1, update })).filter((row) => row.seq > after);
        if (name === "ydoc:meta") return { seq, snapshotSeq: 0, snapshotParts: 0 };
        if (name === "ydoc:snapshot") return null;
        if (name === "ydoc:updatesSince") return updates;
        return { seq, snapshotSeq: 0, snapshotParts: 0, snapshot: null, updates };
      }
    }
    return undefined;
  }

  async mutate(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name !== "ydoc:append" || args.docId !== PAGE_DOC) return null;
    const chunks = (args.chunks as ArrayBuffer[] | undefined) ?? [args.update as ArrayBuffer];
    this.log.push(...chunks);
    this.notify(`ydoc:meta|${PAGE_DOC}`);
    return this.log.length;
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
      setAuth(_fetch: unknown, onChange?: (authenticated: boolean) => void) {
        onChange?.(true);
      },
      clearAuth() {},
      connectionState: () => ({ isWebSocketConnected: false, hasInflightRequests: false }),
    } as unknown as ConvexReactClient;
  }
}

const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => "stand-in" };
const useAuth = () => auth;

const band = () => document.querySelector<HTMLElement>(".nt-canvas:not(.nt-canvas-shot)");
const rect = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};
const visible = (el: Element | null) => !!el && getComputedStyle(el).visibility === "visible";

const rails = {
  identity: OWNER,
  signIns: [] as string[],
  mount() {
    createRoot(document.getElementById("app")!).render(
      <ConvexProviderWithAuth client={new Backend().client()} useAuth={useAuth}>
        <EditorRegistryProvider>
          <PageCommentsRegistryProvider>
            <OpenPageProvider>
              <ReviewProvider projectId={PROJECT}>
                <Workspace projectId={PROJECT} />
              </ReviewProvider>
            </OpenPageProvider>
          </PageCommentsRegistryProvider>
        </EditorRegistryProvider>
      </ConvexProviderWithAuth>,
    );
  },
  ready: () => !!band()?.querySelector('.nt-canvas-scene [data-id="r1"]'),
  band: () => rect(band()),
  shape: () => rect(band()?.querySelector('.nt-canvas-scene [data-id="r1"]') ?? null),
  /** The document column: its width is what a rail coming out would take. */
  column: () => rect(document.querySelector(".nt-well")),
  /** Whether the band shows its edge and grid, as a chosen diagram does. */
  holding: () => band()?.hasAttribute("data-holding") ?? false,
  /** What each side shows: which faces are on in the rail, and which panels float. */
  sides: () => {
    const [left, right] = document.querySelectorAll<HTMLElement>(".nt-rail-slot");
    const onFace = (slot: HTMLElement | undefined) =>
      [...(slot?.querySelectorAll<HTMLElement>(":scope > .nt-rail-face[data-on='true']") ?? [])].map(
        (face) => face.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "?",
      );
    const float = (selector: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      return el?.dataset.on === "true" ? (el.querySelector("[aria-label]")?.getAttribute("aria-label") ?? "?") : null;
    };
    return {
      leftOpen: left?.dataset.open === "true",
      rightOpen: right?.dataset.open === "true",
      left: onFace(left),
      right: onFace(right),
      floatLeft: float(".nt-rail-float:not(.is-right)"),
      floatRight: float(".nt-rail-float.is-right"),
    };
  },
  /** The floating panel on a side, as it stands on screen once it has settled. */
  float: (side: "left" | "right") => {
    const el = document.querySelector(side === "left" ? ".nt-rail-float:not(.is-right)" : ".nt-rail-float.is-right");
    return el ? { ...rect(el)!, visible: visible(el) } : null;
  },
  /** The Design panel's own head and its sections' titles. */
  design: () => {
    const panel = [...document.querySelectorAll<HTMLElement>(".nt-style-panel")].find((el) =>
      visible(el.closest(".nt-rail-face, .nt-rail-float")),
    );
    if (!panel) return null;
    return {
      head: panel.querySelector(".nt-style-panel-head > span")?.textContent ?? null,
      sections: [...panel.querySelectorAll(".nt-ctl-section .nt-ctl-title")].map((el) => el.textContent),
      background: rect(panel.querySelector('button[aria-label="Background"]')),
    };
  },
  /** The band's painted background. */
  paint: () => {
    const viewport = band()?.querySelector<HTMLElement>(".nt-canvas-viewport");
    return viewport ? getComputedStyle(viewport).backgroundColor : null;
  },
};

declare global {
  interface Window {
    rails: typeof rails;
  }
}

window.rails = rails;
// The Clerk fixture (comments-surfaces.shared.mjs) reads who is signed in here.
(window as unknown as { surfaces: typeof rails }).surfaces = rails;
rails.mount();
