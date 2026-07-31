/**
 * Parse and serialize the two shapes of CSS value the style panel edits: a
 * **stack** (a comma- or space-separated list of layers — fills, shadows,
 * filter functions) and a **composite** (a shorthand over longhands — `border`,
 * `border-radius`).
 *
 * Ported — algorithms only, no Backbone models — from GrapesJS: the
 * composite/stack `toStyle`/`fromStyle` pattern in `PropertyComposite.ts` /
 * `PropertyStack.ts`.
 *
 * Copyright (c) 2017-current, Artur Arseniev
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *
 * - Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 * - Redistributions in binary form must reproduce the above copyright notice, this
 *   list of conditions and the following disclaimer in the documentation and/or
 *   other materials provided with the distribution.
 * - Neither the name "GrapesJS" nor the names of its contributors may be
 *   used to endorse or promote products derived from this software without
 *   specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
 * ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
 * ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/** One layer of a stack value: sub-property name → CSS token. */
export interface Layer {
  values: Record<string, string>;
  /** Tokens no sub-property claimed, kept verbatim so a re-write loses nothing. */
  rest?: string;
}

interface Sub {
  property: string;
  type: "number" | "color" | "gradient" | "select";
  /** The values a select accepts. */
  options?: readonly string[];
  /** What {@link blankLayer} starts this sub-property at. */
  default?: string;
  /** Written as `/value` onto the sub-property declared before it. */
  slash?: boolean;
  /** May take a second token — a background position is two keywords. */
  pair?: boolean;
}

interface Composite {
  sub: readonly Sub[];
  /** Four lengths obeying the CSS top/right/bottom/left shorthand collapse. */
  edges?: boolean;
}

interface Stack {
  sub: readonly Sub[];
  separator: string;
  /** Each layer is `name(value)` rather than a list of parts. */
  fn?: boolean;
}

const num = (property: string, value = "0"): Sub => ({
  property,
  type: "number",
  default: value,
});

const col = (property: string, value: string): Sub => ({
  property,
  type: "color",
  default: value,
});

const sel = (property: string, options: string, value?: string): Sub => ({
  property,
  type: "select",
  options: options.split(" "),
  default: value,
});

export const COMPOSITES = {
  border: {
    sub: [
      num("border-width", "1px"),
      sel("border-style", "solid dashed dotted double"),
      col("border-color", "#000000"),
    ],
  },
  "border-radius": {
    edges: true,
    sub: [
      { property: "border-top-left-radius", type: "number" },
      { property: "border-top-right-radius", type: "number" },
      { property: "border-bottom-right-radius", type: "number" },
      { property: "border-bottom-left-radius", type: "number" },
    ],
  },
} satisfies Record<string, Composite>;

const filterStack = (property: string): Stack => ({
  separator: " ",
  fn: true,
  sub: [
    sel(
      `${property}-fn`,
      "blur brightness contrast saturate grayscale sepia invert hue-rotate",
      "blur",
    ),
    num(`${property}-value`, "4px"),
  ],
});

export const STACKS = {
  background: {
    separator: ", ",
    sub: [
      { property: "background-image", type: "gradient", default: "none" },
      { ...sel("background-position", "center left right top bottom"), pair: true },
      { ...sel("background-size", "auto cover contain"), slash: true },
      sel("background-repeat", "no-repeat repeat repeat-x repeat-y"),
      col("background-color", "#d4d4d8"),
    ],
  },
  "box-shadow": {
    separator: ", ",
    sub: [
      sel("box-shadow-type", "inset"),
      num("box-shadow-h"),
      num("box-shadow-v", "2px"),
      num("box-shadow-blur", "4px"),
      num("box-shadow-spread"),
      col("box-shadow-color", "rgba(0,0,0,0.15)"),
    ],
  },
  filter: filterStack("filter"),
  "backdrop-filter": filterStack("backdrop-filter"),
} satisfies Record<string, Stack>;

export type StackName = keyof typeof STACKS;
export type CompositeName = keyof typeof COMPOSITES;

export const BLEND_MODES = [
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
];

const NUMBER =
  /^-?(?:\d+\.?\d*|\.\d+)(?:px|%|em|rem|vh|vw|deg|rad|turn|fr|s|ms)?$/;
