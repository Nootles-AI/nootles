import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { BlockNoteView } from "@blocknote/mantine";
import { schema } from "../app/components/editor/schema";
import { useYjsEditor } from "../app/lib/sync/useYjsEditor";
import { peekProvider } from "../app/lib/sync/YConvexProvider";
import { Facepile } from "../app/components/presence/Facepile";
import "@blocknote/mantine/style.css";
import "../app/components/editor/editor.css";

/**
 * One person's tab on one page, composed as the app composes it: a real
 * `ConvexReactClient` signed in against the throwaway backend, the real
 * `useYjsEditor` (provider from `acquireProvider`, BlockNote, the caret layer)
 * and the real `Facepile`. The address says who and where:
 * `?url&site&jwt&doc&user&name&color`.
 *
 * The build names the deployment's HTTP site as `NEXT_PUBLIC_CONVEX_SITE_URL`,
 * which is where the unload beacon goes; here the address does, through the
 * same variable.
 */
const q = new URLSearchParams(location.search);
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
env.NEXT_PUBLIC_CONVEX_SITE_URL = q.get("site") ?? undefined;

const docId = q.get("doc")!;
const person = { userId: q.get("user")!, name: q.get("name")!, color: q.get("color")! };
(window as unknown as { surfaces: unknown }).surfaces = { identity: person, signIns: [] };

const client = new ConvexReactClient(q.get("url")!);
client.setAuth(async () => q.get("jwt"));

function Pane() {
  const { editor } = useYjsEditor<typeof schema.BlockNoteEditor>({
    docId,
    user: { name: person.name, color: person.color },
    editorOptions: { schema },
  });
  return (
    <div style={{ padding: 24 }}>
      <Facepile docId={docId} />
      {editor && (
        <BlockNoteView editor={editor} theme="light" className="nt-editor" sideMenu={false} slashMenu={false} formattingToolbar={false} />
      )}
    </div>
  );
}

const root = createRoot(document.getElementById("app")!);
let mounted = true;
root.render(
  <ConvexProvider client={client}>
    <Pane />
  </ConvexProvider>,
);

const provider = () => peekProvider(docId);

declare global {
  interface Window {
    presenceTab: {
      ready: () => boolean;
      self: () => { clientId: number; sessionId: string } | null;
      /** Whom this tab's awareness holds besides itself — the carets' and the canvas ghosts' source. */
      remote: () => Array<{ clientId: number; name: string | null }>;
      /** The carets drawn on this screen. */
      carets: () => Array<string | null>;
      /** The faces in this tab's pile. */
      pile: () => Array<string | null>;
      /** Leaves the page in-app: the editor unmounts, the provider disconnects. */
      unmount: () => Promise<void>;
      session: () => Record<string, string>;
    };
  }
}

window.presenceTab = {
  ready: () => mounted && !!provider()?.synced && !!document.querySelector(".bn-editor .bn-block-content"),
  self: () => {
    const p = provider();
    return p ? { clientId: p.doc.clientID, sessionId: p.sessionId } : null;
  },
  remote: () => {
    const p = provider();
    if (!p) return [];
    return [...p.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== p.doc.clientID)
      .map(([clientId, state]) => ({ clientId, name: (state as { user?: { name?: string } }).user?.name ?? null }));
  },
  carets: () =>
    [...document.querySelectorAll(".nt-remote-caret")].map((caret) => caret.querySelector(".nt-remote-caret-name")?.textContent ?? null),
  pile: () => [...document.querySelectorAll(".nt-facepile .nt-face")].map((face) => face.getAttribute("aria-label")),
  unmount: async () => {
    mounted = false;
    root.unmount();
    // `releaseProvider` tears down on the tick after the last release.
    await new Promise((resolve) => setTimeout(resolve, 50));
  },
  session: () => Object.fromEntries(Object.entries(sessionStorage)),
};
