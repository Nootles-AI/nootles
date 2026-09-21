import { readFileSync } from 'node:fs';
import {
  character, part, svgShape, mask, clipPath, linearGradient, keys, sampled, cueSheet, within,
  easeInOut, easeOut, easeIn, linear, cubicBezier,
} from './heron/src/index.ts';
import type { Channel, ClipRef, MaskRef, PaintRef, Vec2 } from './heron/src/index.ts';

/**
 * The Pro picture: the team illustration, rigged and animated in Heron.
 *
 * `art.json` is the illustration as data (see `extract.mjs`); this file
 * rebuilds it exactly, rigs each character from its own paths, and stages
 * them building the document together. Check and build with
 *
 *   node scripts/pro-art/heron/src/cli.ts check "$PWD/scripts/pro-art/team.scene.ts" --fps 30
 *   node scripts/pro-art/heron/src/cli.ts build "$PWD/scripts/pro-art/team.scene.ts" \
 *     -o public/pro/team-doc.svg --fps 30
 *
 * `heron` is a symlink to the installed Heron skill (github.com/iforaa/heron,
 * MIT), not committed; Heron resolves a relative scene path against its own
 * folder, hence `$PWD`.
 *
 * The rig follows the drawing. Every character is its artist's paths, in the
 * artist's paint order, grouped into parts that turn about the joints those
 * paths meet at. Where a part has to paint on both sides of another (the
 * bear's arms wrap the card, the pencil sits behind the arm that holds it),
 * it is split into stacks that carry identical motion.
 */

// ---- The art ------------------------------------------------------------------

type Attrs = Record<string, string>;
type Box = [number, number, number, number];
type Shape = { t: 's'; tag: string; a: Attrs; bb: Box; text?: boolean };
type Group = { t: 'g'; id?: string; mask?: string; clip?: string; c: Node[] };
type Node = Shape | Group;
interface Art {
  viewBox: [number, number, number, number];
  defs: {
    masks: { id: string; region: Box; shapes: { tag: string; a: Attrs }[] }[];
    clips: { id: string; shapes: { tag: string; a: Attrs }[] }[];
    gradients: {
      id: string; x1: number; y1: number; x2: number; y2: number; units: string; transform?: string;
      stops: { at: number; color: string; opacity?: number }[];
    }[];
  };
  tree: Node[];
}

const ART: Art = JSON.parse(readFileSync(new URL('./art.json', import.meta.url), 'utf8'));
const D = 24;

const find = (id: string, nodes: Node[] = ART.tree): Group => {
  for (const n of nodes) {
    if (n.t !== 'g') continue;
    if (n.id === id) return n;
    const inner = find(id, n.c) as Group | undefined;
    if (inner) return inner;
  }
  return undefined as unknown as Group;
};
const kids = (id: string) => find(id).c;

let MASKS = new Map<string, MaskRef>();
let CLIPS = new Map<string, ClipRef>();

function definitions(): void {
  MASKS = new Map();
  CLIPS = new Map();
  const paints = new Map<string, PaintRef>();
  for (const g of ART.defs.gradients) {
    paints.set(g.id, linearGradient(g.id, {
      x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2,
      units: g.units as 'userSpaceOnUse',
      transform: g.transform,
      stops: g.stops.map((s) => ({ at: s.at, color: s.color, ...(s.opacity === undefined ? {} : { opacity: s.opacity }) })),
    }));
  }
  for (const m of ART.defs.masks) {
    const [x, y, width, height] = m.region;
    MASKS.set(m.id, mask(m.id, () => m.shapes.forEach((s) => svgShape(s.tag, s.a)),
      { units: 'userSpaceOnUse', region: { x, y, width, height } }));
  }
  for (const c of ART.defs.clips) {
    CLIPS.set(c.id, clipPath(c.id, () => c.shapes.forEach((s) => svgShape(s.tag, s.a))));
  }
}

let unnamed = 0;
/** Draws a node exactly as drawn: groups become parts, keeping masks and clips. */
function draw(n: Node): void {
  if (n.t === 's') {
    svgShape(n.tag, n.a);
    return;
  }
  part((n.id ?? `g${++unnamed}`).replace(/[^A-Za-z0-9_-]/g, '_'), {
    ...(n.mask ? { mask: MASKS.get(n.mask)! } : {}),
    ...(n.clip ? { clip: CLIPS.get(n.clip)! } : {}),
  }, () => n.c.forEach(draw));
}
/** A masked shading group reduced to some of its paths, keeping its mask. */
function shadeOnly(n: Node, keep: number[]): void {
  const g = n as Group;
  const inner = g.c[0] as Group;
  const paths = inner.t === 'g' ? inner.c : g.c;
  part(`shade${++unnamed}`, { mask: MASKS.get(g.mask!)! }, () => keep.forEach((i) => draw(paths[i])));
}

