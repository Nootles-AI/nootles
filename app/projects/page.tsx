import type { Metadata } from "next";
import { ProjectsScreen } from "./ProjectsScreen";

export const metadata: Metadata = {
  title: "Projects · auto-board",
};

export default function ProjectsPage() {
  return <ProjectsScreen />;
}
