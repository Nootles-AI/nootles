import { describe, expect, it } from "vitest";

import { nodeBounds } from "../scene/geometry";
import { applyOps } from "../scene/ops";
import type { Point, Rect, Scene, SceneNode, SceneOp } from "../scene/types";
import {
  applyDecision,
  capScale,
  convertDecision,
  createGestureSession,
  decideGesture,
  intersectAllowed,
  liveBottomOf,
  liveBoxes,
  moveAllowed,
  pushEdge,
  scaleAllowed,
  settleWiden,
  WIDEN_PUSH,
  type BandRange,
  type GestureSession,
  type PointerLike,
  type SessionOverrides,
  type TransformGestureOptions,
} from "./gestures";

const rect = (id: string, x: number, y: number, w: number, h: number, rot = 0): SceneNode =>
  ({
    id,
    kind: "rect",
    x,
    y,
    w,
    h,
    rot,
    style: {},
    label: "",
    locked: false,
    hidden: false,
    attrs: {},
  }) as SceneNode;

const sceneOf = (nodes: SceneNode[]): Scene => ({ w: 0, h: 600, style: {}, nodes, edges: [], attrs: {} });

const COLUMN: BandRange = { minX: 0, maxX: 720 };

/**
 * A diagram whose scene sits at `offset` on screen, drawn at `scale` screen
 * px per scene px, with no elements to write to — the maths, not the pixels.
 */
function diagram(nodes: SceneNode[], { offset = { x: 0, y: 0 }, scale = 1, band = COLUMN as BandRange | null } = {}) {
  const scene = sceneOf(nodes);
  const landed: SceneOp[][] = [];
  const o: TransformGestureOptions = {
    store: {
      getScene: () => scene,
      begin: () => {},
      commit: () => {},
      abort: () => {},
      dispatch: (ops) => void landed.push(ops),
    },
    clientToScene: (p) => ({ x: (p.x - offset.x) / scale, y: (p.y - offset.y) / scale }),
    screenScale: () => scale,
    band: () => band,
    getSelection: () => nodes.map((n) => n.id),
    getElement: () => null,
  };
  const toClient = (p: Point): Point => ({ x: p.x * scale + offset.x, y: p.y * scale + offset.y });
  const toScene = o.clientToScene;
  return { o, toClient, toScene, landed, scale };
}

const press = (x = 0, y = 0): PointerLike => ({
  clientX: x,
  clientY: y,
  pointerId: 1,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ctrlKey: false,
  preventDefault: () => {},
});

function session(
  d: ReturnType<typeof diagram>,
  mode: "move" | "resize" | "scale" | "rotate",
  handle: "se" | "e" | null = null,
  overrides?: SessionOverrides,
): GestureSession {
  const s = createGestureSession(d.o, press(), mode, handle, overrides);
  if (!s) throw new Error("no session");
  return s;
}

/** A box in one diagram's px, as the screen has it. */
const onScreen = (d: ReturnType<typeof diagram>, r: Rect): Rect => {
  const a = d.toClient({ x: r.x, y: r.y });
  const b = d.toClient({ x: r.x + r.w, y: r.y + r.h });
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
};

describe("how far a move may go", () => {
  it("to the band's edges and no higher than its top", () => {
    expect(moveAllowed(COLUMN, { x: 100, y: 30, w: 200, h: 50 })).toEqual({ minDx: -100, maxDx: 420, minDy: -30 });
  });

  it("no further out than it began, for a box already past an edge", () => {
    expect(moveAllowed(COLUMN, { x: -50, y: -10, w: 100, h: 50 })).toEqual({ minDx: 0, maxDx: 670, minDy: 0 });
  });

  it("anywhere, in a frame", () => {
    expect(moveAllowed(null, { x: 0, y: 0, w: 10, h: 10 })).toBeNull();
  });

  it("across several diagrams, as far as the tightest lets it", () => {
    const a = { minDx: -100, maxDx: 420, minDy: -30 };
    const b = { minDx: -40, maxDx: 600, minDy: -80 };
    expect(intersectAllowed(a, b)).toEqual({ minDx: -40, maxDx: 420, minDy: -30 });
    expect(intersectAllowed(null, b)).toBe(b);
    expect(scaleAllowed(b, 0.5)).toEqual({ minDx: -20, maxDx: 300, minDy: -40 });
  });
});

describe("a decision in another diagram's px", () => {
  it("carries lengths through the screen", () => {
    expect(convertDecision({ kind: "move", dx: 40, dy: 10 }, 1, 2)).toEqual({ kind: "move", dx: 20, dy: 5 });
    expect(convertDecision({ kind: "resize", dx: 30, dy: 6 }, 2, 1)).toEqual({ kind: "resize", dx: 60, dy: 12 });
  });

  it("leaves a factor and an angle as they are", () => {
    const scale = { kind: "scale", k: 1.4 } as const;
    const rotate = { kind: "rotate", deg: 15 } as const;
    expect(convertDecision(scale, 1, 2)).toBe(scale);
    expect(convertDecision(rotate, 1, 2)).toBe(rotate);
  });
});

