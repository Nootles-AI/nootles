/**
 * Step 13 assembled-mount e2e — the REAL `Editor` component, in a real browser,
 * routing through the `nmlAuthority` branch into `NmlServedEditor` for a served
 * cohort document, against a throwaway local Convex backend. Proves the whole
 * production glue actually runs: legacy mount → `useNmlMigration` auto-elects →
 * server verifies → `Editor` remounts onto the NML editor → edits commit NML
 * commands (legacy `prosemirror` root untouched) → undo through the spine.
 *
 * Driven by `nml-serve.browser.mjs`, which boots the backend, seeds a cohort
 * doc, and injects the config through `process.env.NML_E2E`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import * as Y from "yjs";
import { Editor } from "@/app/components/editor/Editor";
import { PagesProvider } from "@/app/components/PagesContext";
import { WorkspaceHistoryProvider } from "@/app/lib/history/useWorkspaceHistory";
import { EditorRegistryProvider } from "@/app/components/editor/EditorRegistry";
import { OpenPageProvider, CurrentPageProvider } from "@/app/components/OpenPageContext";
import { ReviewProvider } from "@/app/components/ReviewContext";
import { CompletionContextProvider } from "@/app/components/editor/ai/CompletionContext";
import { NotionConfigProvider } from "@/app/components/notion/NotionAvailable";
import { peekProvider } from "@/app/lib/sync/YConvexProvider";
import { decodeNmlDocument, NML_YJS_ROOT } from "@/app/lib/nml/yjs";
import type { Id } from "@/convex/_generated/dataModel";
import type { NmlDocument } from "@/app/lib/nml/schema";

type Config = { url: string; jwt: string; docId: string; pageId: string; projectId: string };
const cfg = JSON.parse(process.env.NML_E2E as string) as Config;

const client = new ConvexReactClient(cfg.url);
client.setAuth(async () => cfg.jwt);

function blockText(blocks: NmlDocument["blocks"]): string {
  return blocks
    .map((b) => ("content" in b ? b.content.map((n) => (n.type === "text" ? n.text : "")).join("") : ""))
    .join("\n");
}

const harness = {
  /** True once the served NML editor's view has mounted. */
  servedMounted: () => !!document.querySelector("#app .nt-nml-view"),
  nmlPresent: () => {
    const provider = peekProvider(cfg.docId);
    return provider ? provider.doc.getMap(NML_YJS_ROOT).size > 0 : false;
  },
  nmlText: () => {
    const provider = peekProvider(cfg.docId);
    if (!provider) return null;
    try {
      return blockText(decodeNmlDocument(provider.doc).blocks);
    } catch {
      return null;
    }
  },
  proseMirror: () => {
    const provider = peekProvider(cfg.docId);
    return provider ? provider.doc.getXmlFragment("prosemirror").toString() : null;
  },
  /** Put the caret at the end of the first NML text block for typing. */
  focusFirstBlock: () => {
    const el = document.querySelector<HTMLElement>("#app .nt-nml-view [data-nml-id]");
    if (!el) return false;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    return true;
  },
};

declare global {
  interface Window {
    __serve: typeof harness;
    __Y: typeof Y;
  }
}
window.__serve = harness;
window.__Y = Y;

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <ConvexProvider client={client}>
      <NotionConfigProvider oauth={false}>
        <EditorRegistryProvider>
          <OpenPageProvider>
            <ReviewProvider projectId={cfg.projectId as Id<"projects">}>
              <WorkspaceHistoryProvider projectId={cfg.projectId}>
                <PagesProvider pages={[]}>
                  <CompletionContextProvider projectId={cfg.projectId as Id<"projects">}>
                    <CurrentPageProvider pageId={cfg.pageId as Id<"pages">}>
                      <div id="editor-host">
                        <Editor docId={cfg.docId} pageId={cfg.pageId as Id<"pages">} />
                      </div>
                    </CurrentPageProvider>
                  </CompletionContextProvider>
                </PagesProvider>
              </WorkspaceHistoryProvider>
            </ReviewProvider>
          </OpenPageProvider>
        </EditorRegistryProvider>
      </NotionConfigProvider>
    </ConvexProvider>
  </StrictMode>,
);
