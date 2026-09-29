import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { usePathname } from "next/navigation";
import { ConvexClientProvider } from "../app/ConvexClientProvider";
import { TelemetryProvider } from "../app/components/TelemetryProvider";
import { NotionConfigProvider } from "../app/components/notion/NotionAvailable";
import { StandInProvider } from "../app/components/StandIn";
import { IdentitySync } from "../app/components/IdentitySync";
import { AffiliateClaim } from "../app/components/AffiliateClaim";
import { Authed } from "../app/components/Authed";
import { FirstRun } from "../app/components/welcome/FirstRun";
import { ProjectsScreen } from "../app/components/ProjectsScreen";
import { Welcome } from "../app/components/welcome/Welcome";
import { OpenPageProvider } from "../app/components/OpenPageContext";
import { SharedProject } from "../app/components/share/SharedProject";

/**
 * The in-browser half of affiliates.fullstack.mjs: the app's root layout —
 * its real providers in `app/layout.tsx`'s order, the real
 * `ConvexClientProvider` among them, so a stand-in's `nt_imp` cookie is read
 * exactly as the app reads it — around the pages a visitor lands on after an
 * affiliate link: `/` (FirstRun and the projects screen), `/welcome`, and
 * `/share/<token>`.
 *
 * The page is served from the same origin as the real `/r/<slug>` route, so
 * the `nt_ref` cookie that route sets is the one this page's
 * `AffiliateClaim` finds. Clerk is the fixture in tests/comments-surfaces.shared.mjs
 * form, answering with the runner's token from `window.__aff`.
 */

function Page() {
  const pathname = usePathname();
  const token = /^\/share\/([^/]+)/.exec(pathname)?.[1];
  if (token) {
    return (
      <OpenPageProvider>
        <SharedProject token={decodeURIComponent(token)} />
      </OpenPageProvider>
    );
  }
  if (pathname === "/welcome") {
    return (
      <Authed>
        <Welcome />
      </Authed>
    );
  }
  return (
    <FirstRun>
      <Suspense>
        <ProjectsScreen />
      </Suspense>
    </FirstRun>
  );
}

createRoot(document.getElementById("app")!).render(
  <ConvexClientProvider>
    <TelemetryProvider>
      <NotionConfigProvider oauth={false}>
        <StandInProvider>
          <IdentitySync>
            <Page />
          </IdentitySync>
          <AffiliateClaim />
        </StandInProvider>
      </NotionConfigProvider>
    </TelemetryProvider>
  </ConvexClientProvider>,
);
