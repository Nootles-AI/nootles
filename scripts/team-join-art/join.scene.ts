import { readFileSync } from 'node:fs';
import {
  character, part, svgShape, mask, clipPath, linearGradient, radialGradient, keys, sampled, cueSheet, within,
  rect, circle, ellipse, path, easeInOut, easeOut, easeIn, linear, cubicBezier,
} from './heron/src/index.ts';
import type { Channel, MaskRef, Vec2 } from './heron/src/index.ts';

/**
 * The team, joining: six teammates arriving in an empty Nootles workspace,
 * rigged and animated in Heron.
 *
 * `art.json` is the six characters as data (see `extract.mjs`); this file
 * rebuilds each exactly, rigs it from its own paths, sets them on one page and
 * brings them in one at a time. Check and build with
 *
 *   node scripts/team-join-art/heron/src/cli.ts check "$PWD/scripts/team-join-art/join.scene.ts" --fps 30
 *   node scripts/team-join-art/heron/src/cli.ts build "$PWD/scripts/team-join-art/join.scene.ts" \
 *     -o public/team/join.svg --fps 30
 *
 * `heron` is a symlink to the installed Heron skill (github.com/iforaa/heron,
 * MIT), not committed; Heron resolves a relative scene path against its own
 * folder, hence `$PWD`.
 *
 * The rest pose is the finished picture — everyone in place, the plan ticked
 * off, the chart drawn — so that with motion reduced, where the film does not
 * play, the still says the same thing. Every character is its artist's paths
 * in the artist's paint order, grouped into parts that turn about the joints
 * those paths meet at; where a limb paints on both sides of the body (an arm
 * behind it, the thing it holds in front), it is split into two stacks that
 * carry identical motion.
 */

// ---- The art ------------------------------------------------------------------

type Attrs = Record<string, string>;
type Box = [number, number, number, number];
type Shape = { t: 's'; tag: string; a: Attrs; bb: Box; id?: string };
type Group = { t: 'g'; id?: string; mask?: string; c: Node[]; bb: Box };
type Node = Shape | Group;
interface Figure {
  viewBox: [number, number, number, number];
  defs: {
    masks: { id: string; region: Box; shapes: { tag: string; a: Attrs }[] }[];
    gradients: {
      id: string; x1: number; y1: number; x2: number; y2: number; units: string; transform?: string;
      stops: { at: number; color: string; opacity?: number }[];
    }[];
  };
  tree: Node[];
}
type Key6 = 'pm' | 'design' | 'dev' | 'marketing' | 'stats' | 'customerSuccess';
const ART: Record<Key6, Figure> = JSON.parse(readFileSync(new URL('./art.json', import.meta.url), 'utf8'));

const VIEW: [number, number, number, number] = [0, 0, 1320, 1320];
const D = 13;
const FADE: [number, number] = [12.3, 12.8];

const INK = '#37352f';
const GHOST = '#ecebe7';
const RULE = '#e3e1dc';

let MASKS = new Map<string, MaskRef>();
function definitions(): void {
  MASKS = new Map();
  for (const f of Object.values(ART)) {
    for (const g of f.defs.gradients) {
      linearGradient(g.id, {
        x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
        units: g.units as 'userSpaceOnUse',
        transform: g.transform,
        stops: g.stops.map((s) => ({ at: s.at, color: s.color, ...(s.opacity === undefined ? {} : { opacity: s.opacity }) })),
      });
    }
    for (const m of f.defs.masks) {
      const [x, y, width, height] = m.region;
      MASKS.set(m.id, mask(m.id, () => m.shapes.forEach((s) => svgShape(s.tag, s.a)),
        { units: 'userSpaceOnUse', region: { x, y, width, height } }));
    }
  }
}

let unnamed = 0;
/** Draws a node exactly as drawn: groups become parts, keeping their masks. */
function draw(n: Node): void {
  if (n.t === 's') {
    // The one raster in the set: the soft shadow the navigator's hand casts
    // on the map, painted as the blur it is.
    if (n.tag === 'image') {
      ellipse({ cx: 84, cy: 290, rx: 30, ry: 24, fill: HAND_SHADOW! });
      return;
    }
    svgShape(n.tag, n.a);
    return;
  }
  part(`g${++unnamed}`, n.mask ? { mask: MASKS.get(n.mask)! } : {}, () => n.c.forEach(draw));
}
let HAND_SHADOW: ReturnType<typeof radialGradient> | undefined;

/** A node by its index in the drawing, or by an index into one of its groups. */
type Ref = number | [number, number];
const nodeOf = (f: Figure, r: Ref): Node => (typeof r === 'number' ? f.tree[r] : (f.tree[r[0]] as Group).c[r[1]]);

// ---- Time -----------------------------------------------------------------------

type Ease = Parameters<typeof keys>[0][number][2];
type Key = [seconds: number, value: number, ease?: Ease];
/**
 * Keys in seconds. The value holds before the first; after the last it holds
 * until everything has faded, then returns to where it started, unseen, so the
 * next take begins from the same pose.
 */
function at(list: Key[]): Channel {
  const sorted = [...list].sort((a, b) => a[0] - b[0])
    .filter((k, i, all) => i === all.length - 1 || all[i + 1][0] !== k[0]);
  const first = sorted[0][1];
  const last = sorted[sorted.length - 1];
  if (last[1] !== first && last[0] < D) {
    if (last[0] < FADE[1] + 0.05) sorted.push([FADE[1] + 0.05, last[1]]);
    sorted.push([D, first]);
  }
  const rows: Parameters<typeof keys>[0] = [];
  if (sorted[0][0] > 0) rows.push([0, sorted[0][1]]);
  for (const [s, v, e] of sorted) rows.push(e ? [s / D, v, e] : [s / D, v]);
  if (sorted[sorted.length - 1][0] < D) rows.push([1, sorted[sorted.length - 1][1]]);
  return keys(rows);
}
let windows = 0;
/** A procedural curve in seconds over [t0, t1], held either side. */
function over(t0: number, t1: number, fn: (s: number, u: number) => number, perSecond = 30): Channel {
  const b = cueSheet(D, { [`w${++windows}`]: [t0, t1] }).at(`w${windows}`);
  return within(b, sampled((u) => fn(u * b.seconds, u), Math.max(2, Math.ceil(b.seconds * perSecond))));
}
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const pop = cubicBezier(0.3, 1.35, 0.5, 1);
/** Loop-safe wobble: a whole number of cycles in the film. */
const wobble = (amp: number, cycles: number, phase = 0) =>
  sampled((u) => amp * Math.sin(2 * Math.PI * (u * cycles + phase)), Math.max(48, cycles * 12));
