import { z } from "zod";

/**
 * The vector styles a drawing can be asked for, and the dial beside them.
 *
 * These are Recraft V3 Vector's curated style presets, named exactly as the
 * API validates them — the current docs' display names double as the wire
 * values, probed live ("Vector art", "Line art", "Sharp contrast", "Seamless
 * Vector" all confirmed against the endpoint). The legacy snake_case
 * `substyle` vocabulary is deliberately not used: the endpoint ignores an
 * unknown substyle in silence, where an unknown `style` is refused out loud —
 * and a menu must not offer a choice the artist would quietly disregard.
 *
 * Shared by the picker (labels), the route (validation) and the artist (the
 * request), so the three can never drift apart.
 */
/**
 * Recraft publishes twenty-three vector presets; these are the twelve worth
 * offering. A shot is read at a couple of hundred pixels, so anything whose
 * character lives in fine detail — Engraving's hatching, Thin's hairlines,
 * Vector Photo's tonal bands, Mosaic's tiles — arrives as mush and as
 * thousands of paths the importer then has to cull. Seamless Vector makes a
 * repeating tile, which is not a picture of anything. The rest were dropped
 * for being a costume rather than a style (Cosmics, Chemistry, Depressive,
 * Naivector, Segmented Colors) or for saying what a neighbour already says.
 *
 * Ordered as they are chosen: the flat default, then the ink family, then
 * the flat-colour family, then the two that lead with colour.
 */
export const DRAW_STYLES = [
  "Vector art",
  "Line art",
  "Bold stroke",
  "Marker outline",
  "Linocut",
  "Sharp contrast",
  "Editorial",
  "Cutout",
  "Roundish flat",
  "Colored stencil",
  "Color blobs",
  "Vivid shapes",
] as const;

export type DrawStyleName = (typeof DRAW_STYLES)[number];

/**
 * Styles that are ink on paper, and must come back that way.
 *
 * The preset alone does not hold the line: a brief carrying colour words
 * ("amber lamplight", "a noir palette") pulls Line art into full colour, and
 * what arrives then contradicts both its name and the black-and-white swatch
 * the user chose it by. The palette control is the only thing the endpoint
 * honours literally — verified against it — so these styles state their two
 * colours outright rather than hoping the brief stays quiet.
 */
export const MONOCHROME_STYLES: ReadonlySet<DrawStyleName> = new Set([
  "Line art",
  "Linocut",
  "Sharp contrast",
]);

/**
 * What the user settles before the artist draws: a style, and how far from a
 * literal reading the composition may stray (Recraft's `artistic_level`,
 * 0 = straight-on and clean, 5 = eccentric angles and movement).
 */
export const drawChoiceSchema = z.object({
  style: z.enum(DRAW_STYLES),
  artisticLevel: z.number().int().min(0).max(5),
});

export type DrawChoice = z.infer<typeof drawChoiceSchema>;

export const DEFAULT_DRAW_CHOICE: DrawChoice = {
  style: "Vector art",
  artisticLevel: 2,
};
