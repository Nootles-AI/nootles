import type { Link } from "./types";

/**
 * Parse serialized link data from the block's `data` prop.
 * Format: JSON string with href, title, subtitle, image.
 */
export function parseLink(source: string): Link {
  if (!source) {
    return {
      href: "",
      title: "",
      subtitle: "",
      image: "",
    };
  }

  try {
    const parsed = JSON.parse(source) as Partial<Link>;
    return {
      href: parsed.href || "",
      title: parsed.title || "",
      subtitle: parsed.subtitle || "",
      image: parsed.image || "",
    };
  } catch {
    return {
      href: "",
      title: "",
      subtitle: "",
      image: "",
    };
  }
}
