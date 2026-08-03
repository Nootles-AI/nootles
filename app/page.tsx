import type { Metadata } from "next";
import { Authed } from "./components/Authed";
import { ProjectsScreen } from "./components/ProjectsScreen";

export const metadata: Metadata = {
  title: "Nootles",
};

/** The root is the project manager, the way a docs app opens on your files. */
export default function Home() {
  return (
    <Authed>
      <ProjectsScreen />
    </Authed>
  );
}
