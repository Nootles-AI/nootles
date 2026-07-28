import type { Metadata } from "next";
import type { Id } from "@/convex/_generated/dataModel";
import { Workspace } from "@/app/components/Workspace";

export const metadata: Metadata = {
  title: "auto-board",
};

/**
 * One project, open. The id is in the path rather than a query param, so
 * "back to projects" is real navigation and a project is linkable.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return <Workspace projectId={projectId as Id<"projects">} />;
}
