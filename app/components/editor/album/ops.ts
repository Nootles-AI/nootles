import { indexByHandle } from "./handle";
import { MAX_COLS, type Album, type AlbumItem } from "./types";

/**
 * Everything that can happen to an album, said once.
 *
 * The bar in `AlbumSurface` and the agent's `album_edit` tool are the same seven
 * verbs against the same function. That is the project's one-vocabulary rule
 * taken literally: there is no arrangement a person can reach that the agent
 * cannot, and no edit the agent can make that is not something the album already
 * knew how to do.
 *
 * Pictures are addressed by HANDLE, never by position (see `handle.ts`). It is
 * what makes an op safe to apply late: the user may have dragged a tile between
 * the agent reading the album and this running, and a handle still means the
 * picture it always meant where an index would have moved under it. The one
 * place a position appears is `move`'s destination and `add`'s insertion point,
 * where a position is genuinely what is being said.
 *
 * Pure, and total. Nothing throws — an op that cannot be carried out is
 * reported, because the agent's remedy for "there is no picture k7f" is to read
 * the album again, and it can only do that if it is told.
 */

export type AlbumOp =
  /**
   * The whole album, in the order it should read. A permutation of what is
   * there — anything missing from the list keeps its relative order at the end,
   * so a partial list is a promotion rather than a silent deletion. Removing is
   * `remove`, always, and never a thing that happens because a list was short.
   */
  | { op: "order"; items: string[] }
  /** One picture to one position. The bar's keyboard move, and a drag's landing. */
  | { op: "move"; item: string; to: number }
  | { op: "remove"; items: string[] }
  /** How many columns one picture is drawn across. Absolute, not a step. */
  | { op: "span"; item: string; cols: number }
  /**
   * The album's own shape. `null` clears — an album that has never been widened
   * writes no width, and one whose columns are not pinned writes no count, so
   * clearing and "not set" are the same thing said the same way.
   */
  | { op: "grid"; cols?: number | null; width?: number | null }
  | { op: "add"; items: AlbumItem[]; at?: number }
  /** The lightbox's re-cut, and the only op that changes what a picture IS. */
  | { op: "replace"; item: string; with: AlbumItem };

export type ApplyAlbum = {
  album: Album;
  /** Handles no picture answered to, in the words the agent is given them back in. */
  missing: string[];
};

/** One column wide is the default, and a default is written by omission. */
function withSpan(item: AlbumItem, span: number): AlbumItem {
  const { span: _was, ...rest } = item;
  return span > 1 ? { ...rest, span } : rest;
}

/** The album's own attributes, where clearing one means removing it. */
function withGrid(album: Album, op: Extract<AlbumOp, { op: "grid" }>): Album {
  const { cols: _cols, w: _w, ...rest } = album;
  const next: Album = { ...rest };
  const cols = op.cols === undefined ? album.cols : (op.cols ?? undefined);
  const width = op.width === undefined ? album.w : (op.width ?? undefined);
  if (width) next.w = Math.round(width);
  if (cols) next.cols = Math.min(MAX_COLS, Math.max(1, Math.round(cols)));
  return next;
}

export function applyAlbumOps(album: Album, ops: readonly AlbumOp[]): ApplyAlbum {
  const missing: string[] = [];
  let items = album.items;
  let shape = album;

  /** Re-derived per op: an earlier op in the batch may have renamed the album. */
  const locate = (handle: string): number => {
    const at = indexByHandle(items).get(handle);
    if (at === undefined) missing.push(handle);
    return at ?? -1;
  };

  for (const op of ops) {
    switch (op.op) {
      case "order": {
        const at = indexByHandle(items);
        const taken = new Set<number>();
        const front: AlbumItem[] = [];
        for (const handle of op.items) {
          const i = at.get(handle);
          if (i === undefined) {
            missing.push(handle);
            continue;
          }
          // A handle said twice is said once. The alternative is duplicating
          // the picture, which no reorder ever means.
          if (taken.has(i)) continue;
          taken.add(i);
          front.push(items[i]);
        }
        items = [...front, ...items.filter((_, i) => !taken.has(i))];
        break;
      }
      case "move": {
        const from = locate(op.item);
        if (from === -1) break;
        const to = Math.min(items.length - 1, Math.max(0, Math.round(op.to)));
        const list = [...items];
        list.splice(to, 0, ...list.splice(from, 1));
        items = list;
        break;
      }
      case "remove": {
        const at = indexByHandle(items);
        const gone = new Set<number>();
        for (const handle of op.items) {
          const i = at.get(handle);
          if (i === undefined) missing.push(handle);
          else gone.add(i);
        }
        items = items.filter((_, i) => !gone.has(i));
        break;
      }
      case "span": {
        const i = locate(op.item);
        if (i === -1) break;
        const cols = Math.min(MAX_COLS, Math.max(1, Math.round(op.cols)));
        items = items.map((item, at) => (at === i ? withSpan(item, cols) : item));
        break;
      }
      case "grid":
        shape = withGrid(shape, op);
        break;
      case "add": {
        const at = Math.min(items.length, Math.max(0, Math.round(op.at ?? items.length)));
        items = [...items.slice(0, at), ...op.items, ...items.slice(at)];
        break;
      }
      case "replace": {
        const i = locate(op.item);
        if (i === -1) break;
        const was = items[i];
        // The first cut records what it was cut FROM, and every later cut
        // carries that same origin — so reset is the true original, however
        // many times the picture has been trimmed. Restoring the original
        // drops the record, because there is then nothing to go back to.
        const origin =
          was.of ??
          ({
            src: was.src,
            w: was.w,
            h: was.h,
            ...(was.poster ? { poster: was.poster } : {}),
          } satisfies NonNullable<AlbumItem["of"]>);
        items = items.map((item, at) =>
          at === i
            ? {
                ...op.with,
                ...(was.span ? { span: was.span } : {}),
                ...(op.with.src === origin.src ? {} : { of: origin }),
              }
            : item,
        );
        break;
      }
    }
  }

  return { album: { ...shape, items }, missing: [...new Set(missing)] };
}
