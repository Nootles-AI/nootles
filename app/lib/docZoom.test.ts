import { describe, expect, it } from "vitest";
import {
  anchorScroll,
  clampZoom,
  stepZoom,
  wheelPixels,
  wheelZoom,
  zoomFor,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEPS,
} from "./docZoom";

describe("stepZoom", () => {
  it("walks the steps both ways", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1.25, 1)).toBe(1.5);
    expect(stepZoom(2, -1)).toBe(1.75);
    expect(stepZoom(1.25, -1)).toBe(1);
  });

  it("goes strictly past an off-step zoom", () => {
    expect(stepZoom(1.3, 1)).toBe(1.5);
    expect(stepZoom(1.3, -1)).toBe(1.25);
    // A pinch that landed a hair off a step still moves a whole step.
    expect(stepZoom(1.2500000001, 1)).toBe(1.5);
    expect(stepZoom(1.4999999999, -1)).toBe(1.25);
  });

  it("stops at the ends", () => {
    expect(stepZoom(ZOOM_MAX, 1)).toBe(ZOOM_MAX);
    expect(stepZoom(ZOOM_MIN, -1)).toBe(ZOOM_MIN);
  });

  it("steps are within the clamp", () => {
    for (const s of ZOOM_STEPS) expect(clampZoom(s)).toBe(s);
  });
});

describe("clampZoom", () => {
  it("holds [1, 2] and refuses junk", () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(3)).toBe(2);
    expect(clampZoom(1.6)).toBe(1.6);
    expect(clampZoom(NaN)).toBe(1);
  });
});

describe("wheel", () => {
  it("normalises deltaMode to pixels", () => {
    expect(wheelPixels(3, 0, 800)).toBe(3);
    expect(wheelPixels(3, 1, 800)).toBe(48);
    expect(wheelPixels(1, 2, 800)).toBe(800);
  });

  it("zooms in on a negative delta and out on a positive one", () => {
    expect(wheelZoom(1.5, -10, 0, 800)).toBeGreaterThan(1.5);
    expect(wheelZoom(1.5, 10, 0, 800)).toBeLessThan(1.5);
  });

  it("clamps each event, so one mouse notch is not a leap", () => {
    const notch = wheelZoom(1, -120, 0, 800);
    expect(notch).toBe(wheelZoom(1, -1000, 0, 800));
    expect(notch).toBeLessThan(1.5);
    expect(wheelZoom(1, -1, 2, 800)).toBe(notch);
  });

  it("is a ratio: the same pinch zooms the same wherever it starts", () => {
    expect(wheelZoom(1.2, -5, 0, 800) / 1.2).toBeCloseTo(wheelZoom(1.6, -5, 0, 800) / 1.6, 10);
  });

  it("never leaves the clamp", () => {
    expect(wheelZoom(2, -30, 0, 800)).toBe(2);
    expect(wheelZoom(1, 30, 0, 800)).toBe(1);
  });
});

describe("anchorScroll", () => {
  /** Where on screen the logical point `p` of the sheet lands. */
  const screen = (origin: number, scroll: number, z: number, p: number) => origin - scroll + p * z;

  it("keeps the point under the anchor still", () => {
    // Sheet at client 100 when unscrolled, scrolled 40, zoom 1 → 1.5, anchor at 300.
    const scroll = anchorScroll(100, 100, 40, 1, 1.5, 300);
    const logical = (300 - (100 - 40)) / 1;
    expect(screen(100, scroll, 1.5, logical)).toBeCloseTo(300, 10);
  });

  it("round-trips: in and back out returns the offset", () => {
    const inward = anchorScroll(0, 0, 120, 1, 2, 250);
    expect(anchorScroll(0, 0, inward, 2, 1, 250)).toBeCloseTo(120, 10);
  });

  it("follows the sheet when the write moved it", () => {
    // The browser clamped scroll, so the sheet's unscrolled edge read differently after.
    const scroll = anchorScroll(100, 90, 0, 2, 1, 400);
    const logical = (400 - 100) / 2;
    expect(screen(90, scroll, 1, logical)).toBeCloseTo(400, 10);
  });

  it("zooming at the sheet's own edge scrolls nothing", () => {
    expect(anchorScroll(50, 50, 0, 1, 2, 50)).toBe(0);
  });
});

describe("zoomFor", () => {
  it("is one store per pane", () => {
    expect(zoomFor("main")).toBe(zoomFor("main"));
    expect(zoomFor("main")).not.toBe(zoomFor("aside"));
  });

  it("does nothing until attached", () => {
    const store = zoomFor("aside");
    let heard = 0;
    const off = store.subscribe(() => heard++);
    store.set(1.5);
    expect(store.get()).toBe(1);
    store.reset();
    expect(heard).toBe(0);
    off();
  });
});