// `var(` is here so a colour bound to a variable reads back as the colour slot
// rather than falling through to the shorthand's leftovers — without it,
// `background: var(--brand)` parses as no fill and the next edit writes a
// literal beside the reference instead of replacing it.
const COLOR =
  /^(?:#[0-9a-f]{3,8}|transparent|currentcolor|(?:var|rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\()/;
const PAINT = /^(?:none|(?:url|image-set|[\w-]*gradient)\()/;

/**
 * Bare keywords a shorthand can carry that are not colours. Any other bare
 * keyword is taken for a named colour (`red`), which is cheaper than carrying
 * 148 rows of table — but `background: url(a.png) left top` must not read its
 * position as one.
 */
const NOT_COLOR = new Set([
  "left",
  "right",
  "top",
  "bottom",
  "center",
  "cover",
  "contain",
  "auto",
  "none",
  "no-repeat",
  "repeat",
  "repeat-x",
  "repeat-y",
  "round",
  "space",
  "scroll",
  "local",
  "fixed",
  "border-box",
  "padding-box",
  "content-box",
  "inset",
]);

/** Splits on a separator at paren depth 0, outside quotes. `" "` is any run of
 *  whitespace. */
function splitTop(value: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (sep === " " ? /\s/.test(c) : c === sep)) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function accepts(sub: Sub, token: string): boolean {
  const t = token.toLowerCase();
  switch (sub.type) {
    case "select":
      return !!sub.options?.includes(t);
    case "number":
      return NUMBER.test(t);
    case "gradient":
      return PAINT.test(t);
    case "color":
      return COLOR.test(t) || (/^[a-z-]+$/.test(t) && !NOT_COLOR.has(t));
  }
}

/**
 * Assigns each token to the first sub-property still unfilled that accepts it.
 *
 * CSS shorthands are order-free — `inset 0 2px #000` and `0 2px #000 inset` are
 * the same shadow — so matching by shape rather than by position is what makes
 * hand-written and AI-written values survive an edit in the panel.
 */
function parseParts(sub: readonly Sub[], layer: string): Layer {
  const values: Record<string, string> = {};
  const rest: string[] = [];
  for (const token of splitTop(layer, " ")) {
    // `center/cover` is one token to the splitter but two values to CSS. The
    // split has to be depth-aware too, or it would cut `rgb(0 0 0 / 50%)` and
    // every `url()` carrying a path in half.
    for (const part of splitTop(token, "/")) {
      const target = sub.find((s) => !(s.property in values) && accepts(s, part));
      if (target) {
        values[target.property] = part;
        continue;
      }
      const pair = sub.find((s) => s.pair && s.property in values && accepts(s, part));
      if (pair) values[pair.property] += ` ${part}`;
      else rest.push(part);
    }
  }
  return rest.length ? { values, rest: rest.join(" ") } : { values };
}

function serializeParts(sub: readonly Sub[], layer: Layer): string {
  const parts: string[] = [];
  let previous = "";
  for (let i = 0; i < sub.length; i++) {
    const s = sub[i];
    const value = layer.values[s.property];
    if (!value) continue;
    if (!s.slash) parts.push(value);
    else if (previous === sub[i - 1]?.property) parts[parts.length - 1] += `/${value}`;
    // A size is only legal straight after a position, so a layer that has one
    // and no position gets CSS's own initial position rather than the size
    // welded onto whatever came before — usually the image.
    else parts.push(`0% 0%/${value}`);
    previous = s.property;
  }
  if (layer.rest) parts.push(layer.rest);
  return parts.join(" ");
}

/** A layered CSS value → one {@link Layer} per shadow / function / fill. */
export function parseLayers(prop: StackName, value: string | undefined): Layer[] {
  const spec: Stack = STACKS[prop];
  const raw = (value ?? "").trim();
  if (!raw || raw.toLowerCase() === "none") return [];
  const [fn, arg] = spec.sub;
  return splitTop(raw, spec.separator.includes(",") ? "," : " ").map((layer) => {
    if (!spec.fn) return parseParts(spec.sub, layer);
    const open = layer.indexOf("(");
    if (open < 0) return { values: {}, rest: layer };
    const close = layer.lastIndexOf(")");
    return {
      values: {
        [fn.property]: layer.slice(0, open).trim(),
        [arg.property]: layer.slice(open + 1, close < 0 ? undefined : close).trim(),
      },
    };
  });
}

/** The inverse of {@link parseLayers}. Empty when there are no layers. */
export function serializeLayers(prop: StackName, layers: Layer[]): string {
  const spec: Stack = STACKS[prop];
  const [fn, arg] = spec.sub;
  return layers
    .map((layer) =>
      spec.fn
        ? layer.values[fn.property]
          ? `${layer.values[fn.property]}(${layer.values[arg.property] ?? ""})`
          : (layer.rest ?? "")
        : serializeParts(spec.sub, layer),
    )
    .filter(Boolean)
    .join(spec.separator);
}

/** A fresh layer at the stack's declared defaults. */
export function blankLayer(prop: StackName): Layer {
  const values: Record<string, string> = {};
  for (const s of STACKS[prop].sub) if (s.default) values[s.property] = s.default;
  return { values };
}

/** A shorthand → its longhands, keyed by sub-property name. */
export function parseComposite(
  prop: CompositeName,
  value: string | undefined,
): Layer {
  const spec: Composite = COMPOSITES[prop];
  const raw = (value ?? "").trim();
  if (!spec.edges) return parseParts(spec.sub, raw);
  const parts = splitTop(raw, " ");
  const at = (i: number) => parts[i] ?? "";
  const edges =
    parts.length === 1
      ? [at(0), at(0), at(0), at(0)]
      : parts.length === 2
        ? [at(0), at(1), at(0), at(1)]
        : parts.length === 3
          ? [at(0), at(1), at(2), at(1)]
          : [at(0), at(1), at(2), at(3)];
  const values: Record<string, string> = {};
  spec.sub.forEach((s, i) => (values[s.property] = edges[i]));
  return { values };
}

/** The inverse of {@link parseComposite}, collapsed to the shortest form. */
export function serializeComposite(prop: CompositeName, layer: Layer): string {
  const spec: Composite = COMPOSITES[prop];
  if (!spec.edges) return serializeParts(spec.sub, layer);
  const [t, r, b, l] = spec.sub.map((s) => layer.values[s.property] || "0");
  if (t === r && r === b && b === l) return t;
  if (t === b && r === l) return `${t} ${r}`;
  if (r === l) return `${t} ${r} ${b}`;
  return `${t} ${r} ${b} ${l}`;
}