// ---- Time -----------------------------------------------------------------------

const CUES = cueSheet(D, {
  turtleWalk: [0.4, 3.0],
  write: [3.1, 8.3],
  ropeDown: [8.1, 8.8],
  bearDown: [8.7, 10.1],
  handOver: [10.5, 11.7],
  bearUp: [12.3, 13.9],
  ropeUp: [13.8, 14.5],
  elephantWalk: [13.4, 16.0],
  paint: [16.1, 19.4],
  alienWalk: [18.7, 20.9],
  hammer: [21.0, 22.7],
});
const FADE: [number, number] = [23.1, 23.8];

type Key = [seconds: number, value: number, ease?: Parameters<typeof keys>[0][number][2]];
/**
 * Keys in seconds. The value holds before the first; after the last it holds
 * until everything has faded, then returns to where it started, unseen, so the
 * next take begins from the same pose.
 */
function at(list: Key[]): Channel {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
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
/** A procedural curve in seconds, confined to a cue and held either side. */
function over(cue: string, fn: (s: number, u: number) => number, perSecond = 30): Channel {
  const b = CUES.at(cue);
  return within(b, sampled((u) => fn(u * b.seconds, u), Math.max(2, Math.ceil(b.seconds * perSecond))));
}
const seconds = (cue: string): [number, number] => {
  const b = CUES.at(cue);
  return [b.from * D, b.to * D];
};

const smooth = (x: number) => x * x * (3 - 2 * x);
const pop = cubicBezier(0.3, 1.5, 0.5, 1);
/** Loop-safe wobble: a whole number of cycles in the film. */
const wobble = (amp: number, cycles: number, phase = 0) =>
  sampled((u) => amp * Math.sin(2 * Math.PI * (u * cycles + phase)), Math.max(48, cycles * 12));
/** Blinks at the given seconds, each a quick close and open. */
const blinks = (times: number[]): Channel =>
  at([[0, 1], ...times.flatMap((t): Key[] => [[t, 1, easeIn], [t + 0.07, 0.08, easeOut], [t + 0.16, 1]])]);

// ---- Walking --------------------------------------------------------------------

interface Leg { path: string; hip: Vec2; foot: Vec2; phase: number }

/**
 * A walk across the page on stubby, knee-less legs. The walker travels at a
 * steady speed; each leg's stance rotation is solved so its foot stays where it
 * was set down while the body passes over it, and the swing leg lifts clear.
 */
function walk(opts: {
  cue: string; walker: string; from: number; legs: Leg[]; bob: string[]; step: number; lift?: number; stance?: number;
}): { v: number } {
  const [t0, t1] = seconds(opts.cue);
  const dur = t1 - t0;
  const v = -opts.from / dur;
  const S = opts.stance ?? 0.6;
  const T = opts.step;
  const H = opts.lift ?? 7;
  const dir = Math.sign(v);
  team.part(opts.walker).animate({
    x: at([[0, opts.from], [t0, opts.from, linear], [t1, 0], [FADE[1], 0], [D, opts.from]]),
  });
  for (const leg of opts.legs) {
    const L = leg.foot[1] - leg.hip[1];
    const sinA = Math.min(0.6, Math.abs(v) * S * T / (2 * L));
    const A = Math.asin(sinA);
    const settle = 0.22;
    // Into the walk from standing and out of it to standing.
    const env = (s: number) => Math.min(1, Math.max(0, s / settle), Math.max(0, (dur - s) / settle));
    const angle = (s: number) => {
      const p = ((s / T) + leg.phase) % 1;
      let th: number;
      if (p < S) th = Math.asin(Math.max(-1, Math.min(1, -dir * sinA + v * (p * T) / L)));
      else th = dir * A * (1 - 2 * smooth((p - S) / (1 - S)));
      return (th * 180 / Math.PI) * env(s);
    };
    const liftAt = (s: number) => {
      const p = ((s / T) + leg.phase) % 1;
      return p < S ? 0 : -H * Math.sin(Math.PI * (p - S) / (1 - S)) * env(s);
    };
    team.part(leg.path).animate({
      rotate: over(opts.cue, (s) => angle(s), 40),
      y: over(opts.cue, (s) => liftAt(s), 40),
    });
  }
  const env = (s: number) => Math.min(1, Math.max(0, s / 0.22), Math.max(0, (dur - s) / 0.22));
  for (const b of opts.bob) {
    team.part(b).animate({
      y: over(opts.cue, (s) => -4 * (0.5 - 0.5 * Math.cos(4 * Math.PI * s / T)) * env(s), 40),
      rotate: over(opts.cue, (s) => 2.2 * Math.sin(2 * Math.PI * s / T) * env(s), 40),
    });
    // Arriving with weight: the body carries on past the stop and comes back.
    team.part(b).animate({
      rotate: at([[0, 0], [t1 - 0.05, 0, easeOut], [t1 + 0.12, 5 * dir, easeInOut], [t1 + 0.32, -1.6 * dir, easeInOut], [t1 + 0.52, 0]]),
    });
  }
  return { v };
}

// ---- The scene ------------------------------------------------------------------

/**
 * Builds a character's parts from index lists into its drawing, in the
 * drawing's order. `bob` wrappers ride the walk's body bob; legs do not.
 */
type Piece = { name: string; idx: number[]; pivot?: Vec2; contact?: Vec2; leg?: boolean; shade?: [number, number[]] };
function cast(name: string, id: string, bobPivot: Vec2, pieces: Piece[], nodes = kids(id)): void {
  part(name, { pivot: bobPivot, offstage: true }, () => {
    for (const p of pieces) {
      const body = () => {
        for (const i of p.idx) draw(nodes[i]);
        if (p.shade) shadeOnly(nodes[p.shade[0]], p.shade[1]);
      };
      if (p.leg) part(p.name, { pivot: p.pivot!, ...(p.contact ? { contact: p.contact } : {}) }, body);
      else {
        part(`${p.name}Bob`, { pivot: bobPivot }, () => {
          if (p.pivot) part(p.name, { pivot: p.pivot }, body);
          else body();
        });
      }
    }
  });
}

/** A piece of the document placed by someone: its own part, pivoting on its middle. */
function piece(n: Shape, name: string): void {
  const [x, y, r, b] = n.bb;
  part(name, { pivot: [(x + r) / 2, (y + b) / 2] }, () => svgShape(n.tag, n.a));
}

const DOC = {
  header: [] as { name: string; bb: Box }[],
  flow: [] as { name: string; bb: Box; arrow: boolean }[],
  cart: [] as { name: string; bb: Box }[],
  pay: [] as { name: string; bb: Box }[],
  slab: [] as { name: string; bb: Box }[],
  codeHead: [] as { name: string; bb: Box }[],
  code: [] as { name: string; bb: Box }[],
};

function documentContent(): void {
  const content = find('Document_Card-2');
  let i = 0;
  // Every piece becomes a part; collected by section for staging.
  const walkSection = (n: Node, into: (name: string, s: Shape) => void) => {
    if (n.t === 's') {
      const name = `p${i++}`;
      piece(n, name);
      into(name, n);
      return;
    }
    if (n.mask || n.clip) {
      const name = `p${i++}`;
      const [bb] = boxes(n);
      part(name, { pivot: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2] }, () => draw(n));
      into(name, { t: 's', tag: 'g', a: {}, bb });
      return;
    }
    n.c.forEach((c) => walkSection(c, into));
  };
  for (const section of content.c as Group[]) {
    if (section.id === 'Card_Frame') continue;
    part(section.id!, () => {
      walkSection(section, (name, s) => {
        const e = { name, bb: s.bb };
        const [x, y, r, b] = s.bb;
        const w = r - x;
        const h = b - y;
        if (section.id === 'Section_Header') DOC.header.push(e);
        else if (section.id === 'Section_User_Flow') DOC.flow.push({ ...e, arrow: !s.text && w > h * 3 && h < 16 });
        else if (section.id === 'Section_Code_Block') {
          if (w > 1000) DOC.slab.push(e);
          else if (y < 1460) DOC.codeHead.push(e);
          else DOC.code.push(e);
        } else if (x < 560) DOC.cart.push(e);
        else DOC.pay.push(e);
      });
    });
  }
}
function boxes(n: Node): Box[] {
  if (n.t === 's') return [n.bb];
  const all = n.c.flatMap(boxes);
  return [[Math.min(...all.map((b) => b[0])), Math.min(...all.map((b) => b[1])),
    Math.max(...all.map((b) => b[2])), Math.max(...all.map((b) => b[3]))]];
}

