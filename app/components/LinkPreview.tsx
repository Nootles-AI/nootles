"use client";

export interface LinkPreviewProps {
  /** The URL the link points to. */
  href: string;
  /** The link's display text or title from metadata. */
  title?: string;
  /** A description or subtitle from metadata. */
  subtitle?: string;
  /** An image URL (og:image, favicon, etc.) */
  image?: string;
}

/**
 * Renders a rich link preview card with title, subtitle, and optional image.
 * Styled like the location block: text on the left, image on the right as a visual "pin".
 *
 * Used in documents to display link references with visual context.
 */
export function LinkPreview({
  href,
  title,
  subtitle,
  image,
}: LinkPreviewProps) {
  const domain = extractDomain(href);
  const displayTitle = title || domain;
  const displaySubtitle = subtitle || href;
  const hasImage = Boolean(image);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`nt-link ${hasImage ? "" : "is-imageless"}`}
      aria-label={`Link: ${displayTitle}`}
    >
      {/* Text content: title and subtitle on the left. */}
      <div className="nt-link-body">
        <div className="nt-link-title">{displayTitle}</div>
        <div className="nt-link-subtitle">{displaySubtitle}</div>
      </div>

      {/* Image "pin" on the right, like the map in the location card. */}
      {hasImage && (
        <div className="nt-link-image-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={image} alt="" className="nt-link-image" loading="lazy" />
        </div>
      )}
    </a>
  );
}

/**
 * Extracts the domain from a URL string for display.
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}