/** Blinks at the given seconds, each a quick close and open. */
const blinks = (times: number[]): Channel =>
  at([[0, 1], ...times.flatMap((t): Key[] => [[t, 1, easeIn], [t + 0.07, 0.1, easeOut], [t + 0.16, 1]])]);

// ---- The page -------------------------------------------------------------------

const SHEET = { x: 30, y: 30, w: 1260, h: 1260 };
const TITLE = { x: 96, y: 92, w: 360, h: 30 };
const ROWS = [0, 1, 2].map((i) => ({ y: 178 + i * 46, w: [330, 260, 300][i] }));
const BOX = 24;
const PILE = { x: 1010, y: 107, r: 24, step: 42 };

/** Who is in the workspace, left to right in the order they arrive. */
const CREW: { key: Key6; name: string; fill: string; eye: string }[] = [
  { key: 'pm', name: 'pm', fill: '#aac3f9', eye: '#3f5a95' },
  { key: 'design', name: 'design', fill: '#ffcc62', eye: '#856219' },
  { key: 'dev', name: 'dev', fill: '#65afff', eye: '#0c3651' },
  { key: 'marketing', name: 'marketing', fill: '#884ed3', eye: '#231634' },
  { key: 'stats', name: 'stats', fill: '#7bd5a3', eye: '#1b5334' },
  { key: 'customerSuccess', name: 'cs', fill: '#f68ea0', eye: '#4d1720' },
];

function page(): void {
  rect({ x: SHEET.x, y: SHEET.y, w: SHEET.w, h: SHEET.h, radius: 30, fill: '#ffffff', stroke: RULE, width: 3 });
  // The workspace's name, and the faces of who is in it: empty seats for now.
  rect({ x: TITLE.x, y: TITLE.y, w: TITLE.w, h: TITLE.h, radius: 15, fill: INK });
  CREW.forEach((_, i) => circle({ cx: PILE.x + i * PILE.step, cy: PILE.y, r: PILE.r - 1.5, stroke: RULE, width: 3 }));
  line(96, 150, 1224);
}
function line(x0: number, y: number, x1: number) {
  rect({ x: x0, y: y - 1.5, w: x1 - x0, h: 3, radius: 1.5, fill: '#f1f0ec' });
}

/** The plan: three items, each a box to tick and a line of text. */
function plan(): void {
  ROWS.forEach((row, i) => {
    part(`item${i}`, { pivot: [TITLE.x, row.y] }, () => {
      part(`box${i}`, { pivot: [TITLE.x + BOX / 2, row.y] }, () => {
        rect({ x: TITLE.x, y: row.y - BOX / 2, w: BOX, h: BOX, radius: 6, fill: '#ffffff', stroke: '#c9c7c1', width: 2.5 });
      });
      part(`text${i}`, { pivot: [TITLE.x + 44, row.y] }, () => {
        rect({ x: TITLE.x + 44, y: row.y - 7, w: row.w, h: 14, radius: 7, fill: GHOST });
      });
      part(`tick${i}`, { pivot: [TITLE.x + BOX / 2, row.y] }, () => {
        const x = TITLE.x;
        const y = row.y - BOX / 2;
        path({ d: `M${x + 5.5} ${y + 12.5} L${x + 10.5} ${y + 17.5} L${x + 19} ${y + 6.5}`, stroke: INK, width: 3.6 });
      });
    });
  });
}

/** Each face in the pile: the teammate's own colour and eyes, in a white ring. */
function faces(): void {
  CREW.forEach((c, i) => {
    const cx = PILE.x + i * PILE.step;
    part(`face${i}`, { pivot: [cx, PILE.y] }, () => {
      circle({ cx, cy: PILE.y, r: PILE.r, fill: c.fill, stroke: '#ffffff', width: 4 });
      ellipse({ cx: cx - 6, cy: PILE.y - 1, rx: 2.6, ry: 4.2, fill: c.eye });
      ellipse({ cx: cx + 6, cy: PILE.y - 1, rx: 2.6, ry: 4.2, fill: c.eye });
    });
  });
}

// ---- The cast -------------------------------------------------------------------

/**
 * One piece of a character: nodes of its drawing, in the drawing's order,
 * made a part turning about `pivot`. A leg is the root's own child; everything
 * else rides a `…Bob` wrapper about the hips, so the upper body can bob and
 * lean over legs that stay planted.
 */
type Piece = { name: string; refs: Ref[]; pivot?: Vec2; leg?: boolean; contact?: Vec2; inner?: () => void };
/**
 * A character set on the page: `place` is where its drawing's origin goes, and
 * `root` the point between its feet that it hops and squashes about.
 */
function figure(key: Key6, name: string, place: Vec2, root: Vec2, hips: Vec2, pieces: Piece[]): void {
  const f = ART[key];
  part(name, { pivot: root, offstage: true, transform: { x: place[0], y: place[1] } }, () => {
    for (const p of pieces) {
      const body = () => {
        p.refs.forEach((r) => draw(nodeOf(f, r)));
        p.inner?.();
      };
      if (p.leg) part(p.name, { pivot: p.pivot!, ...(p.contact ? { contact: p.contact } : {}) }, body);
      else part(`${p.name}Bob`, { pivot: hips }, () => (p.pivot ? part(p.name, { pivot: p.pivot }, body) : body()));
    }
  });
}