// The card's centre as drawn, and where it is set down: the flowchart's empty
// last box, just past its final arrow, level.
const CARD_C: Vec2 = [1202.3, 687.9];
const SLOT_C: Vec2 = [1195.8, 618];
const ROPE_TOP: Vec2 = [1336, 0];

export const team = character('team', { viewBox: ART.viewBox, duration: D }, () => {
  definitions();
  // The paper stays; everything on it is placed and then cleared.
  draw(find('Card_Frame'));
  part('content', documentContent);

  part('cast', () => {
    const tt = kids('Character_-_Green_Turtle');
    cast('turtle', 'Character_-_Green_Turtle', [606, 577], [
      { name: 'pencil', idx: [0, 1, 2, 3, 4, 5, 6], pivot: [560, 488] },
      { name: 'armR', idx: [7, 8], pivot: [632, 480] },
      { name: 'armUp', idx: [9, 10], pivot: [560, 488] },
      { name: 'legL', idx: [11], pivot: [574, 512], contact: [572, 577], leg: true, shade: [13, [0]] },
      { name: 'legR', idx: [12], pivot: [633, 508], contact: [636, 577], leg: true, shade: [13, [1]] },
      { name: 'antR', idx: [14, 15], pivot: [652, 430] },
      { name: 'antL', idx: [16, 17], pivot: [602, 416] },
      { name: 'body', idx: [18] },
    ], tt);

    // The bear's parts are two stacks either side of the card, with identical
    // motion, so its arms wrap the card the way they were drawn.
    const bear = kids('Character_-_Pink_Bear');
    const bearStack = (name: string, build: () => void) =>
      part(`${name}Ride`, { pivot: [1300, 640], offstage: true }, build);
    part('rope', { pivot: ROPE_TOP, offstage: true }, () => draw(find('Rope')));
    bearStack('bearBack', () => {
      draw(bear[0]);
      draw(bear[1]);
      part('legFar', { pivot: [1424, 640] }, () => draw(bear[2]));
      part('armFar', { pivot: [1306, 662] }, () => draw(bear[3]));
      part('earFar', { pivot: [1228, 618] }, () => draw(bear[4]));
      draw(bear[5]);
      part('bearEyes', { pivot: [1246, 649] }, () => { draw(bear[6]); draw(bear[7]); });
      draw(bear[8]);
      part('legNear', { pivot: [1418, 603] }, () => draw(bear[9]));
    });
    part('cardRide', { pivot: CARD_C, offstage: true }, () =>
      part('card', { pivot: CARD_C }, () => [10, 11, 12].forEach((i) => draw(bear[i]))));
    bearStack('bearFront', () => {
      part('earNear', { pivot: [1236, 603] }, () => draw(bear[13]));
      part('armNear', { pivot: [1322, 668] }, () => draw(bear[14]));
      part('thumb', { pivot: [1306, 662] }, () => draw(bear[15]));
      [16, 17, 18, 19, 20].forEach((i) => draw(bear[i]));
    });

    const el = kids('Character_-_Yellow_Elephant');
    cast('elephant', 'Character_-_Yellow_Elephant', [1135, 1485], [
      { name: 'brush', idx: [0, 1, 2, 3], pivot: [1112, 1390] },
      { name: 'antenna', idx: [4, 5, 6], pivot: [1130, 1310] },
      { name: 'armFar', idx: [7, 8], pivot: [1128, 1360] },
      { name: 'legFar', idx: [9, 10], pivot: [1117, 1406], contact: [1112, 1480], leg: true },
      { name: 'body', idx: [11] },
      { name: 'eyeFar', idx: [12], pivot: [1094, 1340] },
      { name: 'legNear', idx: [13], pivot: [1139, 1414], contact: [1140, 1489], leg: true },
      { name: 'eyeNear', idx: [14], pivot: [1110, 1346] },
      { name: 'beret', idx: [15], pivot: [1152, 1330] },
      { name: 'armNear', idx: [16], pivot: [1112, 1390] },
      { name: 'palette', idx: [17, 18, 19, 20, 21, 22], pivot: [1128, 1360] },
    ], el);

    const al = kids('Character_-_Blue_Alien');
    cast('alien', 'Character_-_Blue_Alien', [620, 2039], [
      { name: 'armUpBack', idx: [0], pivot: [601, 1917] },
      { name: 'legL', idx: [1, 2], pivot: [589, 1980], contact: [590, 2040], leg: true },
      { name: 'legR', idx: [3, 4], pivot: [646, 1984], contact: [650, 2038], leg: true },
      { name: 'armUp', idx: [5, 6], pivot: [601, 1917] },
      { name: 'armDown', idx: [7], pivot: [656, 1893] },
      { name: 'antL', idx: [8, 9, 10], pivot: [624, 1840] },
      { name: 'body', idx: [11] },
      { name: 'eyes', idx: [12, 13], pivot: [599, 1863] },
      { name: 'antR', idx: [14, 15, 16], pivot: [645, 1846] },
      { name: 'shine', idx: [17] },
      { name: 'hammer', idx: [18, 19, 20, 21], pivot: [601, 1917] },
      { name: 'mark', idx: [22, 23, 24] },
    ], al);
  });
});

