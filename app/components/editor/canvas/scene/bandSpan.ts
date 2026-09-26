import { COLUMN_WIDTH } from "@/app/lib/column";

/**
 * How wide a band is and where it starts: plain numbers, apart from the
 * measurements that lay a scene out. The serializer writes a band's width into
 * the model's read and the projects screen sizes a diagram's slot before its
 * renderer has loaded, and neither should carry the layout engine to do it.
 * Import them from `./band` anywhere else.
 */

/** A wide band's width, centred on the column. */
export const WIDE_W = 1200;
/** How far a wide band reaches past the column on each side. */
export const WIDE_MARGIN = (WIDE_W - COLUMN_WIDTH) / 2;

/** The band's left edge in scene px: the column's, or the wide margin past it. */
export function bandLeft(scene: { wide?: boolean }): number {
  return scene.wide ? -WIDE_MARGIN : 0;
}

export function bandWidth(scene: { wide?: boolean }): number {
  return scene.wide ? WIDE_W : COLUMN_WIDTH;
}
