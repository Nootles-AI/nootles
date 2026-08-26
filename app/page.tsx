import type { Metadata } from "next";
import { Authed } from "./components/Authed";
import { ProjectsScreen } from "./components/ProjectsScreen";
import { FirstRun } from "./components/welcome/FirstRun";
import { ProjectsSkeleton } from "./components/Skeleton";

export const metadata: Metadata = {
  title: "Nootles",
};

/**
 * The root is the project manager, the way a docs app opens on your files —
 * except on the one visit where there are no files yet, which goes to the
 * welcome screen instead of showing an empty shelf.
 */
export default function Home() {
  return (
    <Authed fallback={<ProjectsSkeleton />}>
      <FirstRun>
        <ProjectsScreen />
      </FirstRun>
    </Authed>
  );
}