// Where each drawing's origin sits on the page. Back row stands on y 770,
// front row on y 1250.
const PLACE: Record<string, Vec2> = {
  stats: [50, 770 - 413],
  board: [50, 770 - 413],
  marketing: [569, 770 - 318],
  pm: [905, 770 - 413],
  dev: [110, 1250 - 349],
  design: [485, 1250 - 248],
  cs: [990, 1250 - 340],
};

// The marketer's shout, drawn from the megaphone's bell outward.
const BELL: Vec2 = [44, 199];
const BELL_DIR = Math.atan2(0.86, -0.52);
function soundArcs(): void {
  [22, 38, 54].forEach((r, i) => {
    const a0 = BELL_DIR - 0.55;
    const a1 = BELL_DIR + 0.55;
    const p = (a: number) => `${(BELL[0] + r * Math.cos(a)).toFixed(1)} ${(BELL[1] + r * Math.sin(a)).toFixed(1)}`;
    part(`arc${i}`, { pivot: BELL }, () =>
      path({ d: `M${p(a0)} A${r} ${r} 0 0 1 ${p(a1)}`, stroke: INK, width: 4 }));
  });
}
// The heart over the support rep's head, in its own drawing's frame.
const HEART: Vec2 = [124, -6];
function heart(): void {
  const [x, y] = HEART;
  part('heart', { pivot: [x, y + 14] }, () =>
    path({
      d: `M${x} ${y + 16} C${x - 4} ${y + 12} ${x - 20} ${y + 3} ${x - 20} ${y - 8} C${x - 20} ${y - 16} ${x - 10} ${y - 20} ${x} ${y - 11}`
        + ` C${x + 10} ${y - 20} ${x + 20} ${y - 16} ${x + 20} ${y - 8} C${x + 20} ${y + 3} ${x + 4} ${y + 12} ${x} ${y + 16} Z`,
      fill: '#f45d78',
    }));
}

export const team = character('join', { viewBox: VIEW, duration: D }, () => {
  definitions();
  HAND_SHADOW = radialGradient('pm-hand-shadow', {
    stops: [{ at: 0, color: '#3a1300', opacity: 0.45 }, { at: 0.6, color: '#3a1300', opacity: 0.18 }, { at: 1, color: '#3a1300', opacity: 0 }],
  });
  page();
  part('plan', plan);
  part('faces', faces);

  // Everyone arrives into the page, not onto it from the desk around it.
  const sheet = clipPath('sheet', () => rect({ x: SHEET.x, y: SHEET.y, w: SHEET.w, h: SHEET.h, radius: 30, fill: '#000' }));
  part('cast', { clip: sheet }, () => {
    // -- Back row --
    // The board and the stool are the analyst's, and arrive before it does.
    const st = ART.stats;
    part('board', { pivot: [307, 405], transform: { x: PLACE.board[0], y: PLACE.board[1] } }, () => {
      draw(nodeOf(st, [0, 0]));
      draw(nodeOf(st, [0, 1]));
      part('chart', () => draw(nodeOf(st, [0, 2])));
      draw(nodeOf(st, [0, 3]));
      draw(nodeOf(st, [0, 4]));
    });
    part('stool', { pivot: [134, 409], transform: { x: PLACE.stats[0], y: PLACE.stats[1] } }, () => draw(nodeOf(st, 1)));
    figure('stats', 'stats', PLACE.stats, [132, 288], [132, 230], [
      { name: 'legR', refs: [2], pivot: [158, 214] },
      { name: 'legL', refs: [3], pivot: [110, 214] },
      { name: 'pointerBack', refs: [4], pivot: [178, 198] },
      { name: 'armL', refs: [5], pivot: [90, 168] },
      { name: 'pointer', refs: [6], pivot: [178, 198] },
      { name: 'antR', refs: [[7, 0], [7, 1]], pivot: [136, 112] },
      { name: 'antL', refs: [[7, 2], [7, 3]], pivot: [104, 118] },
      { name: 'body', refs: [8] },
      { name: 'eyes', refs: [9], pivot: [151, 146] },
    ]);

    const mk = ART.marketing;
    part('chair', { pivot: [194, 318], transform: { x: PLACE.marketing[0], y: PLACE.marketing[1] } }, () => draw(nodeOf(mk, 0)));
    figure('marketing', 'marketing', PLACE.marketing, [195, 206], [195, 200], [
      { name: 'armRBack', refs: [1], pivot: [250, 118] },
      { name: 'earR', refs: [[2, 0], [2, 1]], pivot: [222, 72] },
      { name: 'earL', refs: [[2, 2], [2, 3]], pivot: [166, 72] },
      { name: 'body', refs: [3] },
      { name: 'feet', refs: [4], pivot: [195, 180] },
      { name: 'megaBack', refs: [5], pivot: [140, 120] },
      { name: 'armR', refs: [[6, 0]], pivot: [250, 118] },
      { name: 'eyes', refs: [[6, 1], [6, 2]], pivot: [193, 123] },
      { name: 'mega', refs: [7, 8], pivot: [140, 120], inner: soundArcs },
    ]);

    figure('pm', 'pm', PLACE.pm, [171, 413], [171, 340], [
      { name: 'legR', refs: [0], pivot: [204, 336], contact: [204, 413], leg: true },
      { name: 'legL', refs: [1], pivot: [140, 336], contact: [140, 413], leg: true },
      { name: 'armR', refs: [2], pivot: [222, 222], inner: () => {
        part('compass', { pivot: [283, 288] }, () => draw(nodeOf(ART.pm, 3)));
        draw(nodeOf(ART.pm, 4));
      } },
      { name: 'body', refs: [5] },
      { name: 'eyes', refs: [6], pivot: [159, 177] },
      { name: 'antenna', refs: [7], pivot: [174, 94] },
      { name: 'mapArm', refs: [8, 9, 10], pivot: [124, 212] },
    ]);

    // -- Front row --
    figure('dev', 'dev', PLACE.dev, [148, 349], [142, 288], [
      { name: 'legR', refs: [0], pivot: [170, 286], contact: [186, 348], leg: true },
      { name: 'legL', refs: [1], pivot: [116, 286], contact: [112, 349], leg: true },
      { name: 'armR', refs: [2], pivot: [196, 190] },
      { name: 'hammerBack', refs: [3], pivot: [108, 196] },
      { name: 'antL', refs: [[4, 0], [4, 1]], pivot: [150, 104] },
      { name: 'antR', refs: [[4, 2]], pivot: [186, 114] },
      { name: 'body', refs: [5] },
      { name: 'eyes', refs: [6], pivot: [124, 143] },
      { name: 'hammer', refs: [7, 8], pivot: [108, 196] },
    ]);

    figure('design', 'design', PLACE.design, [187, 248], [187, 196], [
      { name: 'legR', refs: [0], pivot: [218, 196], contact: [218, 248], leg: true },
      { name: 'legL', refs: [1], pivot: [155, 196], contact: [155, 248], leg: true },
      { name: 'paletteBack', refs: [2], pivot: [246, 134] },
      { name: 'brushBack', refs: [3], pivot: [138, 134] },
      { name: 'body', refs: [4] },
      { name: 'eyes', refs: [5], pivot: [190, 149] },
      { name: 'antenna', refs: [6], pivot: [208, 90] },
      { name: 'hat', refs: [7], pivot: [176, 100] },
      { name: 'palette', refs: [9, 10], pivot: [246, 134] },
      { name: 'brush', refs: [8, 11], pivot: [138, 134] },
    ]);

    figure('customerSuccess', 'cs', PLACE.cs, [126, 340], [126, 286], [
      { name: 'legL', refs: [[0, 0]], pivot: [95, 284], contact: [95, 340], leg: true },
      { name: 'legR', refs: [[0, 1]], pivot: [156, 284], contact: [156, 340], leg: true },
      { name: 'shade', refs: [[0, 2]] },
      { name: 'armR', refs: [1], pivot: [182, 178] },
      { name: 'body', refs: [2] },
      { name: 'wave', refs: [3], pivot: [84, 166] },
      { name: 'laptop', refs: [4] },
      { name: 'eyes', refs: [5], pivot: [125, 145] },
      { name: 'headset', refs: [6] },
      { name: 'earL', refs: [[7, 0], [7, 1]], pivot: [100, 97] },
      { name: 'earR', refs: [[7, 2], [7, 3]], pivot: [147, 97] },
      { name: 'heart', refs: [], inner: heart },
    ]);
  });
});