describe("the lowest a gesture reaches", () => {
  it("counts a rotated box by its corners", () => {
    const f = { sx: 0, sy: 0, sw: 100, sh: 100, srot: 45 };
    const b = nodeBounds({ x: 0, y: 0, w: 100, h: 100, rot: 45 });
    expect(liveBottomOf([f])).toBeCloseTo(b.y + b.h);
    expect(liveBottomOf([])).toBe(-Infinity);
  });
});

describe("one gesture over two diagrams", () => {
  // `a` above, at 1:1; `b` 500px down the page and drawn at twice the scale.
  const setup = () => {
    const a = diagram([rect("a1", 100, 100, 100, 50)]);
    const b = diagram([rect("b1", 50, 20, 50, 25)], { offset: { x: 0, y: 500 }, scale: 2 });
    // The page's frame, in each one's px: a1 is client 100..200 × 100..150,
    // b1 is client 100..200 × 540..590.
    const union = { x: 100, y: 100, w: 100, h: 490 };
    const inB = { x: 50, y: -200, w: 50, h: 245 };
    return { a, b, union, inB };
  };

  it("a follower moves by the lead's decision and keeps its place beside it", () => {
    const { a, b, union, inB } = setup();
    const lead = session(a, "move", null, { bounds: union, sole: false, lockstep: true });
    const follower = session(b, "move", null, { bounds: inB, sole: false, lockstep: true });
    const decision = { kind: "move", dx: 40, dy: 10 } as const;
    applyDecision(lead, decision, 1);
    applyDecision(follower, convertDecision(decision, a.scale, b.scale), 1);
    const [boxA] = liveBoxes(lead);
    const [boxB] = liveBoxes(follower);
    const screenA = onScreen(a, boxA);
    const screenB = onScreen(b, boxB);
    expect(screenA.x).toBeCloseTo(140);
    expect(screenB.x).toBeCloseTo(screenA.x);
    expect(screenB.y - screenA.y).toBeCloseTo(440);
  });

  it("a resize about the page's frame stretches every diagram by the same factors", () => {
    const { a, b, union, inB } = setup();
    const lead = session(a, "resize", "se", { bounds: union, sole: false, lockstep: true });
    const follower = session(b, "resize", "se", { bounds: inB, sole: false, lockstep: true });
    const decision = { kind: "resize", dx: 50, dy: 49 } as const;
    expect(applyDecision(lead, decision, 1)).toBe(true);
    expect(applyDecision(follower, convertDecision(decision, a.scale, b.scale), 1)).toBe(true);
    const [boxA] = liveBoxes(lead);
    const [boxB] = liveBoxes(follower);
    expect(boxA.w / 100).toBeCloseTo(1.5);
    expect(boxB.w / 50).toBeCloseTo(1.5);
    expect(boxA.h / 50).toBeCloseTo(boxB.h / 25);
    // The frame's bottom edge followed the handle, in both.
    const screenB = onScreen(b, boxB);
    expect(screenB.y + screenB.h).toBeCloseTo(590 + 49);
    expect(onScreen(a, boxA).x).toBeCloseTo(screenB.x);
  });

  it("a scale is held by the band with the least room", () => {
    const { a, union } = setup();
    const near = diagram([rect("c1", 600, 20, 100, 25)]);
    const lead = session(a, "scale", "e", { bounds: union, sole: false, lockstep: true });
    const tight = session(near, "scale", "e", {
      bounds: { x: 600, y: 20, w: 100, h: 25 },
      sole: false,
      lockstep: true,
    });
    const k = capScale(tight, capScale(lead, 3));
    expect(k).toBeCloseTo(1.2);
  });
});

describe("one diagram's gesture, held in its band", () => {
  it("clamps a move exactly at the edge", () => {
    const d = diagram([rect("n", 600, 100, 100, 50)]);
    const s = session(d, "move");
    const { decision } = decideGesture(s, d.o, { x: 80, y: -200 });
    expect(decision).toEqual({ kind: "move", dx: 20, dy: -100 });
  });

  it("refuses a rotation that would swing a corner past the edge", () => {
    const d = diagram([rect("n", 610, 100, 100, 100)]);
    const s = session(d, "rotate");
    expect(applyDecision(s, { kind: "rotate", deg: 45 }, 1)).toBe(false);
    expect(applyDecision(s, { kind: "rotate", deg: 0 }, 1)).toBe(true);
  });

  it("refuses a lockstep resize past the edge rather than clamping it", () => {
    const d = diagram([rect("n", 600, 100, 100, 50)]);
    const s = session(d, "resize", "e", { lockstep: true });
    const { decision } = decideGesture(s, d.o, { x: 60, y: 0 });
    expect(decision).toEqual({ kind: "resize", dx: 60, dy: 0 });
    expect(applyDecision(s, decision, 1)).toBe(false);
  });

  it("clamps a resize of its own exactly", () => {
    const d = diagram([rect("n", 600, 100, 100, 50)]);
    const s = session(d, "resize", "e");
    expect(decideGesture(s, d.o, { x: 60, y: 0 }).decision).toEqual({ kind: "resize", dx: 20, dy: 0 });
  });
});

