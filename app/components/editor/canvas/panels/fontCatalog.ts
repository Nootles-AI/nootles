/**
 * The families the font picker offers by name.
 *
 * The system stacks first, since they cost nothing to load, then the Google
 * families a Figma file is likeliest to be set in. Any other name can still be
 * typed: the loader asks for whatever a declaration says, and this list only
 * decides what is a click away.
 */

export type FontOption = { value: string; label: string };

export const SYSTEM_FONTS: FontOption[] = [
  { value: "", label: "Default" },
  { value: "ui-sans-serif, system-ui, sans-serif", label: "Sans" },
  { value: 'ui-serif, Georgia, "Times New Roman", serif', label: "Serif" },
  { value: "ui-monospace, SFMono-Regular, Menlo, monospace", label: "Mono" },
  { value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: "Helvetica" },
  { value: "Georgia, serif", label: "Georgia" },
];

const GOOGLE: [string, "sans-serif" | "serif" | "monospace" | "cursive"][] = [
  ["Inter", "sans-serif"],
  ["Roboto", "sans-serif"],
  ["Open Sans", "sans-serif"],
  ["Lato", "sans-serif"],
  ["Montserrat", "sans-serif"],
  ["Poppins", "sans-serif"],
  ["Nunito", "sans-serif"],
  ["Nunito Sans", "sans-serif"],
  ["Raleway", "sans-serif"],
  ["Work Sans", "sans-serif"],
  ["DM Sans", "sans-serif"],
  ["Manrope", "sans-serif"],
  ["Plus Jakarta Sans", "sans-serif"],
  ["Figtree", "sans-serif"],
  ["Outfit", "sans-serif"],
  ["Sora", "sans-serif"],
  ["Urbanist", "sans-serif"],
  ["Rubik", "sans-serif"],
  ["Karla", "sans-serif"],
  ["Mulish", "sans-serif"],
  ["Source Sans 3", "sans-serif"],
  ["IBM Plex Sans", "sans-serif"],
  ["Noto Sans", "sans-serif"],
  ["Barlow", "sans-serif"],
  ["Archivo", "sans-serif"],
  ["Space Grotesk", "sans-serif"],
  ["Lexend", "sans-serif"],
  ["Quicksand", "sans-serif"],
  ["Josefin Sans", "sans-serif"],
  ["Oswald", "sans-serif"],
  ["Bebas Neue", "sans-serif"],
  ["Anton", "sans-serif"],
  ["Playfair Display", "serif"],
  ["Merriweather", "serif"],
  ["Lora", "serif"],
  ["Libre Baskerville", "serif"],
  ["EB Garamond", "serif"],
  ["Cormorant Garamond", "serif"],
  ["Crimson Text", "serif"],
  ["Source Serif 4", "serif"],
  ["DM Serif Display", "serif"],
  ["Fraunces", "serif"],
  ["Spectral", "serif"],
  ["Noto Serif", "serif"],
  ["IBM Plex Serif", "serif"],
  ["Roboto Slab", "serif"],
  ["Zilla Slab", "serif"],
  ["JetBrains Mono", "monospace"],
  ["Fira Code", "monospace"],
  ["Source Code Pro", "monospace"],
  ["IBM Plex Mono", "monospace"],
  ["Roboto Mono", "monospace"],
  ["Space Mono", "monospace"],
  ["DM Mono", "monospace"],
  ["Inconsolata", "monospace"],
  ["Caveat", "cursive"],
  ["Pacifico", "cursive"],
  ["Dancing Script", "cursive"],
  ["Kalam", "cursive"],
  ["Permanent Marker", "cursive"],
];

/** `"Inter", sans-serif` — the declaration a chosen Google family writes. */
export function familyValue(name: string, generic = "sans-serif"): string {
  return `"${name}", ${generic}`;
}

export const GOOGLE_FONTS: FontOption[] = GOOGLE.map(([name, generic]) => ({
  value: familyValue(name, generic),
  label: name,
}));

export const FONT_OPTIONS: FontOption[] = [...SYSTEM_FONTS, ...GOOGLE_FONTS];