// ---- Choreography ---------------------------------------------------------------

const P = (path: string) => team.part(path);

// Everyone and everything on the page leaves together, and returns for the next take.
const present = at([[0, 0], [0.2, 0], [0.25, 1], [FADE[0], 1, easeIn], [FADE[1], 0]]);
P('content').animate({ opacity: present });
P('cast').animate({ opacity: present });

/** Placed on the page at `t`: fades up and settles from `dy` below. */
function place(name: string, t: number, dy = 6, dur = 0.2) {
  P(`content.${name}`).animate({
    opacity: at([[0, 0], [t, 0, easeOut], [t + dur, 1], [FADE[1], 1], [D, 0]]),
    y: at([[0, dy], [t, dy, easeOut], [t + dur, 0], [FADE[1], 0], [D, dy]]),
  });
}
/** Set down with a little give. */
function popIn(name: string, t: number, from = 0.8) {
  P(`content.${name}`).animate({
    opacity: at([[0, 0], [t, 0, easeOut], [t + 0.12, 1], [FADE[1], 1], [D, 0]]),
    scaleX: at([[0, from], [t, from, pop], [t + 0.3, 1], [FADE[1], 1], [D, from]]),
    scaleY: at([[0, from], [t, from, pop], [t + 0.3, 1], [FADE[1], 1], [D, from]]),
  });
}
/** Drawn out along its length from the left. */
function drawOut(name: string, t: number) {
  P(`content.${name}`).animate({
    opacity: at([[0, 0], [t, 0], [t + 0.01, 1], [FADE[1], 1], [D, 0]]),
    scaleX: at([[0, 0], [t, 0, easeInOut], [t + 0.28, 1], [FADE[1], 1], [D, 0]]),
  });
}
const section = <T extends { name: string }>(list: T[], sectionId: string): T[] =>
  list.map((e) => ({ ...e, name: `${sectionId}.${e.name}` }));

