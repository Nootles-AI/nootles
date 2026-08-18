import { parseHTML } from "linkedom";
import { serializeScene } from "@/app/components/editor/canvas/scene/serialize";
import { AI } from "./aiConfig";
import type { DrawFrame } from "./diagram";
import { DEFAULT_DRAW_CHOICE, MONOCHROME_STYLES, type DrawChoice } from "./drawStyles";
import { importSvgScene } from "./svgImport";

/**
 * The vector specialist behind the draw tool.
 *
 * Recraft V3 generates NATIVE SVG — drawn geometry, not a traced raster — and
 * its output converts cleanly into scene paths, so a drawing it makes is as
 * editable as one made with the pen. V3 rather than V4 on purpose: V3 is the
 * generation that takes a style preset and an artistic-level dial, which the
 * user now sets before each batch of drawings, and it costs half as much per
 * image. The LLM lane stays the entire lane for structured diagrams, whose
 * labels must land as text where Recraft would paint them as outlines.
 *
 * Server-only: it spends the OpenRouter key. Everything provider-specific is
 * kept in this file, verified against the live endpoint rather than the docs —
 * the images API (not chat), base64 SVG in `data[0].b64_json`, the
 * `provider.options.recraft` passthrough for style and controls, and the
 * aspect-ratio enum the endpoint record declares.
 */

/** The ratios the endpoint accepts, from its own endpoint record. */
const RATIOS: readonly { value: string; ar: number }[] = [
  { value: "1:1", ar: 1 },
  { value: "4:3", ar: 4 / 3 },
  { value: "3:4", ar: 3 / 4 },
  { value: "16:9", ar: 16 / 9 },
  { value: "9:16", ar: 9 / 16 },
];

function ratioFor(frame: { w: number; h: number }): string {
  const want = Math.log(frame.w / frame.h);
  let best = RATIOS[0];
  for (const c of RATIOS) {
    if (Math.abs(Math.log(c.ar) - want) < Math.abs(Math.log(best.ar) - want)) {
      best = c;
    }
  }
  return best.value;
}

/**
 * The request, as the endpoint takes it. Style and dial ride the provider
 * passthrough; the brief gets the economy suffix only on the unstyled default,
 * because a chosen preset IS the style ask — "no fine detail" pasted after
 * "Engraving" would be the prompt fighting the preset.
 */
export function recraftRequest(
  brief: string,
  frame: { w: number; h: number },
  choice: DrawChoice,
): object {
  const styled = choice.style !== DEFAULT_DRAW_CHOICE.style;
  const ink = MONOCHROME_STYLES.has(choice.style);
  return {
    model: AI.diagram.vector.model,
    prompt: styled
      ? brief
      : `${brief}. Bold simple flat vector, clean shapes, no fine detail or texture.`,
    aspect_ratio: ratioFor(frame),
    provider: {
      options: {
        recraft: {
          style: choice.style,
          controls: {
            artistic_level: choice.artisticLevel,
            // Stated, not implied: a brief's colour words otherwise tint a
            // style whose whole character is one ink on bare paper.
            ...(ink
              ? {
                  colors: [{ rgb: [0, 0, 0] }],
                  background_color: { rgb: [255, 255, 255] },
                }
              : {}),
          },
        },
      },
    },
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
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set");
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
      const res = await fetch("https://openrouter.ai/api/v1/images/generations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(recraftRequest(brief, frame, choice)),
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
