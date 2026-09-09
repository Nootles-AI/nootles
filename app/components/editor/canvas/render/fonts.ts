"use client";

import { useEffect } from "react";
import { walk, type Scene } from "../scene/types";

/**
 * Loading the faces a scene names.
 *
 * A label says `font-family: "Inter"` and nothing else: no manifest, no
 * registry, because the declaration is the manifest. This scans every
 * `font-family` a scene carries — on shapes and inside their labels — and
 * asks Google Fonts for each family it does not already know, so a paste from
 * Figma lands in the face it was set in. A family the machine has locally
 * renders locally whatever the request returns; a family nobody has falls
 * back through the stack the declaration names.
 *
 * Three requests, cheapest last: the whole variable axis, then the four
 * static weights most families ship, then the family bare. A 400 from Google
 * is not an error worth surfacing — it is the answer to "does this family
 * have that axis", and the next request asks a smaller question.
 */

const GENERIC = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "ui-rounded",
  "-apple-system",
  "blinkmacsystemfont",
  "segoe ui",
  "helvetica neue",
  "helvetica",
  "arial",
  "georgia",
  "times new roman",
  "times",
  "courier new",
  "courier",
  "menlo",
  "monaco",
  "sfmono-regular",
  "inherit",
  "initial",
  // The app's own faces, already on the page.
  "geist",
  "geist mono",
  "caveat",
]);

/** The first family of a `font-family` value, unquoted, or null for a generic. */
export function familyName(css: string | undefined): string | null {
  if (!css) return null;
  const first = css.split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (!first || first.startsWith("var(") || GENERIC.has(first.toLowerCase())) return null;
  return first;
}

const REQUESTS = [
  (family: string) => `${family}:ital,wght@0,100..900;1,100..900`,
  (family: string) => `${family}:ital,wght@0,400;0,700;1,400;1,700`,
  (family: string) => family,
];

const asked = new Set<string>();

function request(name: string, attempt: number) {
  if (attempt >= REQUESTS.length) return;
  const family = encodeURIComponent(name).replace(/%20/g, "+");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${REQUESTS[attempt](family)}&display=swap`;
  link.onerror = () => {
    link.remove();
    request(name, attempt + 1);
  };
  document.head.append(link);
}

export function loadFamily(name: string): void {
  if (asked.has(name)) return;
  asked.add(name);
  request(name, 0);
}

const IN_LABEL = /font-family:\s*([^;"&]+)/gi;

function familiesOf(scene: Scene): Set<string> {
  const out = new Set<string>();
  const take = (css: string | undefined) => {
    const name = familyName(css);
    if (name) out.add(name);
  };
  take(scene.style["font-family"]);
  walk(scene.nodes, (node) => {
    take(node.style["font-family"]);
    if (node.label.includes("font-family")) {
      IN_LABEL.lastIndex = 0;
      for (let m = IN_LABEL.exec(node.label); m; m = IN_LABEL.exec(node.label)) take(m[1]);
    }
  });
  return out;
}

/** Ask for every family the scene names, once each. */
export function useSceneFonts(scene: Scene): void {
  useEffect(() => {
    for (const name of familiesOf(scene)) loadFamily(name);
  }, [scene]);
}
