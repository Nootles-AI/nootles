/**
 * What an album is, and the numbers the waterfall is packed from.
 *
 * An item carries its intrinsic size, not just its source. That is the whole
 * reason an album can pack itself the moment the block renders and never move
 * again as the pictures arrive: the column a tile lands in and the room it
 * reserves both come from `w`/`h`, which are known before a single byte is
 * fetched. Take the sizes away and the layout would have to wait for `onload`
 * and then jump — which is exactly what a waterfall must not do.
 */

export type AlbumItem = {
  kind: "image" | "video";
  /** A Convex storage URL. Permanent, and readable by anyone holding it. */
  src: string;
  /** Intrinsic pixel size of the stored file — the tile's aspect ratio. */
  w: number;
  h: number;
  /**
   * Columns the picture is drawn across. Absent means one, which is every
   * picture until somebody widens it — a photo's own size is its aspect ratio,
   * and this is the only thing about how big it is drawn that is a decision.
   */
  span?: number;
  /** A video's first frame, so its tile paints before the video decodes. */
  poster?: string;
  /**
   * The picture this one was cut from, kept by the first crop or trim and
   * carried unchanged through every later one — so reset means the true
   * original, whole, with nothing to fetch or measure first.
   */
  of?: { src: string; w: number; h: number; poster?: string };
};

export type Album = {
  items: AlbumItem[];
  /** The block's own id, put on the root the way a diagram carries its. */
  id?: string;
  /** Set only by the width grip; absent means "track the text column". */
  w?: number;
  /**
   * Set only by the bar's column control; absent means "as many as the width
   * comfortably holds". Pinned, it is the other way to say how big the
   * pictures are: the same width across fewer columns is bigger pictures.
   */
  cols?: number;
};

/** A model may write `<img src>` with no size. A photo's usual shape stands in. */
export const DEFAULT_W = 3;
export const DEFAULT_H = 2;

export const ALBUM_MIN_W = 240;
/** Kept clear either side, so a widened album cannot reach the window's edge. */
export const ALBUM_GUTTER = 32;

/**
 * The column width the packer aims at. The count follows from the room, so
 * widening the block adds columns rather than stretching the pictures — which
 * is what keeps a photo the same size whatever width the album is dragged to.
 */
export const TARGET_COL_W = 200;
export const MAX_COLS = 6;
/** Between tiles, in both directions. Read by the packer and by the CSS. */
export const GAP = 8;
