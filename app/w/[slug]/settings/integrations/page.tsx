import { connection } from "next/server";
import { IntegrationsSettings } from "@/app/components/workspaces/settings/IntegrationsSettings";

/**
 * What a workspace is connected to. Rendered per request, so whether this
 * deployment names a GitHub App to install is read from the environment it
 * runs in rather than the one it was built in.
 */
export default async function WorkspaceIntegrationsPage() {
  await connection();
  return <IntegrationsSettings installable={!!process.env.GITHUB_APP_SLUG} />;
}
