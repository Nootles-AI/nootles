import type { Metadata } from "next";
import { ProjectsScreen } from "./components/ProjectsScreen";

export const metadata: Metadata = {
  title: "auto-board",
};

/** The root is the project manager, the way a docs app opens on your files. */
export default function Home() {
  return <ProjectsScreen />;
}