// -- The turtle: walks in, writes the header and the flowchart, looks it over. --
walk({
  cue: 'turtleWalk', walker: 'cast.turtle', from: -720, step: 0.3, lift: 8, stance: 0.5,
  legs: [
    { path: 'cast.turtle.legL', hip: [574, 512], foot: [572, 577], phase: 0 },
    { path: 'cast.turtle.legR', hip: [633, 508], foot: [636, 577], phase: 0.5 },
  ],
  bob: ['pencilBob', 'armRBob', 'armUpBob', 'antRBob', 'antLBob', 'bodyBob'].map((b) => `cast.turtle.${b}`),
});
{
  const [w0, w1] = seconds('write');
  // Reading order: rows top to bottom, words left to right.
  const words = [...DOC.header].sort((a, b) => (Math.abs(a.bb[1] - b.bb[1]) > 12 ? a.bb[1] - b.bb[1] : a.bb[0] - b.bb[0]));
  const headerEnd = w0 + (w1 - w0) * 0.62;
  words.forEach((w, k) => place(`Section_Header.${w.name}`, w0 + 0.1 + ((headerEnd - w0 - 0.1) * k) / words.length, 5, 0.16));
  // The flowchart, left to right: boxes set down, arrows drawn out.
  const flow = [...DOC.flow].sort((a, b) => a.bb[0] - b.bb[0] || a.bb[1] - b.bb[1]);
  flow.forEach((f, k) => {
    const t = headerEnd + 0.15 + ((w1 - headerEnd - 0.3) * k) / flow.length;
    if (f.arrow) drawOut(`Section_User_Flow.${f.name}`, t);
    else popIn(`Section_User_Flow.${f.name}`, t, 0.85);
  });
  // The pencil hand: up to the page, scribbling for as long as there is writing.
  const scribble = over('write', (s, u) => {
    const up = Math.min(1, s / 0.3) * Math.min(1, (CUES.at('write').seconds - s) / 0.3);
    return up * (-4 * Math.sin(2 * Math.PI * s / 0.19) - 3 * Math.sin(2 * Math.PI * s / 0.53)) + 0 * u;
  }, 60);
  const reach = at([[0, 16], [w0, 16, easeOut], [w0 + 0.3, 0], [w1 - 0.1, 0, easeInOut], [w1 + 0.4, 14]]);
  for (const p of ['cast.turtle.armUpBob.armUp', 'cast.turtle.pencilBob.pencil']) {
    P(p).animate({ rotate: reach }).animate({ rotate: scribble });
  }
  // Leaning into the page while writing.
  P('cast.turtle').animate({ rotate: at([[0, 0], [w0, 0, easeInOut], [w0 + 0.4, -3], [w1, -3, easeInOut], [w1 + 0.5, 0]]) });
  P('cast.turtle.armRBob.armR').animate({
    rotate: at([[0, 0], [w1, 0, easeInOut], [w1 + 0.35, -10, easeInOut], [w1 + 0.9, 0]]),
  });
}
P('cast.turtle.antRBob.antR').animate({ rotate: wobble(5, 17) });
P('cast.turtle.antLBob.antL').animate({ rotate: wobble(6, 13, 0.3) });

