import { createRoot } from "react-dom/client";
import { ProjectsScreen } from "../app/components/ProjectsScreen";
import { NotionConfigProvider } from "../app/components/notion/NotionAvailable";

/**
 * NT-79: the header's New project control must take the pointer only where it
 * is drawn.
 *
 * The real `ProjectsScreen`, with four projects of the owner's, in whichever
 * view the scenario leaves in this browser's storage. `convex/react`,
 * `@clerk/nextjs`, `next/navigation` and `next/link` are swapped at bundle
 * time (see the runner) for an in-memory stand-in that records where the
 * screen tried to go.
 */

type View = "grid" | "list" | "board";
type Call = { kind: "query" | "mutation"; name: string; args: unknown };

declare global {
  var projectsHarness: {
    backend: ReturnType<typeof createBackend>;
    /** Every route the screen pushed or a link opened, in order. */
    went: string[];
    mount(options: { view: View; notion: boolean }): void;
  };
}

const NOW = Date.now();
const project = (i: number, title: string, description = "") => ({
  _id: `project_${i}`,
  _creationTime: NOW,
  title,
  description,
  pageCount: 3 + i,
  updatedAt: NOW - i * 3_600_000,
  firstPageDocId: null,
});
const PROJECTS = [
  project(0, "Launch plan", "Everything we need to ship the beta: the checklist, the copy, and the open questions."),
  project(1, "Recipes"),
  project(2, "Reading notes"),
  project(3, "Trip"),
];

function createBackend(notion: boolean) {
  const calls: Call[] = [];
  const unknown = new Set<string>();
  const answer = (name: string): unknown => {
    switch (name) {
      case "projects:listForScreen":
        return PROJECTS;
      case "projects:sharedWithMe":
      case "share:incomingRequests":
      case "share:grantedForMe":
      case "feedback:resolvedForMe":
      case "commentNotices:inbox":
        return [];
      case "notion/account:status":
        return { ready: notion };
      case "entitlements:mine":
        return { left: null };
      case "impersonation:current":
        return null;
      case "profiles:get":
        return { hintsSeen: [] };
      case "ai/suggestions:hasAccepted":
        return false;
      case "surveys:seen":
        return true;
    }
    unknown.add(name);
    return undefined;
  };
  return {
    calls,
    unknown,
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

let root: ReturnType<typeof createRoot> | null = null;
globalThis.projectsHarness = {
  backend: createBackend(false),
  went: [],
  mount({ view, notion }) {
    root?.unmount();
    globalThis.projectsHarness.backend = createBackend(notion);
    globalThis.projectsHarness.went = [];
    localStorage.setItem("nt:projectsView", view);
    root = createRoot(document.getElementById("app")!);
    root.render(
      <NotionConfigProvider oauth={notion}>
        <ProjectsScreen />
      </NotionConfigProvider>,
    );
  },
};
