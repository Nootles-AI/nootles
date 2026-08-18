import type { Link } from "./types";

/**
 * Serialize link data to JSON for storage in the block's `data` prop.
 */
export function serializeLink(link: Link): string {
  return JSON.stringify({
    href: link.href,
    title: link.title,
    subtitle: link.subtitle,
    image: link.image,
  });
}
