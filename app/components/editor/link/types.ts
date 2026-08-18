/**
 * A link with optional metadata.
 */
export interface Link {
  /** The URL the link points to. */
  href: string;
  /** Display title, defaults to domain. */
  title: string;
  /** Description or subtitle. */
  subtitle: string;
  /** Thumbnail image URL. */
  image: string;
}
