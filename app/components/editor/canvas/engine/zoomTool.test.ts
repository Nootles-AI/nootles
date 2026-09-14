import { describe, expect, it } from "vitest";
import { ZOOM_DRAG_MIN, ZOOM_TOOL_FACTOR, zoomToolResult } from "./zoomTool";

describe("zoomToolResult", () => {
  it("click zooms by the factor about the press", () => {
    const down = { x: 100, y: 100 };
    const result = zoomToolResult({
      down,
      up: { x: 101, y: 100 },
      fromScene: { x: 40, y: 40 },
      toScene: { x: 40.4, y: 40 },
      alt: false,
    });
    expect(result).toEqual({ kind: "by", factor: ZOOM_TOOL_FACTOR, anchor: down });
  });

  it("alt click zooms by the inverse", () => {
    const down = { x: 100, y: 100 };
    const result = zoomToolResult({
      down,
      up: { x: 100, y: 100 },
      fromScene: { x: 40, y: 40 },
      toScene: { x: 40, y: 40 },
      alt: true,
    });
    expect(result).toEqual({ kind: "by", factor: 1 / ZOOM_TOOL_FACTOR, anchor: down });
  });

  it("travel under ZOOM_DRAG_MIN is a click", () => {
    const down = { x: 0, y: 0 };
    const up = { x: ZOOM_DRAG_MIN - 0.5, y: 0 };
    const result = zoomToolResult({
      down,
      up,
      fromScene: down,
      toScene: { x: 10, y: 10 },
      alt: false,
    });
    expect(result.kind).toBe("by");
  });

  it("a drag is the normalised scene rect", () => {
    const result = zoomToolResult({
      down: { x: 0, y: 0 },
      up: { x: 200, y: 100 },
      fromScene: { x: 50, y: 30 },
      toScene: { x: -50, y: 130 },
      alt: false,
    });
    expect(result).toEqual({ kind: "fit", rect: { x: -50, y: 30, w: 100, h: 100 } });
  });

  it("a sub-pixel rect is none", () => {
    const result = zoomToolResult({
      down: { x: 0, y: 0 },
      up: { x: 200, y: 100 },
      fromScene: { x: 10, y: 10 },
      toScene: { x: 10.5, y: 10.5 },
      alt: false,
    });
    expect(result).toEqual({ kind: "none" });
  });
});
