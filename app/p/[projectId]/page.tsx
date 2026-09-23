import type { Metadata } from "next";
import { ProjectStack } from "@/app/components/ProjectStack";

export const metadata: Metadata = {
  title: "Nootles",
};

/**
 * One project, open. The id is in the path rather than a query param, so
 * "back to projects" is real navigation and a project is linkable.
 *
 * Your own projects live here; a workspace's live under `/w/<slug>/p/<id>`,
 * and the stack moves one reached here to that address (`ProjectStack`).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectStack projectId={projectId} />;
}
