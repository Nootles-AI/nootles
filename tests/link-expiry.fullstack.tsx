import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import type { Id } from "../convex/_generated/dataModel";
import { ProjectStack } from "../app/components/ProjectStack";
import { peekProvider } from "../app/lib/sync/YConvexProvider";

/**
 * The in-browser half of link-expiry.fullstack.mjs: one person's real project
 * — `ProjectStack`, the stack `/p/<id>` renders — against a throwaway
 * convex-local-backend, signed in with a token from the runner's own issuer.
 */

type Config = { url: string; jwt: string; identity: { userId: string; name: string }; projectId: string };

const harness = {
  mount(cfg: Config) {
    // Whom the Clerk fixture answers for (tests/comments-surfaces.shared.mjs).
    Object.assign(window, { surfaces: { identity: cfg.identity, signIns: [] } });
    const client = new ConvexReactClient(cfg.url, { skipConvexDeploymentUrlCheck: true });
    client.setAuth(async () => cfg.jwt);
    const auth = { isLoading: false, isAuthenticated: true, fetchAccessToken: async () => cfg.jwt };
    createRoot(document.getElementById("app")!).render(
      <ConvexProviderWithAuth client={client} useAuth={() => auth}>
        <ProjectStack projectId={cfg.projectId as Id<"projects">} />
      </ConvexProviderWithAuth>,
    );
  },

  /** What the page's provider holds, as `beforeunload` and the notice read it. */
  held(docId: string) {
    const provider = peekProvider(docId);
    if (!provider) return null;
    return { unsynced: provider.hasUnsyncedChanges, stranded: provider.stranded ?? null, refused: provider.writeRefused ?? null };
  },

  /**
   * A change made in this tab's document that no keystroke made — what the
   * NML compatibility mirror writes when it repairs a reader's projection.
   */
  localChange(docId: string) {
    peekProvider(docId)!.doc.getMap("repair").set("at", Date.now());
  },
};

Object.assign(window, { expiry: harness });
