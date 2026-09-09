/**
 * A link's address, if a document may carry it.
 *
 * Kept on its own because three different readers need exactly this and
 * nothing else from the AI's HTML parser: the parser itself, the canvas label
 * grammar, and the Figma plugin that writes that grammar from outside the
 * app. A `javascript:` link is a payload, not a link, and is refused rather
 * than rewritten.
 */

const SAFE_SCHEME = /^(?:https?|mailto|tel):/;

/**
 * Drops everything a browser skips over while it reads a scheme: the C0 range
 * and space, DEL, and the C1 range.
 *
 * Written as a code-point test rather than a character class on purpose. The
 * escapes for these are the sort of thing that survives being written and then
 * does not survive being edited, and the failure is silent and specific — a
 * class that gains a stray hyphen strips the hyphens out of every url it is
 * handed, and `my-site.com` becomes a host that does not exist.
 */
function withoutControls(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code <= 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (!control) out += ch;
  }
  return out;
}

/**
 * A destination we are willing to make clickable, or null.
 *
 * The model writes these, and every one of them passes through here: the
 * compiler builds page links from what this returns, and the chat renders its
 * links through it too. A `javascript:` url refused at this line cannot reach an
 * anchor anyone could click. Not a theoretical concern — hrefs arrive from
 * whatever the model read, `search_web` included, so a page it summarises is in
 * a position to suggest one.
 *
 * Control characters go before the scheme is read, because `java\tscript:` is a
 * scheme to a browser and a mystery to a regex. What is left is either a scheme
 * we allow, or no scheme at all — a relative path or a fragment, which navigates
 * and nothing more.
 */
export function safeHref(raw: string): string | null {
  const href = withoutControls(raw);
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return SAFE_SCHEME.test(href.toLowerCase()) ? href : null;
  }
  return href;
}