describe("a column band's side, pushed", () => {
  /** A column band whose store applies what it is given, and says what it was asked. */
  const pushable = () => {
    let scene = sceneOf([rect("a", 600, 40, 100, 50)]);
    let bracket: Scene | null = null;
    const calls: string[] = [];
    const o: TransformGestureOptions = {
      store: {
        getScene: () => scene,
        begin: () => {
          bracket = scene;
          calls.push("begin");
        },
        commit: () => void calls.push("commit"),
        abort: () => {
          if (bracket) scene = bracket;
          calls.push("abort");
        },
        dispatch: (ops) => {
          scene = applyOps(scene, ops);
          calls.push(ops.map((op) => op.type).join("+"));
        },
      },
      clientToScene: (p) => p,
      screenScale: () => 1,
      band: () => ({ minX: 0, maxX: 720 }),
      widen: () => {
        o.store.dispatch([{ type: "setDiagram", wide: true }]);
        return { minX: -240, maxX: 960 };
      },
      pushing: (held) => void calls.push(held ? "held" : "free"),
      getSelection: () => ["a"],
      getElement: () => null,
    };
    const s = createGestureSession(o, press(650, 60), "move", null)!;
    const to = (x: number) => decideGesture(s, o, { x, y: 60 }).decision;
    return { o, s, to, calls, scene: () => scene };
  };

  it("holds at the side, and says so while the pointer goes on past it", () => {
    const { o, s, to, calls } = pushable();
    expect(to(660)).toEqual({ kind: "move", dx: 10, dy: 0 });
    expect(pushEdge(s, o)).toBe(false);
    expect(to(700)).toEqual({ kind: "move", dx: 20, dy: 0 });
    expect(s.push).toBe(30);
    expect(pushEdge(s, o)).toBe(false);
    expect(calls).toEqual(["free", "held"]);
  });

  it("turns the band wide past the push, and the drag goes on into the margin", () => {
    const { o, s, to, calls, scene } = pushable();
    to(670 + WIDEN_PUSH + 1);
    expect(pushEdge(s, o)).toBe(true);
    expect(scene().wide).toBe(true);
    expect(calls).toEqual(["free", "begin", "setDiagram"]);
    expect(to(800)).toEqual({ kind: "move", dx: 150, dy: 0 });
  });

  it("stays wide on a drop past the column, as one step with the move", () => {
    const { o, s, to, calls, scene } = pushable();
    to(800);
    pushEdge(s, o);
    o.store.dispatch([{ type: "move", ids: ["a"], dx: 150, dy: 0 }]);
    settleWiden(s, o, { cancelled: false, landed: true });
    expect(scene().wide).toBe(true);
    expect(calls.slice(-2)).toEqual(["move", "commit"]);
  });

  it("folds back on a drop inside the column: it was only wide for the drag", () => {
    const { o, s, to, calls, scene } = pushable();
    to(800);
    pushEdge(s, o);
    o.store.dispatch([{ type: "move", ids: ["a"], dx: -100, dy: 0 }]);
    settleWiden(s, o, { cancelled: false, landed: true });
    expect(scene().wide).toBeUndefined();
    expect(calls.slice(-3)).toEqual(["move", "setDiagram", "commit"]);
  });

  it("takes the widening back with a cancel, or when nothing landed inside the column", () => {
    const cancelled = pushable();
    cancelled.to(800);
    pushEdge(cancelled.s, cancelled.o);
    settleWiden(cancelled.s, cancelled.o, { cancelled: true, landed: false });
    expect([cancelled.scene().wide, cancelled.calls.at(-1)]).toEqual([undefined, "abort"]);

    const still = pushable();
    still.to(800);
    pushEdge(still.s, still.o);
    settleWiden(still.s, still.o, { cancelled: false, landed: false });
    expect([still.scene().wide, still.calls.at(-1)]).toEqual([undefined, "abort"]);
  });

  it("never for a band with no way wider", () => {
    const { o, s, to, calls } = pushable();
    delete o.widen;
    to(900);
    expect(pushEdge(s, o)).toBe(false);
    expect(calls).toEqual([]);
  });
});
