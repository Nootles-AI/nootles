import type { Metadata } from "next";
import type { Id } from "@/convex/_generated/dataModel";
import { Authed } from "@/app/components/Authed";
import { WorkspaceSkeleton } from "@/app/components/Skeleton";
import { Workspace } from "@/app/components/Workspace";
import { OpenPageProvider } from "@/app/components/OpenPageContext";
import { ReviewProvider } from "@/app/components/ReviewContext";
import { EditorRegistryProvider } from "@/app/components/editor/EditorRegistry";

export const metadata: Metadata = {
  title: "Nootles",
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
  // All three providers sit above the workspace because the chat panel is a
  // sibling of the document, not a parent of it: this is where they meet.
  return (
    <Authed fallback={<WorkspaceSkeleton />}>
      <EditorRegistryProvider>
        <OpenPageProvider>
          <ReviewProvider projectId={projectId as Id<"projects">}>
            <Workspace projectId={projectId as Id<"projects">} />
          </ReviewProvider>
        </OpenPageProvider>
      </EditorRegistryProvider>
    </Authed>
  );
}