// ---- Choreography ---------------------------------------------------------------

const P = (path: string) => team.part(path);

// Everyone and everything they brought leaves together, and returns for the
// next take; the page itself stays.
const present = at([[0, 0], [0.15, 0], [0.4, 1], [FADE[0], 1, easeIn], [FADE[1], 0]]);
P('cast').animate({ opacity: present });
P('plan').animate({ opacity: present });
P('faces').animate({ opacity: present });

/** A face joins the pile: popped in with a little overshoot. */
function join(i: number, t: number) {
  P(`faces.face${i}`).animate({
    scaleX: at([[0, 0], [t, 0, pop], [t + 0.32, 1]]),
    scaleY: at([[0, 0], [t, 0, pop], [t + 0.32, 1]]),
  });
}
/** A box ticked: the stroke drawn through in one quick motion. */
function tick(i: number, t: number) {
  P(`plan.item${i}.tick${i}`).animate({ draw: at([[0, 0], [t, 0, easeInOut], [t + 0.22, 1]]) });
  P(`plan.item${i}.box${i}`).animate({
    scaleX: at([[0, 1], [t, 1, easeOut], [t + 0.08, 0.86, easeInOut], [t + 0.26, 1]]),
    scaleY: at([[0, 1], [t, 1, easeOut], [t + 0.08, 0.86, easeInOut], [t + 0.26, 1]]),
  });
}
/**
 * A hop, as a layer of its own on the root: crouch, spring, hang, land with
 * give. `height` 0 is only the landing — a squash as the weight arrives.
 */
function hop(path: string, t: number, height: number, give = 1) {
  const crouch = 0.14;
  const air = height ? 0.36 : 0;
  const land = t + crouch + air;
  const k = (vals: [number, number, number, number, number, number]): Key[] => [
    [0, vals[0]],
    [t, vals[0], easeOut],
    [t + crouch, vals[1], easeOut],
    [t + crouch + air / 2, vals[2], easeIn],
    [land, vals[3], easeOut],
    [land + 0.1, vals[4], easeInOut],
    [land + 0.3, vals[5]],
  ];
  P(path).animate({
    y: at(k([0, 4 * give, -height, 0, 3 * give, 0])),
    scaleY: at(k([1, 1 - 0.07 * give, 1.04, 1, 1 - 0.1 * give, 1])),
    scaleX: at(k([1, 1 + 0.05 * give, 0.97, 1, 1 + 0.07 * give, 1])),
  });
}

// ---- Walking --------------------------------------------------------------------

interface Leg { path: string; hip: Vec2; foot: Vec2; phase: number }
/**
 * A walk onto the page on stubby, knee-less legs. The walker travels at a
 * steady speed; each leg's stance rotation is solved so its foot stays where it
 * was set down while the body passes over it, and the swing leg lifts clear.
 */
