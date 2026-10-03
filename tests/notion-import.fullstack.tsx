import { createRoot } from "react-dom/client";
import { usePathname } from "next/navigation";
import { getFunctionName } from "convex/server";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { EditorRegistryProvider } from "../app/components/editor/EditorRegistry";
import { PageCommentsRegistryProvider } from "../app/components/comments/registry";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { ReviewProvider } from "../app/components/ReviewContext";
import { Workspace } from "../app/components/Workspace";
import { runImport, type ImportProgress } from "../app/lib/notion/importRun";
import type { NotionBlock } from "../app/lib/notion/types";

/**
 * The in-browser half of notion-import.fullstack.mjs: the workspace as its
 * route mounts it, against a throwaway convex-local-backend, plus the REAL
 * Notion import run (`runImport`) on this tab's client.
 *
 * Only Notion is stood in: `notion/pages:fetchBlocks` is held until the runner
 * answers it, which is how reading a large page takes minutes while its empty
 * page already sits in the sidebar. Every other call — the project, the pages,
 * the document's first write — goes to the real backend.
 */

type Boot = { url: string; jwt: string; identity: { userId: string; name: string } };

declare global {
  interface Window {
    __e2e: Boot;
    e2e: typeof harness;
  }
}

const boot = window.__e2e;
const client = new ConvexReactClient(boot.url, { skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false });
const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => boot.jwt };
const useAuth = () => auth;

/** Notion's answers, held per page until the runner gives them. */
const held = new Map<string, (blocks: NotionBlock[]) => void>();
const asked = new Set<string>();
const importer = Object.create(client) as ConvexReactClient;
importer.action = ((reference: never, args: { pageId: string }) => {
  const name = getFunctionName(reference);
  if (name === "notion/pages:fetchBlocks") {
    asked.add(args.pageId);
    return new Promise<NotionBlock[]>((resolve) => held.set(args.pageId, resolve));
  }
  if (name.startsWith("notion/")) throw new Error(`Notion stand-in has no ${name}`);
  return client.action(reference, args as never);
}) as ConvexReactClient["action"];

const paragraph = (id: string, words: string) =>
  ({
    id,
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          plain_text: words,
          text: { content: words },
          annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
        },
      ],
    },
  }) as NotionBlock;

let progress: ImportProgress | null = null;
let finished = false;

const harness = {
  /** Start an import of `pages` (Notion id → title) into a new project; resolves once it is under way. */
  start(title: string, pages: [string, string][]) {
    progress = null;
    finished = false;
    void runImport({
      client: importer,
      roots: pages.map(([id, pageTitle]) => ({ id, title: pageTitle, children: [] })),
      selection: new Set(pages.map(([id]) => id)),
      newProjectTitle: title,
      onProgress: (step) => (progress = step),
    }).then((last) => {
      progress = last;
      finished = true;
    });
  },
  progress: () => (progress ? { ...progress, finished } : null),
  /** Whether the run is reading this Notion page now. */
  reading: (notionId: string) => asked.has(notionId) && held.has(notionId),
  /** Notion answers: the page is one paragraph of `words`. */
  answer(notionId: string, words: string) {
    const resolve = held.get(notionId);
    if (!resolve) throw new Error(`nobody is reading ${notionId}`);
    held.delete(notionId);
    resolve([paragraph(`${notionId}-p`, words)]);
  },
};

function Shell() {
  const pathname = usePathname();
  const project = /^\/p\/([^/]+)/.exec(pathname)?.[1];
  if (!project) return null;
  const projectId = decodeURIComponent(project) as Id<"projects">;
  return (
    <EditorRegistryProvider key={projectId}>
      <PageCommentsRegistryProvider>
        <OpenPageProvider>
          <ReviewProvider projectId={projectId}>
            <Workspace projectId={projectId} />
          </ReviewProvider>
        </OpenPageProvider>
      </PageCommentsRegistryProvider>
    </EditorRegistryProvider>
  );
}

window.e2e = harness;
// What the swapped-in Clerk reads.
(window as unknown as { surfaces: { identity: Boot["identity"]; signIns: string[] } }).surfaces = { identity: boot.identity, signIns: [] };
createRoot(document.getElementById("app")!).render(
  <ConvexProviderWithAuth client={client} useAuth={useAuth}>
    <Shell />
  </ConvexProviderWithAuth>,
);
