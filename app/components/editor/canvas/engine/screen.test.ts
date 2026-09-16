import { describe, expect, it, vi } from "vitest";
import {
  createScreenControl,
  recentre,
  reduceScreen,
  SCREEN_OFF,
  type ScreenHost,
  type ScreenState,
} from "./screen";

function fakeHost(over: Partial<ScreenHost> = {}): ScreenHost & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    enabled: true,
    applyStage: vi.fn((on: boolean) => calls.push(`applyStage:${on}`)),
    canFullscreen: () => true,
    requestFullscreen: vi.fn(async () => {
      calls.push("requestFullscreen");
    }),
    exitFullscreen: vi.fn(async () => {
      calls.push("exitFullscreen");
    }),
    ...over,
  };
}

describe("reduceScreen", () => {
  it("fullscreen on forces stage on", () => {
    const next = reduceScreen(SCREEN_OFF, { fullscreen: true });
    expect(next).toEqual({ stage: true, minimal: false, fullscreen: true });
  });

  it("stage off forces fullscreen off", () => {
    const prev: ScreenState = { stage: true, minimal: false, fullscreen: true };
    const next = reduceScreen(prev, { stage: false });
    expect(next).toEqual({ stage: false, minimal: false, fullscreen: false });
  });

  it("stage off beats fullscreen on in one patch", () => {
    const next = reduceScreen(SCREEN_OFF, { stage: false, fullscreen: true });
    expect(next).toEqual({ stage: false, minimal: false, fullscreen: false });
  });

  it("minimal is independent of stage and fullscreen", () => {
    const prev: ScreenState = { stage: true, minimal: false, fullscreen: true };
    const next = reduceScreen(prev, { minimal: true });
    expect(next).toEqual({ stage: true, minimal: true, fullscreen: true });
  });

  it("unchanged patch returns prev by identity", () => {
    const prev: ScreenState = { stage: true, minimal: false, fullscreen: false };
    expect(reduceScreen(prev, { stage: true })).toBe(prev);
    expect(reduceScreen(prev, {})).toBe(prev);
  });
});

describe("recentre", () => {
  it("the scene point under the old centre is under the new centre", () => {
    const vp = { x: -40, y: 10, zoom: 2 };
    const before = { w: 800, h: 600 };
    const after = { w: 1280, h: 900 };
    const sceneAtOldCentre = {
      x: (before.w / 2 - vp.x) / vp.zoom,
      y: (before.h / 2 - vp.y) / vp.zoom,
    };
    const next = recentre(vp, before, after);
    const sceneAtNewCentre = {
      x: (after.w / 2 - next.x) / next.zoom,
      y: (after.h / 2 - next.y) / next.zoom,
    };
    expect(sceneAtNewCentre.x).toBeCloseTo(sceneAtOldCentre.x, 9);
    expect(sceneAtNewCentre.y).toBeCloseTo(sceneAtOldCentre.y, 9);
  });

  it("keeps zoom", () => {
    const vp = { x: 5, y: -5, zoom: 1.5 };
    const next = recentre(vp, { w: 800, h: 600 }, { w: 400, h: 300 });
    expect(next.zoom).toBe(1.5);
  });

  it("round trip lands on the original viewport within 1e-9", () => {
    const vp = { x: 12.5, y: -33.25, zoom: 0.8 };
    const before = { w: 800, h: 600 };
    const after = { w: 1920, h: 1080 };
    const there = recentre(vp, before, after);
    const back = recentre(there, after, before);
    expect(Math.abs(back.x - vp.x)).toBeLessThan(1e-9);
    expect(Math.abs(back.y - vp.y)).toBeLessThan(1e-9);
    expect(back.zoom).toBe(vp.zoom);
  });

  it("a zero-sized before or after returns vp unchanged", () => {
    const vp = { x: 1, y: 2, zoom: 3 };
    expect(recentre(vp, { w: 0, h: 600 }, { w: 800, h: 600 })).toBe(vp);
    expect(recentre(vp, { w: 800, h: 600 }, { w: 800, h: 0 })).toBe(vp);
  });
});

describe("createScreenControl", () => {
  it("disabled host ignores set and reports canFullscreen false", () => {
    const host = fakeHost({ enabled: false });
    const control = createScreenControl(host);
    control.set({ stage: true });
    expect(control.get()).toBe(SCREEN_OFF);
    expect(control.canFullscreen()).toBe(false);
    expect(host.applyStage).not.toHaveBeenCalled();
  });

  it("set stage calls applyStage once and notifies once", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    const listener = vi.fn();
    control.subscribe(listener);
    control.set({ stage: true });
    expect(host.applyStage).toHaveBeenCalledTimes(1);
    expect(host.applyStage).toHaveBeenCalledWith(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(control.get().stage).toBe(true);
  });

  it("set fullscreen applies stage then requests, in that order", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    control.set({ fullscreen: true });
    expect(host.calls).toEqual(["applyStage:true", "requestFullscreen"]);
    expect(control.get()).toEqual({ stage: true, minimal: false, fullscreen: true });
  });

  it("a rejected request syncs fullscreen off, stage stays", async () => {
    const host = fakeHost({
      requestFullscreen: vi.fn(async () => {
        throw new Error("no user activation");
      }),
    });
    const control = createScreenControl(host);
    control.set({ fullscreen: true });
    expect(control.get().fullscreen).toBe(true);
    // The rejection settles on a later microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(control.get()).toEqual({ stage: true, minimal: false, fullscreen: false });
  });

  it("stage off while fullscreen calls exitFullscreen", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    control.set({ fullscreen: true });
    control.set({ stage: false });
    expect(host.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(control.get()).toEqual({ stage: false, minimal: false, fullscreen: false });
  });

  it("sync never calls request or exit", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    control.set({ stage: true });
    control.sync({ fullscreen: true });
    expect(host.requestFullscreen).not.toHaveBeenCalled();
    expect(control.get().fullscreen).toBe(true);
    control.sync({ fullscreen: false });
    expect(host.exitFullscreen).not.toHaveBeenCalled();
    expect(control.get().fullscreen).toBe(false);
  });

  it("toggle flips; reset clears stage and minimal", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    control.toggle("minimal");
    expect(control.get().minimal).toBe(true);
    control.toggle("minimal");
    expect(control.get().minimal).toBe(false);
    control.set({ stage: true, minimal: true });
    control.reset();
    expect(control.get()).toEqual({ stage: false, minimal: false, fullscreen: false });
  });

  it("no notification when the reducer returns prev", () => {
    const host = fakeHost();
    const control = createScreenControl(host);
    const listener = vi.fn();
    control.subscribe(listener);
    control.set({ stage: false });
    expect(listener).not.toHaveBeenCalled();
    expect(host.applyStage).not.toHaveBeenCalled();
  });
});
