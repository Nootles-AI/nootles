/**
 * Who may make a workspace while teams is being rolled out. `TEAMS_ROLLOUT` is
 * "off" (the default), "allowlist" (the Clerk subjects in `TEAMS_ALLOWLIST`,
 * comma-separated) or "on". Read per call, so an operator's change takes
 * effect without a deploy.
 *
 * It gates making a workspace and nothing else: a workspace that exists keeps
 * working for its members whatever this says, so turning it off again strands
 * nobody.
 */
export function teamsEnabledFor(subject: string | null): boolean {
  if (!subject) return false;
  const mode = process.env.TEAMS_ROLLOUT?.trim().toLowerCase();
  if (mode === "on") return true;
  if (mode !== "allowlist") return false;
  return (process.env.TEAMS_ALLOWLIST ?? "")
    .split(",")
    .some((entry) => entry.trim() === subject);
}
