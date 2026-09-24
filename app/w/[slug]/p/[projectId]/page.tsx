import { ProjectStack } from "@/app/components/ProjectStack";

/** One of a workspace's projects, open — the same stack as `/p/<id>`. */
export default async function WorkspaceProjectPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectStack projectId={projectId} />;
}
