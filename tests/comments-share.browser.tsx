import { createRoot, type Root } from "react-dom/client";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { claimRole } from "../convex/roles";
import { SharePopover } from "../app/components/SharePopover";
import { SharedProject } from "../app/components/share/SharedProject";
import { OpenPageProvider } from "../app/components/OpenPageContext";

/**
 * The share surface for the commenter role, over an in-memory Convex stand-in.
 *
 * `convex/react`, `@clerk/nextjs` and `next/navigation` are swapped at bundle
 * time (see the runner) for modules that read `window.shareHarness`, so the
 * real `SharePopover` and `SharedProject` render and are driven by real
 * clicks. The stand-in answers the share functions by name. Who has access is
 * computed with the real `claimRole`, so turning a link off in the popover
 * demotes people in its list exactly as the server would.
 */

type LinkRole = "viewer" | "commenter" | "editor";
type Call = { kind: "query" | "mutation"; name: string; args: Record<string, unknown> };

const PROJECT = "project_1" as Id<"projects">;
const PAGE = "page_1" as Id<"pages">;
const PAGE_DOC = "page-doc-1";
const OWNER = "user_owner";

const FIELD = { viewer: "shareToken", commenter: "commentShareToken", editor: "editShareToken" } as const;

function createBackend() {
  const project: Doc<"projects"> = {
    _id: PROJECT,
    _creationTime: 1,
    ownerId: OWNER,
    title: "Launch plan",
    createdAt: 1,
  };
  let claims: Doc<"shareClaims">[] = [];
  const profiles = new Map<string, { name: string; email: string }>();
  const calls: Call[] = [];
  const listeners = new Set<() => void>();
  let version = 0;
  let minted = 0;
  const changed = () => {
    version++;
    for (const listener of listeners) listener();
  };

  const answer = (name: string, args: Record<string, unknown>): unknown => {
    switch (name) {
      case "share:links":
        return {
          viewer: project.shareToken ?? null,
          commenter: project.commentShareToken ?? null,
          editor: project.editShareToken ?? null,
        };
      case "share:collaborators":
        return claims
          .map((claim) => {
            const role = claimRole(project, claim);
            const profile = profiles.get(claim.granteeId);
            return role && {
              granteeId: claim.granteeId,
              role,
              name: profile?.name ?? null,
              email: profile?.email ?? null,
              imageUrl: null,
            };
          })
          .filter(Boolean);
      case "share:incomingRequests":
        return [];
      case "share:view": {
        const token = args.token as string;
        const role = (Object.keys(FIELD) as LinkRole[]).find((r) => token && project[FIELD[r]] === token);
        if (!role) return null;
        return {
          projectId: PROJECT,
          role,
          title: project.title,
          pages: [{ _id: PAGE, title: "Plan", docId: PAGE_DOC, folderId: undefined, order: 0 }],
          folders: [],
        };
      }
      case "presence:list":
        return [];
    }
    throw new Error(`unexpected query ${name}`);
  };

  const cache = new Map<string, { version: number; value: unknown }>();
  return {
    calls,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    read(name: string, args: Record<string, unknown>) {
      const key = `${name}:${JSON.stringify(args)}`;
      const hit = cache.get(key);
      if (hit && hit.version === version) return hit.value;
      calls.push({ kind: "query", name, args });
      const value = answer(name, args);
      cache.set(key, { version, value });
      return value;
    },
    async mutate(name: string, args: Record<string, unknown>) {
      calls.push({ kind: "mutation", name, args });
      // A round trip's worth of latency, so the UI is seen waiting on the server.
      await new Promise((resolve) => setTimeout(resolve, 25));
      switch (name) {
        case "share:setLink": {
          const field = FIELD[args.role as LinkRole];
          if (!args.enabled) {
            project[field] = undefined;
            changed();
            return null;
          }
          project[field] ??= `tok-${args.role}-${++minted}`;
          changed();
          return project[field];
        }
        case "share:claim":
        case "share:requestEdit":
          return PROJECT;
      }
      throw new Error(`unexpected mutation ${name}`);
    },
    seedClaim(granteeId: string, role: LinkRole, name: string) {
      claims = [...claims, { _id: `claim_${granteeId}` as Id<"shareClaims">, _creationTime: 1, projectId: PROJECT, granteeId, role, createdAt: 1 }];
      profiles.set(granteeId, { name, email: `${name.toLowerCase()}@example.test` });
      changed();
    },
    setLinks(links: Partial<Record<LinkRole, string>>) {
      for (const role of Object.keys(FIELD) as LinkRole[]) project[FIELD[role]] = links[role];
      changed();
    },
  };
}

type Backend = ReturnType<typeof createBackend>;
type Auth = { isLoaded: boolean; isSignedIn: boolean };

declare global {
  interface Window {
    shareHarness: {
      backend: Backend;
      auth: Auth;
      replaced: string[];
      mountPopover(): void;
      mountShare(token: string, auth: Auth): void;
      seedClaim: Backend["seedClaim"];
      setLinks: Backend["setLinks"];
      calls(): Call[];
    };
  }
}

let root: Root | undefined;
function mount(node: React.ReactNode) {
  root?.unmount();
  const host = document.getElementById("app")!;
  root = createRoot(host);
  root.render(node);
}

const harness: Window["shareHarness"] = {
  backend: createBackend(),
  auth: { isLoaded: true, isSignedIn: true },
  replaced: [],
  mountPopover() {
    harness.auth = { isLoaded: true, isSignedIn: true };
    mount(
      <div style={{ padding: 24 }}>
        <SharePopover projectId={PROJECT} />
      </div>,
    );
  },
  mountShare(token, auth) {
    harness.auth = auth;
    harness.replaced = [];
    mount(
      <OpenPageProvider>
        <SharedProject token={token} />
      </OpenPageProvider>,
    );
  },
  seedClaim: (...args) => harness.backend.seedClaim(...args),
  setLinks: (links) => harness.backend.setLinks(links),
  calls: () => harness.backend.calls,
};
window.shareHarness = harness;