// -- The rope and the bear. --
{
  const [r0, r1] = seconds('ropeDown');
  const [d0, d1] = seconds('bearDown');
  const [h0, h1] = seconds('handOver');
  const [u0, u1] = seconds('bearUp');
  const [q0, q1] = seconds('ropeUp');
  P('cast.rope').animate({
    y: at([[0, -700], [r0, -700, cubicBezier(0.3, 0, 0.3, 1)], [r1, 0], [q0, 0, easeIn], [q1, -700]]),
  });
  // Down the rope with a bounce; one pull up with the card still in its arms;
  // then, once the card is let go, up the rest of the way hand over hand.
  const LIFT = -200;
  const drop = h0 + 0.8;
  const climb: Key[] = [];
  const pulls = 3;
  for (let k = 0; k < pulls; k++) {
    const a = u0 + ((u1 - u0) * k) / pulls;
    const b = u0 + ((u1 - u0) * (k + 0.65)) / pulls;
    climb.push([a, LIFT + ((-820 - LIFT) * k) / pulls, cubicBezier(0.4, 0, 0.2, 1)], [b, LIFT + ((-820 - LIFT) * (k + 1)) / pulls]);
  }
  const descent: Key[] = [[0, -820], [d0, -820, cubicBezier(0.3, 0.1, 0.3, 1)], [d1, 12, easeInOut], [d1 + 0.25, -6, easeInOut], [d1 + 0.45, 0], [h0, 0, cubicBezier(0.4, 0, 0.2, 1)], [h0 + 0.6, LIFT]];
  const ride = at([...descent, ...climb]);
  for (const s of ['bearBack', 'bearFront']) P(`cast.${s}Ride`).animate({ y: ride });

  // Arms hold the card through the pull, fall open as they let it go, and
  // then reach and pull on the way up.
  const arms = at([[0, 0], [drop - 0.05, 0, easeOut], [drop + 0.2, -32, easeInOut], [u0, -8, easeInOut], ...climb.map(([t], k): Key => [t + 0.12, k % 2 ? 12 : -16, easeInOut]), [u1 + 0.3, 0]]);
  P('cast.bearFrontRide.armNear').animate({ rotate: arms });
  P('cast.bearFrontRide.thumb').animate({ rotate: arms });
  P('cast.bearBackRide.armFar').animate({ rotate: arms });

  // The card: carried down and up in its arms exactly as drawn, then let go —
  // it drops down and left, turning level, into the flowchart's empty last box.
  const [sx, sy] = [SLOT_C[0] - CARD_C[0], SLOT_C[1] - CARD_C[1]];
  P('cast.cardRide').animate({
    y: at([...descent, [drop, LIFT, cubicBezier(0.55, 0, 1, 0.45)], [h1 - 0.12, sy + 6, easeOut], [h1 - 0.04, sy - 3, easeInOut], [h1 + 0.06, sy]]),
  });
  P('cast.cardRide.card').animate({
    x: at([[0, 0], [drop, 0, easeInOut], [h1 - 0.12, sx]]),
  }).animate({
    rotate: at([[0, 0], [drop, 0, cubicBezier(0.3, 0, 0.3, 1)], [h1 - 0.12, -67.5]]),
  });
  // Legs flutter on the way down and kick on the way up; ears stream.
  const flutter = (amp: number, period: number, phase: number) => (s: number) =>
    amp * Math.sin(2 * Math.PI * (s / period + phase)) * Math.min(1, s / 0.2);
  for (const [leg, ph] of [['legNear', 0], ['legFar', 0.5]] as const) {
    P(`cast.bearBackRide.${leg}`)
      .animate({ rotate: over('bearDown', flutter(10, 0.28, ph)) })
      .animate({ rotate: over('bearUp', flutter(14, 0.4, ph)) });
  }
  const ears = at([[0, 0], [d0, 0, easeOut], [d0 + 0.4, 26], [d1, 18, cubicBezier(0.3, 1.8, 0.5, 1)], [d1 + 0.6, 0], [u0, 0, easeInOut], [u0 + 0.3, -16], [u1, -12, easeInOut], [u1 + 0.3, 0]]);
  P('cast.bearBackRide.earFar').animate({ rotate: ears });
  P('cast.bearFrontRide.earNear').animate({ rotate: ears });
  // Pleased with itself once the card is down.
  P('cast.bearBackRide.bearEyes').animate({
    scaleY: at([[0, 1], [h1 - 0.05, 1, easeOut], [h1 + 0.1, 0.3], [h1 + 0.8, 0.3, easeInOut], [h1 + 1.0, 1], [d1 + 0.9, 1, easeIn], [d1 + 0.97, 0.1, easeOut], [d1 + 1.06, 1]]),
  });
}