function walk(o: { t0: number; t1: number; walker: string; from: number; legs: Leg[]; bob: string[]; step: number; lift?: number }) {
  const dur = o.t1 - o.t0;
  const v = -o.from / dur;
  const S = 0.5;
  const T = o.step;
  const H = o.lift ?? 8;
  const dir = Math.sign(v);
  P(o.walker).animate({ x: at([[0, o.from], [o.t0, o.from, linear], [o.t1, 0]]) });
  const env = (s: number) => Math.min(1, Math.max(0, s / 0.22), Math.max(0, (dur - s) / 0.22));
  for (const leg of o.legs) {
    const L = leg.foot[1] - leg.hip[1];
    const sinA = Math.min(0.6, Math.abs(v) * S * T / (2 * L));
    const A = Math.asin(sinA);
    const phase = (s: number) => ((s / T) + leg.phase) % 1;
    P(leg.path).animate({
      rotate: over(o.t0, o.t1, (s) => {
        const p = phase(s);
        const th = p < S
          ? Math.asin(Math.max(-1, Math.min(1, -dir * sinA + v * (p * T) / L)))
          : dir * A * (1 - 2 * smooth((p - S) / (1 - S)));
        return (th * 180 / Math.PI) * env(s);
      }, 40),
      y: over(o.t0, o.t1, (s) => {
        const p = phase(s);
        return p < S ? 0 : -H * Math.sin(Math.PI * (p - S) / (1 - S)) * env(s);
      }, 40),
    });
  }
  for (const b of o.bob) {
    P(b).animate({
      y: over(o.t0, o.t1, (s) => -5 * (0.5 - 0.5 * Math.cos(4 * Math.PI * s / T)) * env(s), 40),
      rotate: over(o.t0, o.t1, (s) => 2.4 * Math.sin(2 * Math.PI * s / T) * env(s), 40),
    });
    // Arriving with weight: the body carries on past the stop and comes back.
    P(b).animate({
      rotate: at([[0, 0], [o.t1 - 0.05, 0, easeOut], [o.t1 + 0.12, 5 * dir, easeInOut], [o.t1 + 0.32, -1.6 * dir, easeInOut], [o.t1 + 0.52, 0]]),
    });
  }
}
const bobs = (who: string, names: string[]) => names.map((n) => `cast.${who}.${n}Bob`);

// ---- The film -------------------------------------------------------------------
// One by one, each the way their work goes: the navigator walks in and holds
// up the plan; the designer drops in and flourishes a brush; the developer
// walks in and hammers the first item home; the marketer's chair springs up,
// it drops into it and calls out through the megaphone; the analyst's board
// and stool arrive, it hops up and points out the chart as it draws; the
// support rep walks in with a heart and a wave. Then all six hop together, the
// last item ticks, a breath, and out.

const T = {
  pm: [0.3, 2.1], design: 2.75, dev: [3.5, 5.1], chair: 5.55, marketing: 6.0,
  board: 7.1, stats: 7.55, cs: [8.9, 10.4], cheer: 11.25,
} as const;

// -- The navigator. --
{
  const [t0, t1] = T.pm;
  walk({
    t0, t1, walker: 'cast.pm', from: 480, step: 0.36, lift: 9,
    legs: [
      { path: 'cast.pm.legR', hip: [204, 336], foot: [204, 413], phase: 0 },
      { path: 'cast.pm.legL', hip: [140, 336], foot: [140, 413], phase: 0.5 },
    ],
    bob: bobs('pm', ['armR', 'body', 'eyes', 'antenna', 'mapArm']),
  });
  join(0, t1);
  // Holding the plan up for everyone to see, as it appears on the page.
  const up = t1 + 0.3;
  P('cast.pm.mapArmBob.mapArm').animate({
    rotate: at([[0, 0], [up, 0, easeInOut], [up + 0.35, 58, easeOut], [up + 0.55, 52, easeInOut], [up + 1.4, 52, easeInOut], [up + 1.85, 0]]),
  });
  ROWS.forEach((_, i) => {
    const t = up + 0.3 + i * 0.16;
    P(`plan.item${i}.box${i}`).animate({
      scaleX: at([[0, 0], [t, 0, pop], [t + 0.3, 1]]),
      scaleY: at([[0, 0], [t, 0, pop], [t + 0.3, 1]]),
    });
    P(`plan.item${i}.text${i}`).animate({ scaleX: at([[0, 0], [t + 0.08, 0, easeInOut], [t + 0.42, 1]]) });
  });
  // The compass swings on its ring from the walk, and settles.
  const walking = (s: number) => Math.min(1, s / 0.3);
  P('cast.pm.armRBob.armR').animate({ rotate: over(t0, t1 + 0.6, (s) => -4 * Math.sin(2 * Math.PI * s / 0.72) * walking(s) * clamp01((t1 + 0.6 - t0 - s) / 0.6)) });
  P('cast.pm.armRBob.armR.compass').animate({
    rotate: over(t0, t1 + 1.6, (s) => {
      const walkPart = 9 * Math.sin(2 * Math.PI * s / 0.72 - 0.9) * walking(s) * clamp01((t1 - t0 - s) / 0.2 + 1);
      const after = s > t1 - t0 ? 14 * Math.exp(-3.2 * (s - (t1 - t0))) * Math.sin(2 * Math.PI * (s - (t1 - t0)) / 0.8) : 0;
      return (s < t1 - t0 ? walkPart : 0) + after * clamp01((t1 + 1.6 - t0 - s) / 0.3);
    }, 40),
  });
  P('cast.pm.antennaBob.antenna').animate({ rotate: wobble(4, 6) })
    .animate({ rotate: at([[0, -8], [t1 - 0.1, -8, easeOut], [t1 + 0.18, 6, easeInOut], [t1 + 0.42, -2, easeInOut], [t1 + 0.62, 0]]) });
  P('cast.pm.eyesBob.eyes').animate({ scaleY: blinks([t1 + 0.9, 7.2, 10.9]) });
  P('cast.pm.eyesBob.eyes').animate({ x: at([[0, 0], [up, 0, easeInOut], [up + 0.3, -6], [up + 1.5, -6, easeInOut], [up + 1.8, 0]]) });
}

