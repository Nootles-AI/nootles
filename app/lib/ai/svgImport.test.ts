import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { importSvgScene } from "./svgImport";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { parseScene } from "@/app/components/editor/canvas/scene/parse";
import type { PathNode } from "@/app/components/editor/canvas/scene/types";

const dom = (h: string) => parseHTML(h).document as unknown as Document;
const run = (svg: string, frame = { w: 320, h: 180 }) =>
  importSvgScene(svg, frame, dom);

/**
 * Held to what the census of real Recraft output exercises — flat paths,
 * identity transforms, rgb fills, the odd gradient — plus the primitive and
 * transform handling that costs nothing to keep honest.
 */
describe("importSvgScene", () => {
  it("imports paths in paint order, scaled cover into the frame", () => {
    // 640x360 source → k = 0.5 exactly, no crop.
    const out = run(
      `<svg viewBox="0 0 640 360">
        <path d="M 0 0 L 640 0 L 640 360 L 0 360 Z" fill="rgb(5,91,114)"/>
        <path d="M 100 100 L 200 100 L 200 200 L 100 200 Z" fill="rgb(246,86,41)"/>
      </svg>`,
    );
    expect(out).not.toBeNull();
    const [sky, box] = out!.scene.nodes as PathNode[];
    expect(out!.scene.w).toBe(320);
    expect([sky.x, sky.y, sky.w, sky.h]).toEqual([0, 0, 320, 180]);
    expect([box.x, box.y, box.w, box.h]).toEqual([50, 50, 50, 50]);
    expect(sky.style.fill).toBe("rgb(5,91,114)");
  });

  it("round-trips through the scene grammar byte for byte", () => {
    const out = run(
      `<svg viewBox="0 0 640 360"><path d="M 0 0 L 64 0 L 64 36 Z" fill="#123456"/></svg>`,
    );
    const html = serializeScene({ ...out!.scene, id: undefined });
    expect(serializeScene(parseScene(html, dom))).toBe(html);
  });

  it("cover-crops an aspect mismatch, centred", () => {
    // Square source into a 16:9 frame: k = 320/320 wait — 320x320 source,
    // frame 320x180 → k = max(1, 0.5625) = 1, y offset = (180-320)/2 = -70.
    const out = run(
      `<svg viewBox="0 0 320 320"><path d="M 0 0 L 320 0 L 320 320 L 0 320 Z" fill="#111"/></svg>`,
    );
    const [bg] = out!.scene.nodes;
    expect(bg.w).toBe(320);
    expect(bg.y).toBe(-70);
  });

  it("converts primitives and folds transforms", () => {
    const out = run(
      `<svg viewBox="0 0 640 360">
        <g transform="translate(100, 50)">
          <rect x="0" y="0" width="100" height="60" fill="#222"/>
          <circle cx="200" cy="30" r="30" fill="#333"/>
        </g>
      </svg>`,
    );
    const [rect, circle] = out!.scene.nodes;
    // rect at (100,50) source → halved.
    expect([rect.x, rect.y, rect.w, rect.h]).toEqual([50, 25, 50, 30]);
    // circle centre (300,80) r30 → box (270,50)-(330,110) → halved.
    expect([circle.x, circle.y, circle.w, circle.h]).toEqual([135, 25, 30, 30]);
  });

  it("resolves a gradient fill to a stop and defaults a bare fill to black", () => {
    const out = run(
      `<svg viewBox="0 0 640 360">
        <defs><linearGradient id="Gradient1">
          <stop offset="0" stop-color="rgb(10,20,30)"/>
          <stop offset="1" stop-color="rgb(200,100,50)"/>
        </linearGradient></defs>
        <path d="M 0 0 L 64 0 L 64 36 Z" fill="url(#Gradient1)"/>
        <path d="M 0 0 L 32 0 L 32 18 Z"/>
      </svg>`,
    );
    const [grad, bare] = out!.scene.nodes;
    expect(grad.style.fill).toBe("rgb(200,100,50)");
    expect(bare.style.fill).toBe("#000000");
  });

  it("skips metadata and defs, counts what it cannot convert", () => {
    const out = run(
      `<svg viewBox="0 0 640 360">
        <metadata>junk</metadata>
        <defs><clipPath id="c"><rect width="1" height="1"/></clipPath></defs>
        <image href="x.png" width="10" height="10"/>
        <path d="M 0 0 L 64 0 L 64 36 Z" fill="#123"/>
      </svg>`,
    );
    expect(out!.scene.nodes).toHaveLength(1);
    expect(out!.dropped).toBe(1);
  });

  it("returns null for an empty or rootless document", () => {
    expect(run(`<div>not svg</div>`)).toBeNull();
    expect(run(`<svg viewBox="0 0 100 100"></svg>`)).toBeNull();
  });

  it("rounds scaled coordinates to a decimal, not fifteen", () => {
    // 2048-space into 320 = ×0.15625, which turns every coordinate into a
    // float long enough that the imported scene weighed AS MUCH as its source
    // — the difference between a nine-shot board fitting Convex's 1MiB value
    // ceiling and not.
    const out = run(
      `<svg viewBox="0 0 2048 1152"><path d="M 218.467 307.914 L 1343.853 524.981 L 300 900 Z" fill="#123"/></svg>`,
    );
    const [p] = out!.scene.nodes;
    const html = JSON.stringify(p);
    expect(html).not.toMatch(/\d\.\d{3,}/);
  });
});
