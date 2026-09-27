import { parseHTML } from "linkedom";
import { parseFragment, parseScene, type ParseHtml } from "@/app/components/editor/canvas/scene/parse";
import type { Scene } from "@/app/components/editor/canvas/scene/types";

/**
 * Shared test scaffolding for every vitest file in this directory —
 * `linkedom`'s DOM injected the way `app/lib/ai/html/toHtml.test.ts` already
 * does, plus the two named fixtures TOOLS.md §7 builds its whole behaviour
 * table against. Not itself a test file (vitest's `include` glob only picks
 * up `*.test.ts`), so this is where the F1/F2 markup lives ONCE instead of
 * six times over. Both are band roots — a height, never a width — because a
 * tool only ever reads a diagram through the block reader, which makes one.
 */
export const parseHtml: ParseHtml = (h) => parseHTML(h).document as unknown as Document;

export const parse = (html: string): Scene => parseScene(html, parseHtml);
export const fragment = (html: string) => parseFragment(html, parseHtml);

/**
 * TOOLS.md §7's F1: two labelled rects, a flex group of two unlabelled
 * children, a path, and a connector. Used throughout the write/verb/report
 * behaviour tables.
 */
export const F1 = `<nt-diagram h="400" style="--brand: #6366f1">
  <nt-rect id="s1" x="40" y="40" w="200" h="56" style="background: var(--brand); border-radius: 10px">Order</nt-rect>
  <nt-rect id="s2" x="300" y="40" w="200" h="56" style="background: #f2f2f0">Ship</nt-rect>
  <nt-group id="g1" x="40" y="160" w="460" h="80" style="display: flex; gap: 16px; padding: 12px">
    <nt-rect id="c1" w="100" h="40"></nt-rect>
    <nt-rect id="c2" w="100" h="40"></nt-rect>
  </nt-group>
  <nt-path id="p1" x="520" y="40" w="40" h="40" d="M 0 0 L 40 40" style="stroke: #2b2b28; fill: none"></nt-path>
  <nt-edge id="e1" from="s1" to="s2">then</nt-edge>
</nt-diagram>`;

/**
 * TOOLS.md §7's F2: an unlabelled, unrotated rect enclosing two plain rects —
 * the one shape `frameOf` (the `group` verb's frame-absorption case) can fire
 * on, which F1 can never exercise since `s1`/`s2` are both labelled.
 */
export const F2 = `<nt-diagram h="200">
  <nt-rect id="frame1" x="0" y="0" w="300" h="200" style="background: #f5f5f5"></nt-rect>
  <nt-rect id="a1" x="20" y="20" w="100" h="60">A</nt-rect>
  <nt-rect id="a2" x="180" y="20" w="100" h="60">B</nt-rect>
</nt-diagram>`;

export const f1 = (): Scene => parse(F1);
export const f2 = (): Scene => parse(F2);