// -- The elephant: walks in from the right and paints both mockups. --
walk({
  cue: 'elephantWalk', walker: 'cast.elephant', from: 620, step: 0.32, lift: 7, stance: 0.5,
  legs: [
    { path: 'cast.elephant.legFar', hip: [1117, 1406], foot: [1112, 1480], phase: 0 },
    { path: 'cast.elephant.legNear', hip: [1139, 1414], foot: [1140, 1489], phase: 0.5 },
  ],
  bob: ['brush', 'antenna', 'armFar', 'body', 'eyeFar', 'eyeNear', 'beret', 'armNear', 'palette'].map((b) => `cast.elephant.${b}Bob`),
});
{
  const [p0, p1] = seconds('paint');
  const cart = section([...DOC.cart].sort((a, b) => a.bb[1] - b.bb[1] || a.bb[0] - b.bb[0]), 'Section_Design_Mockups');
  const pay = section([...DOC.pay].sort((a, b) => a.bb[1] - b.bb[1] || a.bb[0] - b.bb[0]), 'Section_Design_Mockups');
  // A stroke every `STROKE`; each lands one piece at the end of its sweep.
  const pieces = [...cart, ...pay];
  const STROKE = (p1 - p0 - 0.2) / pieces.length;
  pieces.forEach((p, k) => {
    const t = p0 + 0.2 + STROKE * (k + 0.7);
    const big = (p.bb[2] - p.bb[0]) > 150 && (p.bb[3] - p.bb[1]) > 150;
    if (big) popIn(p.name.replace(/^Section_Design_Mockups\./, 'Section_Design_Mockups.'), t, 0.96);
    else place(p.name, t, 4, 0.18);
  });
  const stroke = over('paint', (s) => {
    const k = Math.floor((s - 0.2) / STROKE);
    if (s < 0.2 || k >= pieces.length) return 0;
    const u = ((s - 0.2) % STROKE) / STROKE;
    // Back, then a quick sweep forward, then ease back to the page.
    return u < 0.5 ? 10 * smooth(u / 0.5) : 10 - 20 * smooth((u - 0.5) / 0.25 > 1 ? 1 : (u - 0.5) / 0.25) + (u > 0.75 ? 10 * smooth((u - 0.75) / 0.25) : 0);
  }, 60);
  for (const p of ['armNearBob.armNear', 'brushBob.brush']) {
    P(`cast.elephant.${p}`)
      .animate({ rotate: at([[0, -8], [p0 - 0.3, -8, easeInOut], [p0, 0], [p1, 0, easeInOut], [p1 + 0.4, -14]]) })
      .animate({ rotate: stroke });
  }
  // Two dips into the palette, one per mockup.
  const mid = p0 + (p1 - p0) * (cart.length / pieces.length);
  const dip = at([[0, 0], [p0 - 0.1, 0, easeInOut], [p0 + 0.1, -10, easeInOut], [p0 + 0.35, 0], [mid - 0.2, 0, easeInOut], [mid, -10, easeInOut], [mid + 0.25, 0]]);
  P('cast.elephant.armFarBob.armFar').animate({ rotate: dip });
  P('cast.elephant.paletteBob.palette').animate({ rotate: dip });
  // Eyes on the work.
  const look = at([[0, 0], [p0, 0, easeOut], [p0 + 0.3, -3], [p1, -3, easeInOut], [p1 + 0.4, 0]]);
  for (const e of ['eyeFarBob.eyeFar', 'eyeNearBob.eyeNear']) {
    P(`cast.elephant.${e}`).animate({ x: look }).animate({ scaleY: blinks([p0 + 0.9, p0 + 2.6, p1 + 1.0]) });
  }
  P('cast.elephant.beretBob.beret').animate({ rotate: wobble(3, 11) });
  P('cast.elephant.antennaBob.antenna').animate({ rotate: wobble(6, 19, 0.2) });
}

