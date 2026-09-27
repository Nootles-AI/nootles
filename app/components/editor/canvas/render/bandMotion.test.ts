import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BAND_GLIDE,
  bandGlide,
  glideBandHeight,
  glideBandWidth,
  holdBandStill,
  stopBandGlide,
  toMs,
} from "./bandMotion";

type Fake = HTMLElement & { animate: ReturnType<typeof vi.fn> };

let reduced = false;
let press: (() => void) | null = null;

function animation() {
  return { cancel: vi.fn(), finished: new Promise<never>(() => {}) };
}

/** A band `top` px down the screen, `offset` px tall as laid out, drawn at `k`. */
function band(top = 100, offset = 200, k = 1): Fake {
  return {
    offsetHeight: offset,
    style: { backgroundPositionX: "" },
    getBoundingClientRect: () => ({ top, height: offset * k }),
    animate: vi.fn(() => animation()),
  } as unknown as Fake;
}

beforeEach(() => {
  reduced = false;
  press = null;
  vi.stubGlobal("window", { innerHeight: 800 });
  vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => ({ "--ease": "cubic-bezier(0.25, 1, 0.5, 1)", "--dur-slow": "270ms" })[name] ?? "",
  }));
  vi.stubGlobal("document", {
    documentElement: {},
    addEventListener: (type: string, fn: () => void) => {
      if (type === "pointerdown") press = fn;
    },
    removeEventListener: (type: string) => {
      if (type === "pointerdown") press = null;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toMs", () => {
  it("reads a CSS time either way it is written", () => {
    expect(toMs("270ms")).toBe(270);
    expect(toMs("0.145s")).toBeCloseTo(145);
    expect(toMs("")).toBe(0);
  });
});

describe("glideBandHeight", () => {
  it("glides from what showed to the committed height, on the tokens", () => {
    const el = band();
    glideBandHeight(el, 120, 200);
    expect(el.animate).toHaveBeenCalledWith([{ height: "120px" }, { height: "200px" }], {
      id: BAND_GLIDE,
      duration: 270,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    });
    expect(bandGlide(el)).toBeDefined();
    stopBandGlide(el);
  });

  it("takes a glide under way over from where it has got to", () => {
    const el = band(100, 150);
    glideBandHeight(el, 100, 200);
    const first = bandGlide(el)!;
    glideBandHeight(el, 200, 300);
    expect(first.cancel).toHaveBeenCalled();
    expect(el.animate).toHaveBeenLastCalledWith([{ height: "150px" }, { height: "300px" }], expect.anything());
    stopBandGlide(el);
  });

  it("stops for any press, before the press is handled", () => {
    const el = band();
    glideBandHeight(el, 100, 200);
    const glide = bandGlide(el)!;
    expect(press).not.toBeNull();
    press!();
    expect(glide.cancel).toHaveBeenCalled();
    expect(bandGlide(el)).toBeUndefined();
    expect(press).toBeNull();
  });

  it("is instant under reduced motion", () => {
    reduced = true;
    const el = band();
    glideBandHeight(el, 100, 200);
    expect(el.animate).not.toHaveBeenCalled();
  });

  it("leaves a band nobody can see where it lands", () => {
    const below = band(900);
    glideBandHeight(below, 100, 200);
    expect(below.animate).not.toHaveBeenCalled();
    const above = band(-500, 200, 2);
    glideBandHeight(above, 100, 200);
    expect(above.animate).not.toHaveBeenCalled();
    const peeking = band(-300, 200, 2);
    glideBandHeight(peeking, 100, 200);
    expect(peeking.animate).toHaveBeenCalled();
    stopBandGlide(peeking);
  });

  it("lands a height held still as it is, once", () => {
    const el = band();
    holdBandStill(el);
    glideBandHeight(el, 100, 200);
    expect(el.animate).not.toHaveBeenCalled();
    glideBandHeight(el, 200, 100);
    expect(el.animate).toHaveBeenCalledTimes(1);
    stopBandGlide(el);
  });
});

describe("glideBandWidth", () => {
  const phase = (frame: { left: string; backgroundPositionX: string }) =>
    parseFloat(frame.left) + parseFloat(frame.backgroundPositionX);

  it("wipes the grid out into the margins with every dot where it was", () => {
    const grid = band();
    grid.style.backgroundPositionX = "240px";
    glideBandWidth(grid, 240, true);
    const [[from, to]] = grid.animate.mock.calls[0] as [[{ left: string; backgroundPositionX: string }, { left: string; backgroundPositionX: string }]];
    expect(from.left).toBe("240px");
    expect(to.left).toBe("0px");
    expect(phase(from)).toBe(phase(to));
  });

  it("and back in from them", () => {
    const grid = band();
    glideBandWidth(grid, 240, false);
    const [[from, to]] = grid.animate.mock.calls[0] as [[{ left: string; backgroundPositionX: string }, { left: string; backgroundPositionX: string }]];
    expect(from.left).toBe("-240px");
    expect(phase(from)).toBe(phase(to));
  });

  it("is instant under reduced motion", () => {
    reduced = true;
    const grid = band();
    glideBandWidth(grid, 240, true);
    expect(grid.animate).not.toHaveBeenCalled();
  });
});
