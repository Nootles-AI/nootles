/**
 * The legacy JSON canvas shape, and the block's height rule.
 *
 * A canvas block now stores canvas HTML and the renderer reads it through
 * `scene/`; nothing here describes what is on screen any more. Two callers keep
 * it alive: the shape ops in `app/lib/ai/apply.ts`, which still speak
 * node/edge JSON and are dormant while diagram review is whole-diagram, and the
 * suggestion preview, which needs the block's height to agree with the real one.
 *
 * The types were React Flow's; they are stated here now, so removing the
 * library did not have to rewrite the applier.
 */

export type ShapeKind = "rectangle" | "ellipse" | "diamond" | "text";

export type ShapeNode = {
  id: string;
  type: "shape";
  position: { x: number; y: number };
  width?: number | null;
  height?: number | null;
  data: { label: string; shape: ShapeKind };
};

export type CanvasEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
};

export type CanvasData = {
  nodes: ShapeNode[];
  edges: CanvasEdge[];
};

export function serializeCanvas(nodes: ShapeNode[], edges: CanvasEdge[]): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "shape",
      position: n.position,
      width: n.width,
      height: n.height,
      data: { label: n.data.label ?? "", shape: n.data.shape },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
      ...(typeof e.label === "string" && e.label ? { label: e.label } : {}),
    })),
  });
}

export function parseCanvas(source: string): CanvasData {
  if (!source) return { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(source) as CanvasData;
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/** Default shape box, mirrored by the suggestion preview so both agree. */
export const SHAPE_W = 148;
export const SHAPE_H = 64;

export const CANVAS_MIN_H = 260;
const CANVAS_MAX_H = 560;
/** Breathing room under the content — enough to read as a margin, no more. */
const CANVAS_PAD = 24;

/**
 * Height a canvas should occupy for the given shapes. Used by BOTH the real
 * canvas and the faded suggestion preview so that accepting a diagram doesn't
 * snap the page height around.
 */
export function canvasHeightFor(
  nodes: Array<{ y?: number; height?: number | null }>,
): number {
  if (!nodes.length) return CANVAS_MIN_H;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const y = n.y ?? 0;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y + (n.height ?? SHAPE_H));
  }
  const content = maxY - minY;
  return Math.round(
    Math.min(CANVAS_MAX_H, Math.max(CANVAS_MIN_H, content + CANVAS_PAD)),
  );
}

/**
 * Marks a height the user set by hand. Without it there is no telling a dragged
 * 320 from the 320 the content happens to need, and the block would stop
 * growing with its diagram the first time anyone touched the grip.
 */
export const HEIGHT_ATTR = "data-height";
/** The same, for a width the user widened past the document column. */
export const WIDTH_ATTR = "data-width";
export const FIXED = "fixed";
export const CANVAS_MIN_W = 240;

/**
 * The height a canvas block takes, from the scene alone.
 *
 * Here rather than in the surface that draws it because the suggestion preview
 * has to reach the same answer: it is drawn where the block will land, so a
 * preview an inch shorter than the block is a page that jumps on Tab. One rule,
 * one place — the pinned height included, which is the half a second copy of
 * this would be most likely to forget.
 */
export function sceneBlockHeight(scene: {
  h: number;
  attrs: Record<string, string>;
  nodes: ReadonlyArray<{ y: number; h: number }>;
}): number {
  if (scene.attrs[HEIGHT_ATTR] === FIXED) return Math.max(CANVAS_MIN_H, scene.h);
  return canvasHeightFor(scene.nodes.map((node) => ({ y: node.y, height: node.h })));
}
