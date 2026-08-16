import type { Album, AlbumItem } from "./types";

/**
 * {@link Album} → album HTML, in exactly one form.
 *
 * The canonical form is what the parser normalises to, which is what makes
 * `serializeAlbum(parseAlbum(html)) === html` a fact rather than a hope:
 * canonical tags only, one item per line, two-space indent, and a fixed
 * attribute order — `id`, `w`, `cols` on the root; `src`, `w`, `h`, `span`,
 * a video's `poster`, then an edited picture's origin (`of`, `ow`, `oh`,
 * `oposter`) on an item. Defaults are silence: an album that has never been
 * widened writes no `w`, one whose columns were never pinned writes no
 * `cols`, a picture nobody has made bigger writes no `span`, and one nobody
 * has cut writes no origin.
 */

const ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

function attr(name: string, value: string): string {
  return ` ${name}="${value.replace(/[&<>"]/g, (c) => ESCAPE[c])}"`;
}

function itemToHtml(item: AlbumItem): string {
  const tag = item.kind === "video" ? "video" : "img";
  const span = item.span && item.span > 1 ? attr("span", String(item.span)) : "";
  const poster = item.poster ? attr("poster", item.poster) : "";
  const of = item.of
    ? attr("of", item.of.src) +
      attr("ow", String(item.of.w)) +
      attr("oh", String(item.of.h)) +
      (item.of.poster ? attr("oposter", item.of.poster) : "")
    : "";
  return `  <${tag}${attr("src", item.src)}${attr("w", String(item.w))}${attr(
    "h",
    String(item.h),
  )}${span}${poster}${of}>`;
}

export function serializeAlbum(album: Album): string {
  const id = album.id ? attr("id", album.id) : "";
  const w = album.w ? attr("w", String(album.w)) : "";
  const cols = album.cols ? attr("cols", String(album.cols)) : "";
  const items = album.items.map(itemToHtml).join("\n");
  return `<nt-album${id}${w}${cols}>${items ? `\n${items}\n` : ""}</nt-album>`;
}
