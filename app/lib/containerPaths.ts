/**
 * Addresses, by whose they are. A container is your own account or one
 * workspace, and the one fact an address needs from it is the workspace's
 * slug — null for your own.
 *
 *   /                      your projects
 *   /p/<id>                one of them open
 *   /w/<slug>              a workspace's projects
 *   /w/<slug>/p/<id>       one of those open
 *   /w/<slug>/settings/…   the workspace's settings
 *   /w/join/<token>        an invitation into one
 */

export type SettingsSection = "general" | "members";

export function homePath(slug: string | null): string {
  return slug === null ? "/" : `/w/${slug}`;
}

export function projectPath(slug: string | null, projectId: string): string {
  return slug === null ? `/p/${projectId}` : `/w/${slug}/p/${projectId}`;
}

/** General is the settings page itself; every other section is below it. */
export function settingsPath(slug: string, section: SettingsSection = "general"): string {
  const base = `/w/${slug}/settings`;
  return section === "general" ? base : `${base}/${section}`;
}

export function joinPath(token: string): string {
  return `/w/join/${token}`;
}

/** The project a `/w/<slug>/p/<id>` address opens, or null for any other address. */
export function projectIdIn(pathname: string): string | null {
  const [, w, slug, p, id] = pathname.split("/");
  return w === "w" && slug && p === "p" && id ? id : null;
}

/**
 * The same place in a workspace under another of its addresses — what a
 * retired slug is replaced with, so an old link to a project or a settings
 * page lands on that page rather than on the workspace's home.
 */
export function withSlug(pathname: string, slug: string): string {
  const parts = pathname.split("/");
  if (parts[1] !== "w" || !parts[2]) return homePath(slug);
  parts[2] = slug;
  return parts.join("/");
}
