"use client";

import { ProjectsScreen } from "../ProjectsScreen";
import { useContainer } from "./ContainerContext";

/**
 * A workspace's projects: the projects screen itself, in the workspace
 * `ContainerRoute` provides. Keyed by the workspace, so going from one
 * workspace's home to another's starts the screen afresh — its first paint
 * is read once, from what this browser last saw of that home.
 */
export function WorkspaceHome() {
  const container = useContainer();
  if (container.kind !== "workspace") return null;
  return <ProjectsScreen key={container.workspaceId} />;
}
