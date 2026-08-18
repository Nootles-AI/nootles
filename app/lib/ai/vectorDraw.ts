import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { AI } from "./aiConfig";
import type { DrawFrame } from "./diagram";
import { importSvgScene } from "./svgImport";

/**
 * The vector specialist behind the draw tool.
 *
 * Recraft V4 Vector is the one production model that generates NATIVE SVG —
 * drawn geometry, not a traced raster — and its output converts cleanly into
 * scene paths, so a drawing it makes is as editable as one made with the pen.
 * It draws in a different class from an LLM writing path data, which is the
 * whole reason this module exists; the LLM lane stays behind it as the
 * fallback, and stays the entire lane for structured diagrams, whose labels
 * must land as text where Recraft would paint them as outlines.
 *
 * Server-only: it spends the OpenRouter key. Everything provider-specific is
 * kept in this file, verified against the live endpoint rather than the docs —
 * the images API (not chat), base64 SVG in `data[0].b64_json`, and the size
 * table below, probed value by value because the docs' "multiples of 32" is
 * not what the endpoint accepts.
 */

/** Sizes the endpoint actually accepts, probed live. Aspect is the selector. */
const SIZES: readonly { size: string; ar: number }[] = [
  { size: "1344x768", ar: 1344 / 768 },
  { size: "768x1344", ar: 768 / 1344 },
  { size: "1024x1024", ar: 1 },
  { size: "1152x896", ar: 1152 / 896 },
  { size: "896x1152", ar: 896 / 1152 },
];

function sizeFor(frame: { w: number; h: number }): string {
  const want = Math.log(frame.w / frame.h);
  let best = SIZES[0];
  for (const c of SIZES) {
    if (Math.abs(Math.log(c.ar) - want) < Math.abs(Math.log(best.ar) - want)) {
      best = c;
    }
  }
  return best.size;
}

export type VectorDrawResult = {
  html: string;
  latencyMs: number;
};

/**
 * The frame an unframed drawing gets — "draw a cat" with no board in sight.
 *
 * A scene is a scene whether or not a storyboard gave it dimensions; cover-fit
 * merely needs SOME shape to fit. 4:3 at the document column's width: wide
 * enough to sit flush in the column a diagram block occupies, tall enough that
 * a single subject is not letterboxed into a sliver.
 */
const DEFAULT_FRAME = { w: 600, h: 450 };

/**
 * One drawing from the vector model, as canonical scene markup — or null, and
 * the caller falls back to the LLM lane rather than failing the tool call.
 */
export async function generateVectorDrawing(
  brief: string,
  requested: DrawFrame,
  signal?: AbortSignal,
): Promise<VectorDrawResult | null> {
  const frame = requested ?? DEFAULT_FRAME;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
  const started = Date.now();

  let svg: string;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI.diagram.vector.model,
        prompt: brief,
        size: sizeFor(frame),
      }),
      signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: { b64_json?: string }[];
      error?: unknown;
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) return null;
    svg = Buffer.from(b64, "base64").toString("utf8");
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    return null;
  }

  const imported = importSvgScene(
    svg,
    frame,
    (html) => parseHTML(html).document as unknown as Document,
  );
  if (!imported) return null;
  if (imported.dropped && process.env.NODE_ENV !== "production") {
    console.warn(`[vector-draw] dropped ${imported.dropped} unconvertible elements`);
  }

  return {
    html: serializeScene({ ...imported.scene, id: undefined }),
    latencyMs: Date.now() - started,
  };
}