// -- The designer: dropped in from above, landing with a squash, the beret a
// beat behind; then a flourish of the brush. --
{
  const land = T.design;
  const fall = 0.55;
  P('cast.design').animate({ y: at([[0, -1260], [land - fall, -1260, cubicBezier(0.45, 0, 0.95, 0.55)], [land, 0]]) });
  // Stretched by the fall, and let go of on landing.
  P('cast.design').animate({
    scaleY: at([[0, 1], [land - fall, 1, easeIn], [land - 0.15, 1.12], [land - 0.02, 1.12, easeOut], [land + 0.04, 1]]),
    scaleX: at([[0, 1], [land - fall, 1, easeIn], [land - 0.15, 0.92], [land - 0.02, 0.92, easeOut], [land + 0.04, 1]]),
  });
  hop('cast.design', land - 0.02, 0, 1.6);
  join(1, land);
  // The beret lifts off in the fall and lands a beat after the head does.
  P('cast.design.hatBob.hat').animate({
    y: at([[0, 0], [land - fall, 0, easeOut], [land - 0.1, -22, easeIn], [land + 0.08, -26, easeIn], [land + 0.24, 2, easeOut], [land + 0.34, 0]]),
    rotate: at([[0, 0], [land - fall, 0, easeOut], [land - 0.1, -10, easeIn], [land + 0.08, -14, easeIn], [land + 0.24, 3, easeOut], [land + 0.34, 0]]),
  });
  P('cast.design.antennaBob.antenna').animate({
    rotate: at([[0, 0], [land - fall, 0, easeOut], [land - 0.05, -18], [land + 0.12, 14, easeInOut], [land + 0.32, -7, easeInOut], [land + 0.52, 3, easeInOut], [land + 0.72, 0]]),
  }).animate({ rotate: wobble(3, 5, 0.4) });
  // Arms up in the fall, out for balance on landing, then the flourish.
  const f = land + 0.7;
  const brush = at([[0, 0], [land - fall, 0, easeOut], [land - 0.1, 35, easeInOut], [land + 0.2, -8, easeInOut], [land + 0.45, 0],
    [f, 0, easeInOut], [f + 0.25, -26, easeInOut], [f + 0.45, 30, easeInOut], [f + 0.62, 18, easeInOut], [f + 0.8, 24, easeInOut], [f + 1.2, 0]]);
  for (const p of ['brushBackBob.brushBack', 'brushBob.brush']) P(`cast.design.${p}`).animate({ rotate: brush });
  const palette = at([[0, 0], [land - fall, 0, easeOut], [land - 0.1, -30, easeInOut], [land + 0.2, 8, easeInOut], [land + 0.45, 0],
    [f + 0.2, 0, easeInOut], [f + 0.45, -8, easeInOut], [f + 0.9, 0]]);
  for (const p of ['paletteBackBob.paletteBack', 'paletteBob.palette']) P(`cast.design.${p}`).animate({ rotate: palette });
  P('cast.design.eyesBob.eyes').animate({ scaleY: blinks([land + 0.02, 6.4, 9.8]) });
}

// -- The developer: walks in from the left and hammers the first item home. --
{
  const [t0, t1] = T.dev;
  walk({
    t0, t1, walker: 'cast.dev', from: -420, step: 0.32, lift: 10,
    legs: [
      { path: 'cast.dev.legR', hip: [170, 286], foot: [186, 348], phase: 0 },
      { path: 'cast.dev.legL', hip: [116, 286], foot: [112, 349], phase: 0.5 },
    ],
    bob: bobs('dev', ['armR', 'hammerBack', 'antL', 'antR', 'body', 'eyes', 'hammer']),
  });
  join(2, t1);
  const hits = [t1 + 0.55, t1 + 0.95];
  // Wind up, strike, recoil, once per blow; the second lands the tick.
  const blows: Key[] = [[0, 0], [hits[0] - 0.45, 0, easeOut]];
  for (const h of hits) blows.push([h - 0.2, -28, cubicBezier(0.6, 0, 1, 0.5)], [h, 22, easeOut], [h + 0.08, 16, easeInOut]);
  blows.push([hits[1] + 0.5, 0, easeInOut]);
  const swing = at(blows);
  for (const p of ['hammerBackBob.hammerBack', 'hammerBob.hammer']) P(`cast.dev.${p}`).animate({ rotate: swing });
  // The whole body goes into each blow.
  const lean: Key[] = [[0, 0], [hits[0] - 0.45, 0, easeOut]];
  for (const h of hits) lean.push([h - 0.2, 3, easeIn], [h, -4, easeOut], [h + 0.12, -2, easeInOut]);
  lean.push([hits[1] + 0.5, 0]);
  for (const b of bobs('dev', ['armR', 'hammerBack', 'antL', 'antR', 'body', 'eyes', 'hammer'])) P(b).animate({ rotate: at(lean) });
  tick(0, hits[1]);
  const wince: Key[] = [[0, 1]];
  for (const h of hits) wince.push([h - 0.02, 1, easeOut], [h + 0.05, 0.4, easeIn], [h + 0.2, 1]);
  P('cast.dev.eyesBob.eyes').animate({ scaleY: at(wince) }).animate({ scaleY: blinks([8.1, 10.6]) });
  P('cast.dev.antLBob.antL').animate({ rotate: wobble(5, 7) });
  P('cast.dev.antRBob.antR').animate({ rotate: wobble(6, 6, 0.5) });
}