// -- The alien: marches in and hammers out the code, a line a blow. --
walk({
  cue: 'alienWalk', walker: 'cast.alien', from: -800, step: 0.26, lift: 9, stance: 0.5,
  legs: [
    { path: 'cast.alien.legL', hip: [589, 1980], foot: [590, 2040], phase: 0 },
    { path: 'cast.alien.legR', hip: [646, 1984], foot: [650, 2038], phase: 0.5 },
  ],
  bob: ['armUpBack', 'armUp', 'armDown', 'antL', 'body', 'eyes', 'antR', 'shine', 'hammer', 'mark'].map((b) => `cast.alien.${b}Bob`),
});
{
  const [a0, a1] = seconds('alienWalk');
  const [k0, k1] = seconds('hammer');
  const lines = [...DOC.code].sort((a, b) => a.bb[1] - b.bb[1]);
  // Rows: pieces sharing a line land together.
  const rowsOf: { name: string; bb: Box }[][] = [];
  for (const l of lines) {
    const row = rowsOf.find((r) => Math.abs(r[0].bb[1] - l.bb[1]) < 8);
    if (row) row.push(l); else rowsOf.push([l]);
  }
  const hits = [k0, ...rowsOf.map((_, i) => k0 + ((k1 - k0) * (i + 1)) / (rowsOf.length + 1))];
  for (const h of DOC.codeHead) place(`Section_Code_Block.${h.name}`, k0 - 0.5, 4);
  for (const s of DOC.slab) {
    P(`content.Section_Code_Block.${s.name}`).animate({
      opacity: at([[0, 0], [k0 - 0.12, 0], [k0 - 0.1, 1], [FADE[1], 1], [D, 0]]),
      y: at([[0, -60], [k0 - 0.12, -60, easeIn], [k0, 0, easeOut], [k0 + 0.07, 4, easeInOut], [k0 + 0.2, 0], [FADE[1], 0], [D, -60]]),
    });
  }
  rowsOf.forEach((row, i) => {
    const t = hits[i + 1];
    for (const l of row) {
      P(`content.Section_Code_Block.${l.name}`).animate({
        opacity: at([[0, 0], [t - 0.06, 0], [t - 0.04, 1], [FADE[1], 1], [D, 0]]),
        y: at([[0, -12], [t - 0.06, -12, easeIn], [t, 0, easeOut], [t + 0.05, 2, easeInOut], [t + 0.14, 0], [FADE[1], 0], [D, -12]]),
      });
    }
  });
  // Wind up, strike, recoil — once per blow — then rest the hammer.
  const blows: Key[] = [[0, 0], [k0 - 0.55, 0, easeOut]];
  for (const h of hits) blows.push([h - 0.22, -30, cubicBezier(0.6, 0, 1, 0.5)], [h, 8, easeOut], [h + 0.08, 3, easeInOut]);
  blows.push([k1 + 0.4, -36, easeInOut], [k1 + 0.8, -30]);
  const swingArm = at(blows);
  for (const p of ['armUpBob.armUp', 'armUpBackBob.armUpBack', 'hammerBob.hammer']) P(`cast.alien.${p}`).animate({ rotate: swingArm });
  // A wince on every blow, and blinks between.
  const wince: Key[] = [[0, 1], [a1 + 0.4, 1, easeIn], [a1 + 0.47, 0.1, easeOut], [a1 + 0.56, 1]];
  for (const h of hits) wince.push([h - 0.02, 1, easeOut], [h + 0.05, 0.45, easeIn], [h + 0.2, 1]);
  P('cast.alien.eyesBob.eyes').animate({ scaleY: at(wince) });
  P('cast.alien.armDownBob.armDown').animate({ rotate: at([[0, 0], [a0, 0], [a1, 0, easeInOut], [k0 - 0.3, 6, easeInOut], [k1 + 0.5, 6, easeInOut], [k1 + 0.9, 0]]) });
  P('cast.alien.antLBob.antL').animate({ rotate: wobble(7, 23) });
  P('cast.alien.antRBob.antR').animate({ rotate: wobble(7, 19, 0.5) });
}

export default team;
