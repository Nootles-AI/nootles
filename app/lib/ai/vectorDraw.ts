import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { AI } from "./aiConfig";
import type { DrawFrame } from "./diagram";
import { DEFAULT_DRAW_CHOICE, MONOCHROME_STYLES, type DrawChoice } from "./drawStyles";
import { imageTarget, viaOpenRouter } from "./providers";
import { importSvgScene } from "./svgImport";

/**
 * The vector specialist behind the draw tool.
 *
 * Recraft V3 Vector generates NATIVE SVG — drawn geometry, not a traced raster
 * — and its output converts cleanly into scene paths, so a drawing it makes is
 * as editable as one made with the pen. The vector line is load-bearing, not a
 * preference: the response is decoded as text below, so a raster model returns
 * bytes `importSvgScene` cannot read. V3 rather than V4 on purpose: V3 is the
 * generation that takes a style preset and an artistic-level dial, which the
 * user sets before each batch of drawings. Price is not the reason — the V3,
 * V4 and V4.1 vector lines are all $0.08 an image. The LLM lane stays the
 * entire lane for structured diagrams, whose labels must land as text where
 * Recraft would paint them as outlines.
 *
 * Server-only: it spends whichever key `USE_OPENROUTER` selects. Everything
 * provider-specific is kept in this file. The OpenRouter wire was verified
 * against the live endpoint rather than the docs — the images API (not chat),
 * base64 SVG in `data[0].b64_json`, the `provider.options.recraft` passthrough
 * for style and controls, and the aspect-ratio enum the endpoint record
 * declares.
 *
 * The direct wire is written from Recraft's own API reference, not probed: the
 * `_vector` model ids are the ones that return SVG, `controls.artistic_level`
 * is documented [0-5] and V3-only, `response_format` takes `b64_json`, and
 * `size` accepts either `WxH` or `w:h`. The style names in `drawStyles.ts` are
 * that reference's own vector list, so they need no translation.
 */

/**
 * The frame shapes the artist accepts, and how each endpoint spells one.
 *
 * OpenRouter's endpoint record declares an aspect-ratio enum; Recraft's own API
 * takes a pixel size instead, so the same five shapes carry both spellings and
 * one nearest-ratio search serves either wire.
 */
const RATIOS: readonly { value: string; size: string; ar: number }[] = [
  { value: "1:1", size: "1024x1024", ar: 1 },
  { value: "4:3", size: "1365x1024", ar: 4 / 3 },
  { value: "3:4", size: "1024x1365", ar: 3 / 4 },
  { value: "16:9", size: "1820x1024", ar: 16 / 9 },
  { value: "9:16", size: "1024x1820", ar: 9 / 16 },
];

function ratioFor(frame: { w: number; h: number }): { value: string; size: string } {
  const want = Math.log(frame.w / frame.h);
  let best = RATIOS[0];
  for (const c of RATIOS) {
    if (Math.abs(Math.log(c.ar) - want) < Math.abs(Math.log(best.ar) - want)) {
      best = c;
    }
  }
  return best;
}

/**
 * The request, as the endpoint takes it. The brief gets the economy suffix only
 * on the unstyled default, because a chosen preset IS the style ask — "no fine
 * detail" pasted after "Engraving" would be the prompt fighting the preset.
 *
 * The two wires ask for the same four things and differ only in where they are
 * written. Through OpenRouter, style and dial ride the provider passthrough and
 * the frame is an aspect ratio; called directly they are top-level fields and
 * the frame is a pixel size, and the response has to be asked for as base64
 * rather than as a URL.
 */
export function recraftRequest(
  brief: string,
  frame: { w: number; h: number },
  choice: DrawChoice,
  wire: { model: string; direct: boolean },
): object {
  const styled = choice.style !== DEFAULT_DRAW_CHOICE.style;
  const ink = MONOCHROME_STYLES.has(choice.style);
  const shape = ratioFor(frame);
  const prompt = styled
    ? brief
    : `${brief}. Bold simple flat vector, clean shapes, no fine detail or texture.`;
  const controls = {
    artistic_level: choice.artisticLevel,
    // Stated, not implied: a brief's colour words otherwise tint a style whose
    // whole character is one ink on bare paper.
    ...(ink
      ? {
          colors: [{ rgb: [0, 0, 0] }],
          background_color: { rgb: [255, 255, 255] },
        }
      : {}),
  };

  if (wire.direct) {
    return {
      model: wire.model,
      prompt,
      size: shape.size,
      style: choice.style,
      controls,
      response_format: "b64_json",
    };
  }
  return {
    model: wire.model,
    prompt,
    aspect_ratio: shape.value,
    provider: { options: { recraft: { style: choice.style, controls } } },
  };
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
 * One drawing from the vector model, as canonical scene markup — or null. A
 * scene has no understudy: the caller answers a miss with "call again", not
 * with the LLM lane, whose drawings are not worth placing in a board.
 */
export async function generateVectorDrawing(
  brief: string,
  requested: DrawFrame,
  choice: DrawChoice = DEFAULT_DRAW_CHOICE,
  signal?: AbortSignal,
): Promise<VectorDrawResult | null> {
  const frame = requested ?? DEFAULT_FRAME;
  const { url, key, model } = imageTarget(AI.diagram.vector.model);
  const direct = !viaOpenRouter();
  const started = Date.now();

  // A silent miss here once silently changed who drew the picture; every
  // miss says why now, so the ledger and the logs tell one story.
  const miss = (why: string): null => {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[vector-draw] miss (${why}): "${brief.slice(0, 60)}"`);
    }
    return null;
  };

  // A board fires nine of these at once, which is exactly the shape rate
  // limits and connection churn are made of — and the artist has no
  // understudy any more (a scene that misses stays missed until retried),
  // so patience is the reliability budget: four tries, backing off.
  const backoffMs = [2_000, 5_000, 10_000];
  let svg: string | null = null;
  for (let attempt = 0; attempt <= backoffMs.length && svg === null; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(recraftRequest(brief, frame, choice, { model, direct })),
        signal,
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < backoffMs.length) {
          await new Promise((r) => setTimeout(r, backoffMs[attempt]));
          continue;
        }
        return miss(`http ${res.status}`);
      }
      if (!res.ok) return miss(`http ${res.status}`);
      const json = (await res.json()) as { data?: { b64_json?: string }[] };
      const b64 = json.data?.[0]?.b64_json;
      if (!b64) return miss("no image in response");
      svg = Buffer.from(b64, "base64").toString("utf8");
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      if (attempt < backoffMs.length) {
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
        continue;
      }
      return miss(String((error as Error).message ?? error).slice(0, 80));
    }
  }
  if (svg === null) return miss("exhausted retries");

  const imported = importSvgScene(
    svg,
    frame,
    (html) => parseHTML(html).document as unknown as Document,
    // The brief's opening clause names the layer — "Close on the detective".
    brief.split(/[,.;—\n]/)[0].trim().slice(0, 48) || "Drawing",
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