// -- The marketer: the chair springs up, the marketer drops into it, and
// calls out through the megaphone. --
{
  const c = T.chair;
  P('cast.chair').animate({
    scaleY: at([[0, 0], [c, 0, pop], [c + 0.36, 1]]),
    scaleX: at([[0, 0.6], [c, 0.6, pop], [c + 0.36, 1]]),
    opacity: at([[0, 0], [c, 0], [c + 0.06, 1]]),
  });
  const land = T.marketing;
  const fall = 0.5;
  P('cast.marketing').animate({ y: at([[0, -820], [land - fall, -820, cubicBezier(0.45, 0, 0.95, 0.55)], [land, 0]]) });
  hop('cast.marketing', land - 0.02, 0, 1.4);
  join(3, land);
  P('cast.marketing.earLBob.earL').animate({
    rotate: at([[0, 0], [land - fall, 0, easeOut], [land - 0.05, 20], [land + 0.14, -12, easeInOut], [land + 0.36, 5, easeInOut], [land + 0.6, 0]]),
  }).animate({ rotate: wobble(3, 5) });
  P('cast.marketing.earRBob.earR').animate({
    rotate: at([[0, 0], [land - fall, 0, easeOut], [land - 0.05, -20], [land + 0.14, 12, easeInOut], [land + 0.36, -5, easeInOut], [land + 0.6, 0]]),
  }).animate({ rotate: wobble(3, 5, 0.5) });
  P('cast.marketing.feetBob.feet').animate({ y: at([[0, 0], [land - 0.02, 0, easeOut], [land + 0.08, -10, easeInOut], [land + 0.3, 0]]) });
  // Up with the megaphone, a breath, and three calls.
  const m = land + 0.55;
  const raise = at([[0, 0], [m, 0, easeInOut], [m + 0.3, 42, easeOut], [m + 0.45, 38, easeInOut], [m + 1.6, 38, easeInOut], [m + 2.0, 0]]);
  for (const p of ['megaBackBob.megaBack', 'megaBob.mega']) P(`cast.marketing.${p}`).animate({ rotate: raise });
  const calls = [m + 0.5, m + 0.85, m + 1.2];
  // The body leans into each call.
  const push: Key[] = [[0, 0], [calls[0] - 0.1, 0]];
  for (const t of calls) push.push([t, -3, easeOut], [t + 0.2, 0, easeInOut]);
  for (const b of bobs('marketing', ['armRBack', 'earR', 'earL', 'body', 'feet', 'megaBack', 'armR', 'eyes', 'mega'])) P(b).animate({ rotate: at(push) });
  [0, 1, 2].forEach((i) => {
    const keysFor = (from: number): Key[] => {
      const ks: Key[] = [[0, from]];
      calls.forEach((t) => {
        const s = t + i * 0.07;
        ks.push([s, from, easeOut], [s + 0.18, 1], [s + 0.3, 1, easeIn], [s + 0.34, from]);
      });
      ks.push([calls[2] + 0.6, 1]);
      return ks;
    };
    P(`cast.marketing.megaBob.mega.arc${i}`).animate({ opacity: at(keysFor(0)), scaleX: at(keysFor(0.6)), scaleY: at(keysFor(0.6)) });
  });
  P('cast.marketing.eyesBob.eyes').animate({ scaleY: at([[0, 1], [calls[0] - 0.05, 1, easeOut], [calls[0] + 0.05, 0.35], [calls[2] + 0.3, 0.35, easeInOut], [calls[2] + 0.45, 1]]) })
    .animate({ scaleY: blinks([land + 0.25, 10.2]) });
}

// -- The analyst: board and stool first, then a hop up onto the stool from the
// side, and the chart drawn as the pointer follows it up. --
{
  const b = T.board;
  P('cast.board').animate({
    scaleY: at([[0, 0], [b, 0, pop], [b + 0.4, 1]]),
    scaleX: at([[0, 0.5], [b, 0.5, pop], [b + 0.4, 1]]),
    opacity: at([[0, 0], [b, 0], [b + 0.06, 1]]),
  });
  P('cast.stool').animate({
    scaleY: at([[0, 0], [b + 0.15, 0, pop], [b + 0.5, 1]]),
    scaleX: at([[0, 0.5], [b + 0.15, 0.5, pop], [b + 0.5, 1]]),
    opacity: at([[0, 0], [b + 0.15, 0], [b + 0.21, 1]]),
  });
  const land = T.stats;
  // In from the left in one bound, up and onto the stool.
  const t0 = land - 0.55;
  P('cast.stats').animate({ x: at([[0, -480], [t0, -480, linear], [land, 0]]) });
  P('cast.stats').animate({ y: at([[0, 125], [t0, 125, easeOut], [t0 + 0.3, -150, easeIn], [land, 0]]) });
  P('cast.stats').animate({ rotate: at([[0, 0], [t0, -14, easeOut], [land - 0.1, 6, easeInOut], [land + 0.15, -2, easeInOut], [land + 0.35, 0]]) });
  hop('cast.stats', land - 0.02, 0, 1.5);
  join(4, land);
  // Legs tucked in the bound.
  for (const [leg, s] of [['legR', 1], ['legL', -1]] as const) {
    P(`cast.stats.${leg}Bob.${leg}`).animate({ rotate: at([[0, 0], [t0, 0, easeOut], [t0 + 0.2, 18 * s, easeInOut], [land - 0.05, 0]]) });
  }
  // Pointing out the line as it rises: the pointer starts low on the chart and
  // follows the stroke up to where it was drawn.
  const d0 = land + 0.45;
  const d1 = d0 + 0.95;
  P('cast.board.chart').animate({ draw: at([[0, 0], [d0, 0, easeInOut], [d1, 1]]) });
  const point = at([[0, 0], [land, 0, easeInOut], [d0 - 0.05, 26, easeInOut], [d1, -4, easeInOut], [d1 + 0.25, 0]]);
  for (const p of ['pointerBackBob.pointerBack', 'pointerBob.pointer']) P(`cast.stats.${p}`).animate({ rotate: point });
  P('cast.stats.armLBob.armL').animate({ rotate: at([[0, 0], [t0, 0, easeOut], [t0 + 0.2, -30, easeInOut], [land + 0.1, 6, easeInOut], [land + 0.35, 0]]) });
  tick(1, d1 + 0.1);
  P('cast.stats.antRBob.antR').animate({ rotate: at([[0, 0], [t0, 0, easeOut], [t0 + 0.25, 14], [land + 0.1, -10, easeInOut], [land + 0.3, 5, easeInOut], [land + 0.55, 0]]) }).animate({ rotate: wobble(4, 7, 0.2) });
  P('cast.stats.antLBob.antL').animate({ rotate: at([[0, 0], [t0, 0, easeOut], [t0 + 0.25, 12], [land + 0.12, -12, easeInOut], [land + 0.32, 5, easeInOut], [land + 0.57, 0]]) }).animate({ rotate: wobble(4, 6, 0.7) });
  P('cast.stats.eyesBob.eyes').animate({ x: at([[0, 0], [d0, 0, easeInOut], [d0 + 0.3, 4], [d1 + 0.3, 4, easeInOut], [d1 + 0.6, 0]]) })
    .animate({ scaleY: blinks([land + 1.9, 11.0]) });
}

