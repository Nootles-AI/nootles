/**
 * A small force layout for the context view — in-house, like the canvas, and
 * sized for what a project holds (hundreds of nodes, not millions).
 *
 * Four forces: springs along the lines, repulsion between nearby bodies
 * (bucketed on a grid, so it stays near-linear), gravity toward the centre,
 * and a collision pass on the bodies' real boxes, so labels never overlap.
 * Everything is deterministic: the same graph lays out the same way every
 * time it is opened, which is what lets a person learn where things are.
 */

export type Body = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** The node's measured box, centred on (x, y). */
  w: number;
  h: number;
  /** Held in place — the hub always, a node while it is being dragged. */
  pinned: boolean;
};

export type Spring = { a: number; b: number; length: number; strength: number };

const CHARGE = 16000;
const CELL = 340;
const GRAVITY = 0.006;
const VELOCITY_DECAY = 0.42;
const GAP = 16;
const ALPHA_MIN = 0.004;
/** From 1 to ALPHA_MIN in about 300 steps. */
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);

export class Layout {
  alpha = 1;
  private degree: number[];

  constructor(
    readonly bodies: Body[],
    readonly springs: Spring[],
  ) {
    this.degree = bodies.map(() => 0);
    for (const s of springs) {
      this.degree[s.a]++;
      this.degree[s.b]++;
    }
  }

  get settled(): boolean {
    return this.alpha < ALPHA_MIN;
  }

  reheat(to: number) {
    this.alpha = Math.max(this.alpha, to);
  }

  /** One step. Answers whether anything is still moving. */
  step(): boolean {
    if (this.settled) return false;
    const { bodies, alpha } = this;

    for (const s of this.springs) {
      const a = bodies[s.a];
      const b = bodies[s.b];
      const dx = b.x + b.vx - a.x - a.vx || 0.01;
      const dy = b.y + b.vy - a.y - a.vy || 0.01;
      const d = Math.hypot(dx, dy);
      const f = ((d - s.length) / d) * s.strength * alpha;
      // The busier end moves less, so a hub is not dragged about by its leaves.
      const bias = this.degree[s.a] / (this.degree[s.a] + this.degree[s.b]);
      b.vx -= dx * f * bias;
      b.vy -= dy * f * bias;
      a.vx += dx * f * (1 - bias);
      a.vy += dy * f * (1 - bias);
    }

    const grid = new Map<string, number[]>();
    const cellOf = (b: Body) => [Math.floor(b.x / CELL), Math.floor(b.y / CELL)];
    bodies.forEach((b, i) => {
      const [cx, cy] = cellOf(b);
      const key = `${cx},${cy}`;
      (grid.get(key) ?? grid.set(key, []).get(key)!).push(i);
    });
    bodies.forEach((a, i) => {
      const [cx, cy] = cellOf(a);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(`${gx},${gy}`) ?? []) {
            if (j <= i) continue;
            const b = bodies[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            if (dx === 0 && dy === 0) {
              dx = (i % 2 ? 1 : -1) * 0.5;
              dy = (j % 2 ? 1 : -1) * 0.5;
            }
            const d2 = Math.max(dx * dx + dy * dy, 400);
            const f = (CHARGE * alpha) / d2 / Math.sqrt(d2);
            a.vx -= dx * f;
            a.vy -= dy * f;
            b.vx += dx * f;
            b.vy += dy * f;

            // Boxes, not circles: labels are wide, and a circle round one
            // either overlaps its neighbours or pushes them absurdly far.
            const ox = (a.w + b.w) / 2 + GAP - Math.abs(dx);
            const oy = (a.h + b.h) / 2 + GAP - Math.abs(dy);
            if (ox > 0 && oy > 0 && !(a.pinned && b.pinned)) {
              // Apart along the shallower axis; a pinned body does not give.
              const aGives = a.pinned ? 0 : b.pinned ? 1 : 0.5;
              if (ox < oy) {
                const sign = Math.sign(dx) || 1;
                a.x -= ox * sign * aGives;
                b.x += ox * sign * (1 - aGives);
              } else {
                const sign = Math.sign(dy) || 1;
                a.y -= oy * sign * aGives;
                b.y += oy * sign * (1 - aGives);
              }
            }
          }
        }
      }
    });

    let moving = false;
    for (const b of bodies) {
      if (b.pinned) {
        b.vx = b.vy = 0;
        continue;
      }
      b.vx -= b.x * GRAVITY * alpha;
      b.vy -= b.y * GRAVITY * alpha;
      b.vx *= 1 - VELOCITY_DECAY;
      b.vy *= 1 - VELOCITY_DECAY;
      b.x += b.vx;
      b.y += b.vy;
      if (Math.abs(b.vx) + Math.abs(b.vy) > 0.02) moving = true;
    }
    this.alpha *= 1 - ALPHA_DECAY;
    return moving || !this.settled;
  }

  /** Runs to rest, or for `steps` steps — the part of the settle nobody watches. */
  run(steps = Infinity) {
    for (let i = 0; i < steps && !this.settled; i++) this.step();
  }

  bounds(): { x: number; y: number; w: number; h: number } {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of this.bodies) {
      x0 = Math.min(x0, b.x - b.w / 2);
      y0 = Math.min(y0, b.y - b.h / 2);
      x1 = Math.max(x1, b.x + b.w / 2);
      y1 = Math.max(y1, b.y + b.h / 2);
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
}

/**
 * Where a body starts: a radial tree. The project's own children fan evenly
 * round it; a folder's children fan outward beyond the folder, away from the
 * project, so every folder starts as its own cluster and lines start out not
 * crossing. The layout refines from there. Seeded by position and id alone,
 * so the same project always starts — and settles — the same way.
 */
export function startAt(
  id: string,
  index: number,
  count: number,
  parent: { x: number; y: number } | undefined,
  grand: { x: number; y: number } | undefined,
): { x: number; y: number } {
  if (!parent) return { x: 0, y: 0 };
  const jitter = (hash(id) - 0.5) * 0.08;
  if (!grand) {
    const angle = (index / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2 + jitter;
    const r = 200 + 14 * count;
    return { x: parent.x + r * Math.cos(angle), y: parent.y + r * Math.sin(angle) };
  }
  const out = Math.atan2(parent.y - grand.y, parent.x - grand.x);
  const spread = Math.min(Math.PI * 0.95, 0.42 * count);
  const angle = out + (count > 1 ? (index / (count - 1) - 0.5) * spread : 0) + jitter;
  const r = 120 + 6 * count;
  return { x: parent.x + r * Math.cos(angle), y: parent.y + r * Math.sin(angle) };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
