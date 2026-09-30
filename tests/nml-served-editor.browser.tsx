/**
 * Phase 2 assembled-mount e2e — the in-browser half.
 *
 * Mounts the REAL `Editor` component (the production serve dispatcher) against a
 * throwaway local Convex backend, signed in as an internal-owner subject whose
 * documents are eligible through the `internalOwners` allowlist. The launcher
 * (`nml-served-editor.browser.mjs`) enrols the owner, seeds a legacy page, and
 * boots the backend + fake issuer; here we prove the component assembly:
 *
 *  1. `<Editor>` mounts the legacy BlockNote editor for a not-yet-migrated doc;
 *  2. `useNmlMigration` converts it, the backend verifies the root on its own,
 *     and `nmlAuthority.serve` remounts the full surface with NML authority;
 *  3. an edit typed into the served BlockNote compatibility view lands on the
 *     canonical NML root.
 *
 * No paid API is ever touched (the launcher blocks the lanes, and the served
 * launcher intercepts every paid lane).
 */
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { Editor } from "../app/components/editor/Editor";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { readYDocUpdates } from "../app/lib/sync/ydocRead";
import { decodeNmlDocument } from "../app/lib/nml/yjs";
import * as Y from "yjs";
import type { Id } from "../convex/_generated/dataModel";
import "@blocknote/mantine/style.css";

type Config = { url: string; jwt: string; docId: string; pageId: string; projectId: string };

let client: ConvexReactClient | undefined;
let root: Root | undefined;
let currentDocId = "";

/** Which editor is currently mounted, plus its visible text. */
function probe() {
  const host = document.getElementById("editor-host");
  // Served documents intentionally keep the complete BlockNote surface; the
  // wrapper marker distinguishes its NML-authoritative compatibility view.
  const servedSurface = host?.querySelector('[data-nml-served="true"]') ?? null;
  const blockNote = host?.querySelector(".bn-editor") ?? null;
  const text = (blockNote?.textContent ?? host?.textContent ?? "").trim();
  return {
    served: !!servedSurface && !!blockNote,
    legacy: !!blockNote && !servedSurface,
    text,
    detail: {
      servedSurfaces: host?.querySelectorAll('[data-nml-served="true"]').length ?? 0,
      bnEditors: host?.querySelectorAll(".bn-editor").length ?? 0,
    },
  };
}

function mount(cfg: Config) {
  currentDocId = cfg.docId;
  client = new ConvexReactClient(cfg.url, { skipConvexDeploymentUrlCheck: true });
  // Real auth over the wire, exactly as the app's ConvexProviderWithClerk would,
  // but fed the launcher's signed internal-owner token directly.
  client.setAuth(async () => cfg.jwt);
  root = createRoot(document.getElementById("app")!);
  root.render(
    <StrictMode>
      <ConvexProvider client={client}>
        <EditorRegistryProvider>
          <OpenPageProvider>
            <ReviewProvider projectId={cfg.projectId as Id<"projects">}>
              <div id="editor-host" className="nt-editor-host">
                <Editor docId={cfg.docId} pageId={cfg.pageId as Id<"pages">} title="E2E" />
              </div>
            </ReviewProvider>
          </OpenPageProvider>
        </EditorRegistryProvider>
      </ConvexProvider>
    </StrictMode>,
  );
}

const harness = {
  mount,
  probe,
  /** Focus the served compatibility view so puppeteer keystrokes land in it. */
  focusServed() {
    const view = document.querySelector<HTMLElement>(
      '#editor-host [data-nml-served="true"] .bn-editor',
    );
    if (!view) return false;
    view.focus();
    return document.activeElement === view || view.contains(document.activeElement);
  },
  /**
   * The document's canonical NML text as PERSISTED on the backend — a fresh read
   * of the stored Yjs updates decoded through the NML root, independent of the
   * mounted editor. Proves an edit reached the canonical tree, not just the DOM.
   */
  async persistedNmlText() {
    if (!client) return "";
    const updates = await readYDocUpdates(client, currentDocId);
    const doc = new Y.Doc();
    for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
    const nml = decodeNmlDocument(doc);
    const text = nml.blocks
      .map((b) => ("content" in b ? b.content.map((n) => (n.type === "text" ? n.text : "")).join("") : ""))
      .join("\n");
    doc.destroy();
    return text;
  },
  /** The persisted canonical blocks, as `type` and plain text (NT-125). */
  async persistedNmlBlocks() {
    if (!client) return [];
    const updates = await readYDocUpdates(client, currentDocId);
    const doc = new Y.Doc();
    for (const u of updates) Y.applyUpdate(doc, new Uint8Array(u));
    const blocks = decodeNmlDocument(doc).blocks.map((b) => ({
      type: b.type,
      text: "content" in b ? b.content.map((n) => (n.type === "text" ? n.text : "")).join("") : "",
    }));
    doc.destroy();
    return blocks;
  },
  /** The block types the served surface shows, top to bottom. */
  blockTypes() {
    // A React node view (the math block) wraps its content in a renderer.
    return [...document.querySelectorAll<HTMLElement>(
      '#editor-host [data-nml-served="true"] .bn-block-outer > .bn-block',
    )].map((block) => block.querySelector<HTMLElement>(
      ":scope > .bn-block-content, :scope > .react-renderer > .bn-block-content",
    )?.dataset.contentType ?? "");
  },
  /** Put the caret after the last glyph of the paragraph reading `text`. */
  caretAtEnd(text: string) {
    const line = [...document.querySelectorAll<HTMLElement>(
      '#editor-host [data-nml-served="true"] .bn-inline-content',
    )].find((el) => el.textContent === text);
    const view = document.querySelector<HTMLElement>('#editor-host [data-nml-served="true"] .bn-editor');
    if (!line || !view) return false;
    view.focus();
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    while (walker.nextNode()) last = walker.currentNode as Text;
    if (!last) return false;
    document.getSelection()?.collapse(last, last.length);
    return true;
  },
  /** Whether the "change couldn't be saved" notice is up. */
  revertNotice() {
    return !!document.querySelector(".nt-update[role=alert]");
  },
  destroy() {
    root?.unmount();
    void client?.close();
  },
};

declare global {
  interface Window {
    nmlServed: typeof harness;
  }
}
window.nmlServed = harness;
document.getElementById("app")?.setAttribute("data-ready", "true");
