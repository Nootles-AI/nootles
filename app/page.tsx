import type { Metadata } from "next";
import { Suspense } from "react";
import { Authed } from "./components/Authed";
import { ProjectsScreen } from "./components/ProjectsScreen";
import { FirstRun } from "./components/welcome/FirstRun";

export const metadata: Metadata = {
  title: "Nootles",
};

/**
 * The root is the project manager, the way a docs app opens on your files —
 * except on the one visit where there are no files yet, which goes to the
 * welcome screen instead of showing an empty shelf.
 *
 * Also where `/api/notion/connect` sends people back to when the import dialog
 * was opened here. The query string it arrives with is read on the client
 * (`useNotionOutcome`), which is what the Suspense boundary is for:
 * `useSearchParams` in a prerendered route has to sit under one.
 */
export default function Home() {
  return (
    <Authed>
      <FirstRun>
        <Suspense>
          <ProjectsScreen />
        </Suspense>
      </FirstRun>
    </Authed>
  );
}