// -- The support rep: walks in from the right with its laptop, a heart goes up,
// and it waves to everyone. --
{
  const [t0, t1] = T.cs;
  walk({
    t0, t1, walker: 'cast.cs', from: 420, step: 0.32, lift: 9,
    legs: [
      { path: 'cast.cs.legL', hip: [95, 284], foot: [95, 340], phase: 0 },
      { path: 'cast.cs.legR', hip: [156, 284], foot: [156, 340], phase: 0.5 },
    ],
    bob: bobs('cs', ['shade', 'armR', 'body', 'wave', 'laptop', 'eyes', 'headset', 'earL', 'earR', 'heart']),
  });
  join(5, t1);
  const h = t1 + 0.1;
  P('cast.cs.heartBob.heart').animate({
    scaleX: at([[0, 0], [h, 0, pop], [h + 0.35, 1]]),
    scaleY: at([[0, 0], [h, 0, pop], [h + 0.35, 1]]),
  }).animate({ y: at([[0, 20], [h, 20, easeOut], [h + 0.4, 0]]) }).animate({ scaleX: over(h + 0.4, FADE[1], (s) => 1 + 0.06 * Math.max(0, Math.sin(2 * Math.PI * s / 0.8)) ** 4), scaleY: over(h + 0.4, FADE[1], (s) => 1 + 0.06 * Math.max(0, Math.sin(2 * Math.PI * s / 0.8)) ** 4) });
  // Up with the free arm, and a wave that carries through the cheer.
  const w = t1 + 0.35;
  const waveEnd = T.cheer + 0.6;
  P('cast.cs.waveBob.wave').animate({ rotate: at([[0, 0], [w, 0, easeInOut], [w + 0.3, 108, easeOut], [waveEnd, 108, easeInOut], [waveEnd + 0.4, 0]]) })
    .animate({ rotate: over(w + 0.25, waveEnd, (s, u) => 14 * Math.sin(2 * Math.PI * s / 0.5) * Math.min(1, s / 0.2, (1 - u) * 5), 40) });
  // Ears stream back on the walk and spring upright at the stop.
  const trail = (s: number): Channel => at([[0, 9 * s], [t1 - 0.1, 9 * s, easeOut], [t1 + 0.16, -6 * s, easeInOut], [t1 + 0.4, 2 * s, easeInOut], [t1 + 0.6, 0]]);
  P('cast.cs.earLBob.earL').animate({ rotate: trail(1) }).animate({ rotate: wobble(3, 5, 0.1) });
  P('cast.cs.earRBob.earR').animate({ rotate: trail(1) }).animate({ rotate: wobble(3, 6, 0.6) });
  P('cast.cs.eyesBob.eyes').animate({ scaleY: at([[0, 1], [h, 1, easeOut], [h + 0.12, 0.3], [h + 0.8, 0.3, easeInOut], [h + 0.95, 1]]) })
    .animate({ scaleY: blinks([4.0]) });
}

// -- All together: a hop that runs along the team left to right, the last item
// ticked as they land, the faces in the pile bobbing in turn. --
{
  const c = T.cheer;
  const order: [string, number][] = [['stats', 0], ['dev', 0.05], ['marketing', 0.1], ['design', 0.15], ['pm', 0.2], ['cs', 0.25]];
  for (const [who, lag] of order) hop(`cast.${who}`, c + lag, who === 'marketing' ? 22 : 38, 1);
  tick(2, c + 0.55);
  CREW.forEach((_, i) => {
    const t = c + 0.1 + i * 0.05;
    P(`faces.face${i}`).animate({ y: at([[0, 0], [t, 0, easeOut], [t + 0.16, -8, easeIn], [t + 0.34, 0]]) });
  });
  // Arms up with the hop, where there is an arm free to throw.
  const cheer = (lag: number, amp: number): Channel =>
    at([[0, 0], [c + lag, 0, easeOut], [c + lag + 0.2, amp, easeInOut], [c + lag + 0.55, amp, easeInOut], [c + lag + 0.85, 0]]);
  for (const p of ['brushBackBob.brushBack', 'brushBob.brush']) P(`cast.design.${p}`).animate({ rotate: cheer(0.15, 40) });
  for (const p of ['paletteBackBob.paletteBack', 'paletteBob.palette']) P(`cast.design.${p}`).animate({ rotate: cheer(0.15, -32) });
  for (const p of ['hammerBackBob.hammerBack', 'hammerBob.hammer']) P(`cast.dev.${p}`).animate({ rotate: cheer(0.05, -16) });
  P('cast.dev.armRBob.armR').animate({ rotate: cheer(0.05, -135) });
  for (const p of ['megaBackBob.megaBack', 'megaBob.mega']) P(`cast.marketing.${p}`).animate({ rotate: cheer(0.1, 30) });
  for (const p of ['armRBackBob.armRBack', 'armRBob.armR']) P(`cast.marketing.${p}`).animate({ rotate: cheer(0.1, -110) });
  P('cast.stats.armLBob.armL').animate({ rotate: cheer(0, 60) });
  P('cast.pm.mapArmBob.mapArm').animate({ rotate: cheer(0.2, 30) });
  P('cast.pm.armRBob.armR').animate({ rotate: cheer(0.2, -18) });
}

export default team;
